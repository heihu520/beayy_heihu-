#!/usr/bin/env python3
"""Beayy 服务端：同步服务（syncapi.py）＋转写和地图（这里）。客户端「设置 → 连接」里的同步服务器、转写服务器可以填同一个地址。
转写不在这里跑模型，交给 worker.py（另一个进程，可以不起；不起的话交上来的转写一直排队）。
转写服务：电脑、手机都用同步服务发的票据（Authorization: Ticket …）认账号，
每个账号的任务放在 jobs/<账号>/，互相看不到；音频转完就删，结果取走就删。
  POST   /v2/jobs              交一段转写：{meta, audio(base64 m4a), self, self_name, others}
  GET    /v2/jobs/{job}        状态和结果
  DELETE /v2/jobs/{job}        取走后删
  POST   /v2/voiceprint        {audio} → 本人声纹（50 秒内算完直接返回，否则 202 {job} 再轮询）
  GET    /v2/usage             这个账号排队、在转的任务和占的字节
  GET    /v2/amap/{path}       官方地图：地名、附近的店、搜地点、静态图，用服务器的高德 Key（票据要是地图的，同步服务按地图额度发）
  GET    /_AMapService/{票据}/…  能缩放的地图的安全密钥中转（高德官方写法），补上 jscode
  GET    /v2/health            不鉴权
同步服务的接口见 syncapi.py。部署见 README.md：默认监听 8770，对外由 Caddy、Cloudflare 隧道这类反向代理加 HTTPS。
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
import urllib.error
import urllib.parse
import urllib.request

from fastapi.responses import JSONResponse, Response

import syncapi
from usage import Counter

JOBS = Path(os.environ.get("BEAYY_JOBS_DIR", "data/jobs"))
TICKET_SECRET = syncapi.TICKET_SECRET
MAX_BYTES = 60 * 1024 * 1024  # 10 分钟 32kbps 约 2.4MB，留足余量
SEG_ID = re.compile(r"^[A-Za-z0-9._-]{8,96}$")
DEVICE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(syncapi.router)


@app.on_event("startup")
def startup():
    syncapi.startup()


def parse_ts(v: str | None, name: str) -> str:
    try:
        return datetime.fromisoformat((v or "").replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        raise HTTPException(400, f"bad {name}")


# ---------- v2：转写服务 ----------

USER = re.compile(r"^[0-9a-f]{24}$")
JOB = re.compile(r"^[0-9a-f]{16}$")
MAX_QUEUED = 300  # 一个账号最多同时排这么多段
MAX_JSON = 90 * 1024 * 1024  # base64 后的音频


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def ticket_user(authorization: str | None, kind: str = "asr") -> str:
    """Ticket <base64url(JSON {u, exp}).base64url(HMAC-SHA256)> → 账号；票据由同步服务（/v2/ticket）用同一个密钥签"""
    if not TICKET_SECRET or not authorization or not authorization.startswith("Ticket "):
        raise HTTPException(401, "要先登录账号")
    payload, _, sig = authorization[7:].strip().partition(".")
    want = b64url(hmac.new(TICKET_SECRET.encode(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, want):
        raise HTTPException(401, "票据不对")
    try:
        d = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        user, exp = str(d["u"]), float(d["exp"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, "票据坏了")
    if exp < time.time():
        raise HTTPException(401, "票据过期了")
    if not USER.match(user):
        raise HTTPException(401, "票据坏了")
    if (d.get("k") or "asr") != kind:
        raise HTTPException(401, "票据不是给这项服务的")
    return user


def check_ticket(t: str, kind: str) -> str:
    """路径里带的票据（能缩放的地图中转）"""
    return ticket_user(f"Ticket {t}", kind)


def job_files(user: str, job: str):
    d = JOBS / user
    return d / f"{job}.json", d / f"{job}.m4a", d / f"{job}.result.json"


def all_jobs():
    for p in JOBS.glob("*/*.json"):
        if p.name.endswith(".result.json") or p.name.startswith("."):
            continue
        try:
            yield p, json.loads(p.read_text())
        except (OSError, ValueError):
            continue


def write_json(p: Path, d: dict):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name("." + p.name)
    tmp.write_text(json.dumps(d, ensure_ascii=False))
    os.replace(tmp, p)


async def read_body(request: Request) -> dict:
    if int(request.headers.get("content-length") or 0) > MAX_JSON:
        raise HTTPException(413, "太大了")
    try:
        return await request.json()
    except ValueError:
        raise HTTPException(400, "不是 JSON")


def new_job(user: str, kind: str, audio_b64: str, **fields) -> str:
    try:
        audio = base64.b64decode(audio_b64, validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "音频不是 base64")
    if not audio or len(audio) > MAX_BYTES:
        raise HTTPException(400, "音频是空的或太大")
    queued = sum(1 for p, j in all_jobs() if p.parent.name == user and j.get("status") in ("queued", "running"))
    if queued >= MAX_QUEUED:
        raise HTTPException(429, "排队的太多了，稍后再交")
    job = secrets.token_hex(8)
    meta_p, audio_p, _ = job_files(user, job)
    audio_p.parent.mkdir(parents=True, exist_ok=True)
    audio_p.write_bytes(audio)
    # json 落地才算入队，worker.py 只认有 json 的任务
    write_json(meta_p, {"id": job, "kind": kind, "status": "queued", "created": time.time(), **fields})
    return job


@app.get("/v2/health")
def health2():
    return {"ok": True}


@app.post("/v2/jobs")
async def post_job(request: Request, authorization: str | None = Header(None)):
    user = ticket_user(authorization)
    b = await read_body(request)
    meta = b.get("meta") or {}
    if not SEG_ID.match(str(meta.get("id") or "")) or not DEVICE.match(str(meta.get("device") or "")):
        raise HTTPException(400, "段 id 或设备名不对")
    meta = {"id": meta["id"], "device": meta["device"], "start": parse_ts(meta.get("start"), "start"), "end": parse_ts(meta.get("end"), "end"),
            "battery": meta.get("battery") if isinstance(meta.get("battery"), (int, float)) else None}
    me = b.get("self")
    if me is not None and (not isinstance(me, str) or len(me) > 8192):
        raise HTTPException(400, "声纹不对")
    others = b.get("others") or []
    if not isinstance(others, list) or len(others) > 200:
        raise HTTPException(400, "他人质心不对")
    try:
        others = [{"label": str(o["label"])[:20], "centroid": [float(x) for x in o["centroid"]][:1024], "n": int(o.get("n") or 1)} for o in others]
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "他人质心不对")
    job = new_job(user, "transcribe", b.get("audio") or "", meta=meta, self=me, others=others,
                  self_name=str(b.get("self_name") or "我")[:20])
    return {"job": job}


@app.get("/v2/jobs/{job}")
def get_job(job: str, authorization: str | None = Header(None)):
    user = ticket_user(authorization)
    if not JOB.match(job):
        raise HTTPException(400, "任务号不对")
    meta_p, _, result_p = job_files(user, job)
    if not meta_p.exists():
        raise HTTPException(404, "没有这个任务（可能已取走或过期）")
    j = json.loads(meta_p.read_text())
    out = {"job": job, "status": j["status"]}
    if j["status"] == "queued":
        out["ahead"] = sum(1 for _, x in all_jobs() if x.get("status") in ("queued", "running") and x.get("created", 0) < j["created"])
    if j["status"] == "failed":
        out["error"] = j.get("error")
    if j["status"] == "done" and result_p.exists():
        out["result"] = json.loads(result_p.read_text())
    return out


@app.delete("/v2/jobs/{job}")
def delete_job(job: str, authorization: str | None = Header(None)):
    user = ticket_user(authorization)
    if not JOB.match(job):
        raise HTTPException(400, "任务号不对")
    for p in job_files(user, job):
        p.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/v2/voiceprint")
async def post_voiceprint(request: Request, authorization: str | None = Header(None)):
    """一段本人朗读 → 声纹。交给 worker 算，最多等 50 秒（Cloudflare 这类代理 100 秒就断）：算完直接返回 {embedding, speech_sec} 并删任务；
    没算完返回 202 {job}，客户端再轮询 GET /v2/jobs/{job}（结果里是 embedding、speech_sec），取走后 DELETE"""
    user = ticket_user(authorization)
    b = await read_body(request)
    job = new_job(user, "voiceprint", b.get("audio") or "")
    meta_p, audio_p, result_p = job_files(user, job)
    for _ in range(50):
        await asyncio.sleep(1)
        j = json.loads(meta_p.read_text())
        if j["status"] in ("done", "failed"):
            out = json.loads(result_p.read_text()) if j["status"] == "done" else None
            for p in (meta_p, audio_p, result_p):
                p.unlink(missing_ok=True)
            if out is None:
                raise HTTPException(422, j.get("error") or "没算出声纹")
            return out
    return JSONResponse({"job": job}, status_code=202)


@app.get("/v2/usage")
def usage(authorization: str | None = Header(None)):
    user = ticket_user(authorization)
    d = JOBS / user
    counts = {}
    for p, j in all_jobs():
        if p.parent.name == user:
            counts[j["status"]] = counts.get(j["status"], 0) + 1
    size = sum(p.stat().st_size for p in d.glob("*")) if d.exists() else 0
    return {"jobs": counts, "bytes": size, "keep_days": 7}


# ---------- 官方地图：用服务器的高德 Key 中转，客户端不用自己填 Key ----------

AMAP_KEY = os.environ.get("BEAYY_AMAP_KEY", "")
AMAP_JS_CODE = os.environ.get("BEAYY_AMAP_JS_CODE", "")
AMAP_PATHS = {"geocode/regeo", "geocode/geo", "place/around", "place/text", "staticmap"}
map_usage = Counter("map")


def fetch(url: str, method: str = "GET", body: bytes | None = None) -> Response:
    req = urllib.request.Request(url, data=body, method=method, headers={"user-agent": "Beayy-official/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return Response(r.read(), status_code=r.status, media_type=r.headers.get("content-type") or "application/json")
    except urllib.error.HTTPError as e:
        return Response(e.read(), status_code=e.code, media_type=e.headers.get("content-type") or "application/json")
    except Exception as e:
        raise HTTPException(502, f"连不上高德：{e}")


@app.get("/v2/amap/{path:path}")
def amap_rest(path: str, request: Request, authorization: str | None = Header(None)):
    user = ticket_user(authorization, "map")
    if not AMAP_KEY:
        raise HTTPException(503, "服务器没配官方地图")
    if path not in AMAP_PATHS:
        raise HTTPException(400, "不支持这个地图接口")
    q = [(k, v) for k, v in request.query_params.multi_items() if k != "key"] + [("key", AMAP_KEY)]
    map_usage.add(user)
    return fetch(f"https://restapi.amap.com/v3/{path}?{urllib.parse.urlencode(q)}")


@app.api_route("/_AMapService/{ticket}/{path:path}", methods=["GET", "POST"])
async def amap_js_proxy(ticket: str, path: str, request: Request):
    check_ticket(ticket, "map")
    if not AMAP_JS_CODE:
        raise HTTPException(503, "服务器没配官方地图")
    host = "https://webapi.amap.com" if path.startswith("v4/map/styles") else "https://fmap01.amap.com" if path.startswith("v3/vectormap") else "https://restapi.amap.com"
    q = list(request.query_params.multi_items()) + [("jscode", AMAP_JS_CODE)]
    body = await request.body() if request.method == "POST" else None
    r = fetch(f"{host}/{path}?{urllib.parse.urlencode(q)}", request.method, body)
    r.headers["access-control-allow-origin"] = "*"
    return r

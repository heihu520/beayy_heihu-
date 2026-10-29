#!/usr/bin/env python3
"""Beayy 转写任务（v2）：常驻，轮询 jobs/ 里排队的任务，一个一个转。接口在 server.py。

一个任务：jobs/<账号>/<任务>.json（状态、元数据、本人声纹、当天他人的质心）＋ <任务>.m4a。
转写 → <任务>.result.json（transcripts 格式的行、更新后的他人质心）；音频转完立刻删。取走的由 server.py 删，没取走的 7 天后这里删。
声纹任务：一段本人朗读 → 声纹（base64 的 float32），同样转完删音频。
资源：线程数由 OMP_NUM_THREADS 限，模型启动时加载、常驻（约 3G 内存）；模型第一次启动时从 ModelScope 下载（约 2G）。
"""
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from asr import Models, transcribe, unit
from usage import report

JOBS = Path(os.environ.get("BEAYY_JOBS_DIR", "data/jobs"))
KEEP_SEC = 7 * 86400



def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def write(p: Path, d: dict):
    tmp = p.with_name("." + p.name)
    tmp.write_text(json.dumps(d, ensure_ascii=False))
    os.replace(tmp, p)


def jobs():
    for p in JOBS.glob("*/*.json"):
        if p.name.endswith(".result.json") or p.name.startswith("."):
            continue
        try:
            yield p, json.loads(p.read_text())
        except (OSError, ValueError):
            continue


def run(m: Models, p: Path, job: dict):
    audio = p.with_suffix(".m4a")
    t0 = time.time()
    try:
        if job["kind"] == "voiceprint":
            emb, sec = m.voiceprint(audio)
            result = {"embedding": base64.b64encode(np.asarray(emb, dtype="<f4").tobytes()).decode(), "speech_sec": sec}
        else:
            meta = job["meta"]
            me = unit(np.frombuffer(base64.b64decode(job["self"]), dtype="<f4")) if job.get("self") else None
            others = job.get("others") or []
            start = datetime.fromisoformat(meta["start"])
            utts, audio_sec, speech = transcribe(m, audio, start, others, me, job.get("self_name") or "我", timezone.utc)
            seg = {"type": "segment", "id": meta["id"], "start": start.astimezone(timezone.utc).isoformat(timespec="seconds"),
                   "end": datetime.fromisoformat(meta["end"]).astimezone(timezone.utc).isoformat(timespec="seconds"),
                   "device": meta.get("device"), "battery": meta.get("battery"), "audio_sec": audio_sec, "speech_sec": speech}
            result = {"rows": [seg] + [{"type": "utt", "seg": meta["id"], **u} for u in utts],
                      "others": others, "audio_sec": audio_sec, "speech_sec": speech}
        write(p.with_name(p.stem + ".result.json"), result)
        job.update(status="done", took_sec=round(time.time() - t0, 1))
        if job["kind"] == "transcribe":
            report(p.parent.name, "asr", result.get("audio_sec") or 0, log)  # 官方转写按账号每月记音频秒数
        log(f"{p.parent.name[:6]}/{p.stem} {job['kind']} 完成，用时 {job['took_sec']}s")
    except Exception as e:  # 坏文件、人声太少：任务记失败，不卡住队列
        job.update(status="failed", error=str(e)[:300])
        log(f"{p.parent.name[:6]}/{p.stem} 失败：{e!r}")
    finally:
        audio.unlink(missing_ok=True)
    write(p, job)


def cleanup():
    now = time.time()
    for p, job in list(jobs()):
        if now - job.get("created", now) > KEEP_SEC:
            for q in (p, p.with_suffix(".m4a"), p.with_name(p.stem + ".result.json")):
                q.unlink(missing_ok=True)
    for d in JOBS.glob("*"):
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()


def main():
    JOBS.mkdir(parents=True, exist_ok=True)
    # 上次跑到一半退出的，重新排队
    for p, job in jobs():
        if job.get("status") == "running":
            job["status"] = "queued"
            write(p, job)
    # 模型启动就加载、一直常驻：第一段不用等加载（声纹接口只等 50 秒）
    m, last_clean = Models(log), 0.0
    while True:
        if time.time() - last_clean > 3600:
            cleanup()
            last_clean = time.time()
        queued = sorted(((job.get("created", 0), str(p), p, job) for p, job in jobs() if job.get("status") == "queued"))
        if not queued:
            time.sleep(3)
            continue
        _, _, p, job = queued[0]
        job["status"] = "running"
        write(p, job)
        run(m, p, job)


if __name__ == "__main__":
    sys.exit(main())

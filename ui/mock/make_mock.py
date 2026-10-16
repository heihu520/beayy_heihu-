#!/usr/bin/env python3
"""生成浏览器预览用的样例数据（全是虚构的，没有任何真实记录）。
用法：python3 app/ui/mock/make_mock.py  → 写出 mock/<命令名>.json 和 mock/mock.js（双击 index.html 用 file:// 打开时读它）
命令和返回格式见 app/src-tauri/COMMANDS.md。"""
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

random.seed(7)
HERE = Path(__file__).resolve().parent
LOCAL = datetime.now().astimezone().tzinfo
today = datetime.now(LOCAL).replace(hour=0, minute=0, second=0, microsecond=0)
iso = lambda t: t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

MAC_APPS = [("Visual Studio Code", "com.microsoft.VSCode"), ("Safari", "com.apple.Safari"), ("Slack", "com.tinyspeck.slackmacgap"),
            ("备忘录", "com.apple.Notes"), ("Figma", "com.figma.Desktop"), ("邮件", "com.apple.mail")]
PHONE_APPS = [("微信", "com.tencent.xin"), ("Safari 浏览器", "com.apple.mobilesafari"), ("小红书", "com.xingin.discover"),
              ("Kindle", "com.amazon.Lassen"), ("时钟", "com.apple.mobiletimer")]
WORK = [  # (标题, 描述, 类型, 领域, 项目)
    ("官网首页改版", "你调整了首页布局，修好了移动端的导航，并提交给同事评审。", "编码", "工作", "官网改版"),
    ("整理季度报告", "你汇总了三个月的数据，写完报告的第二节，图表还差两张。", "写作", "工作", "季度报告"),
    ("回复客户消息", "你在 Slack 里回复了两位客户关于交付时间的问题。", "即时消息", "工作", "客户支持"),
    ("读《深度工作》", "你读完第三章，做了五条笔记。", "学习", "成长", "读书笔记"),
    ("查报税资料", "你查了今年个税专项扣除的规则，下载了两份表格。", "事务", "生活", ""),
]

def day_data(d, n_hours):
    start = d + timedelta(hours=9)
    segs, hours, spans = [], [], []
    for h in range(n_hours):
        hs = start + timedelta(hours=h)
        picks = random.sample(WORK, 2)
        for k in range(6):
            t, desc, act, dom, proj = picks[k // 3]
            st = hs + timedelta(minutes=10 * k)
            segs.append({"start": iso(st), "end": iso(st + timedelta(minutes=10)), "kind": "10min", "source": "beayy",
                         "title": t, "description": desc, "memory": desc, "context": [f"{proj or '日常事务'}：进行中"],
                         "recording": f"### {t}\n\n- {desc}", "apps": [b for _, b in random.sample(MAC_APPS, 3)],
                         "active_sec": random.randint(420, 600), "parts": [{"activity": act, "domain": dom, "project": proj, "share": 1.0}]})
        hours.append({"start": iso(hs), "end": iso(hs + timedelta(hours=1)), "title": picks[0][0], "description": picks[0][1],
                      "active_sec": 3000, "parts": [{"activity": picks[0][2], "project": picks[0][4], "sec": 1800}]})
        spans.append([iso(hs), iso(hs + timedelta(minutes=50))])
    sessions = []
    for h in [7, 12, 13, 18, 21, 22]:
        st = d + timedelta(hours=h, minutes=random.randint(0, 40))
        apps = random.sample(PHONE_APPS, 2)
        secs = [random.randint(60, 900) for _ in apps]
        sessions.append({"start": iso(st), "end": iso(st + timedelta(seconds=sum(secs))), "sec": sum(secs), "kind": "session", "count": 1,
                         "apps": [{"bundle_id": b, "name": n, "sec": s} for (n, b), s in zip(apps, secs)]})
    phone_total = sum(s["sec"] for s in sessions)
    def tree(key):
        agg = {}
        for s in segs:
            for p in s["parts"]:
                g = {"编码": "创作", "写作": "创作", "即时消息": "沟通", "学习": "获取", "事务": "管理"}[p["activity"]] if key == "activities" else p["domain"]
                c = p["activity"] if key == "activities" else (p["project"] or "未归项目")
                agg.setdefault(g, {}).setdefault(c, 0)
                agg[g][c] += s["active_sec"] * p["share"]
        return sorted([{"name": g, "sec": round(sum(v.values())), "children": sorted([{"name": c, "sec": round(x)} for c, x in v.items()], key=lambda r: -r["sec"])}
                       for g, v in agg.items()], key=lambda r: -r["sec"])
    active = sum(s["active_sec"] for s in segs)
    return {
        "date": d.strftime("%Y-%m-%d"), "pack": None, "summary_md": None, "segments": segs, "hours": hours,
        "live": {"active_sec": active, "first": "09:00", "last": f"{9 + n_hours:02d}:00", "switches": 40 * n_hours,
                 "active_hours": {f"{9 + h:02d}": 3000 for h in range(n_hours)}, "spans": spans,
                 "apps": [{"name": n, "bundle_id": b, "sec": random.randint(600, 6000)} for n, b in MAC_APPS]},
        "work": {"domains": tree("domains"), "activities": tree("activities"), "tagged_sec": active, "untagged_sec": 0},
        "phone": {"total_sec": phone_total, "pickups": len(sessions) * 3, "late_sec": 900, "night_sec": 0,
                  "apps": [{"bundle_id": b, "name": n, "sec": random.randint(300, 2400)} for n, b in PHONE_APPS],
                  "hours": {f"{h:02d}": random.randint(60, 1200) for h in [7, 12, 13, 18, 21, 22]},
                  "synced_until": iso(datetime.now(LOCAL) - timedelta(hours=2)), "sessions": sessions},
    }

days = [today - timedelta(days=i) for i in range(14)]
get_day = {d.strftime("%Y-%m-%d"): day_data(d, 3 if i == 0 else random.randint(4, 9)) for i, d in enumerate(days)}
for k, v in list(get_day.items())[1:]:
    v["summary_md"] = "# 样例\n\n## 今天的一句话\n\n你把官网改版推进到了评审，报告还差两张图。\n\n## 做成了什么\n\n- 首页改版提交评审\n- 季度报告写完第二节\n\n## 偏离\n\n- 21:00 以后用了 30 分钟手机\n\n## 明天\n\n- 补完报告的图表\n"
mock = {
    "list_days": [{"date": k, "line": None, "active_sec": v["live"]["active_sec"], "phone_sec": v["phone"]["total_sec"],
                   "hc": v["live"]["active_hours"], "hp": v["phone"]["hours"]} for k, v in get_day.items()],
    "get_day": get_day,
    "get_status": {"permissions": {"accessibility": True, "input_monitoring": True, "full_disk_access": True}, "capturing": True, "paused": False,
                   "paused_until": None, "events_today": 1234, "phone_sync": "iphone-1A2B3C4D 新增 0 条", "device": "mac-Demo-MacBook",
                   "version": "0.2.0", "shadow": False, "login_item": True},
    "get_settings": {"gateway": "https://api.openai.com/v1", "model_segment": "gpt-4.1-mini", "model_daily": "gpt-4.1-mini", "repo_path": "",
                     "blocklist": ["com.1password.1password"], "has_api_key": True, "api_key_source": "keychain", "onboarded": True},
    "get_rules": [{"id": "r1", "text": "22:00 以后不开电脑", "enabled": True}, {"id": "r2", "text": "手机每天不超过 3 小时", "enabled": True}],
    "list_devices": [{"id": "mac-Demo-MacBook", "kind": "mac", "name": "Mac · Demo-MacBook", "this": True, "synced": False, "first": iso(days[-1]), "last": iso(datetime.now(LOCAL)), "events": 42000, "bytes": 30_000_000},
                     {"id": "iphone-1A2B3C4D", "kind": "iphone", "name": "iPhone · 1A2B3C4D", "this": False, "synced": False, "first": iso(days[-1]), "last": iso(datetime.now(LOCAL)), "events": 9000, "bytes": 3_000_000}],
    "sync_status": {"configured": True, "email": "demo@example.com", "server": "https://sync.example.com", "user": "demo", "last": iso(datetime.now(LOCAL)),
                    "last_error": None, "uploaded": 1800, "need_login": False, "running": False, "shadow": False},
    "get_profile": {"name": "Demo", "avatar": None, "email": "demo@example.com"},
    "list_projects": [{"name": "官网改版", "domain": "工作", "sec": 36000, "last": iso(today), "aliases": []},
                      {"name": "季度报告", "domain": "工作", "sec": 20000, "last": iso(today), "aliases": ["Q3 报告"]},
                      {"name": "读书笔记", "domain": "成长", "sec": 8000, "last": iso(today), "aliases": []}],
}
for k, v in mock.items():
    (HERE / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False), encoding="utf-8")
(HERE / "mock.js").write_text("window.BEAYY_MOCK = " + json.dumps(mock, ensure_ascii=False) + ";\n", encoding="utf-8")
print("写好", len(mock), "个样例")

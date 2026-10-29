#!/usr/bin/env python3
"""管理账号的官方服务（这台服务器上的模型、转写、地图）。账号要开通才拿得到转写、地图票据，才能用服务器配的模型。
  python admin.py list                                     所有账号：开通情况、上限、本月用量
  python admin.py open <邮箱> [模型 token] [转写分钟] [地图次数]   开通，上限默认 0＝不限
  python admin.py stop <邮箱>                              停用
Docker 里：docker compose exec -u beayy beayy-server python admin.py list
"""
import json
import sys

import syncapi

COLS = ("SELECT u.email, u.llm_plan AS plan, u.llm_quota, u.asr_quota / 60 AS asr_quota_min, u.map_quota, "
        "(SELECT COALESCE(SUM(used), 0) FROM usage g WHERE g.user = u.user AND g.month = ? AND g.service = 'llm') AS llm_used, "
        "(SELECT COALESCE(SUM(used), 0) FROM usage g WHERE g.user = u.user AND g.month = ? AND g.service = 'asr') / 60 AS asr_used_min, "
        "(SELECT COALESCE(SUM(used), 0) FROM usage g WHERE g.user = u.user AND g.month = ? AND g.service = 'map') AS map_used "
        "FROM users u WHERE u.email IS NOT NULL")


def main(a: list[str]) -> int:
    if not a or a[0] not in ("list", "open", "stop"):
        print(__doc__)
        return 2
    syncapi.init()
    c = syncapi.db()
    m = syncapi.month()
    if a[0] == "list":
        for r in c.execute(COLS + " ORDER BY u.email", (m, m, m)):
            print(json.dumps(dict(r), ensure_ascii=False))
        return 0
    if len(a) < 2:
        print(__doc__)
        return 2
    email = syncapi.email_of(a[1])
    if a[0] == "stop":
        n = c.execute("UPDATE users SET llm_plan = 'stopped' WHERE email = ?", (email,)).rowcount
    else:
        try:
            llm, asr, mp = (int(x) for x in (a[2:] + ["0", "0", "0"])[:3])
        except ValueError:
            print("上限要是整数")
            return 2
        n = c.execute("UPDATE users SET llm_plan = 'official', llm_quota = ?, asr_quota = ?, map_quota = ? WHERE email = ?",
                      (llm, asr * 60, mp, email)).rowcount
    print(f"改了 {n} 个账号" if n else f"没有 {email} 这个账号")
    return 0 if n else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

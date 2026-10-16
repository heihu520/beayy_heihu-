# Tauri 命令清单（网页界面 ↔ Rust）

网页用 `window.__TAURI__.core.invoke(命令名, 参数)` 调用（`app.withGlobalTauri = true`，不用打包工具）。不在 Tauri 里（直接用浏览器开 `app/ui/index.html` 调样式）时，读 `app/ui/mock/<命令名>.json`。

所有时间：日期用本地日 `YYYY-MM-DD`；时刻用 ISO8601（UTC，带 Z），页面自己换成本地时间显示。所有时长单位是秒。

| 命令 | 参数 | 返回 |
|---|---|---|
| `get_status` | — | `{ "permissions": {"accessibility": bool, "input_monitoring": bool, "full_disk_access": bool}, "capturing": bool, "paused": bool, "events_today": int, "phone_sync": "iphone-1A2B3C4D 同步截至 …", "device": "mac-…", "version": "0.2.0", "paused_until": ISO 或 null, "login_item": bool }`。`events_today` 是今天本机写的总条数（不是本次启动以来） |
| `list_days` | — | `[{ "date": "2026-10-15", "line": "今天的一句话（没有日总结为 null）", "active_sec": int, "phone_sec": int, "hc": {"09": 秒, …}, "hp": {"09": 秒, …} }]`，新的在前；`hc`／`hp` 是每小时电脑／手机分钟数（同网站索引），给作息图用 |
| `get_day` | `{ "date": "YYYY-MM-DD" }` | `{ "date", "pack": <日数据/日数据_YYYYMMDD.json 原样，没有为 null>, "summary_md": <日总结 Markdown 原文或 null>, "segments": [{ "start": ISO, "end": ISO, "kind": "10min"/"6h"/"idle"（连续「不在电脑前」合成的一段）, "source": "beayy"/"codex", "title", "description", "memory", "context": [..] }], "phone": { "total_sec", "pickups", "late_sec", "night_sec", "apps": [{"bundle_id", "name", "sec"}], "hours": {"09": 秒, …}, "synced_until": ISO, "sessions": [{ "start", "end", "sec", "kind": "session"/"brief"（连着的零碎拿起合成一行）, "count", "apps": [{"bundle_id", "name", "sec"}] }] }, "live": 今天（或还没有数据包的那天）从自采事件实时算的电脑 `{ "active_sec", "first", "last", "switches", "active_hours": {"09": 秒}, "spans": [[ISO, ISO]], "apps": [{"name", "bundle_id", "sec"}] }` 或 null }`；segments 每段另有 `"apps": [bundle id]` |
| `get_rules` | — | `[{ "id": "r1", "text": "21:00 硬停", "enabled": true }]`（存 `Beayy/rules.json`） |
| `save_rules` | `{ "rules": [...] }` | `null` |
| `get_settings` | — | `{ "gateway": "https://api.openai.com/v1", "model_segment": "gpt-4.1-mini", "model_daily": "gpt-4.1-mini", "repo_path": "", "blocklist": ["com.1password.1password"], "has_api_key": bool, "api_key_source": "env"/"keychain"/null, "onboarded": bool }`（存 `Beayy/settings.json`，密钥在钥匙串，不经网页回传） |
| `save_settings` | `{ "settings": {...} }`（不含密钥） | `null` |
| `set_api_key` | `{ "key": "sk-…" }` | `null`（写钥匙串） |
| `set_paused` | `{ "paused": bool, "minutes": int?（给了就是定时暂停，到点自动继续） }` | `null` |
| `set_login_item` | `{ "on": bool }` | `null`；失败返回系统给的错误 |
| `delete_since` | `{ "minutes": int }` 或 `{ "today": true }` | 删掉的条数。只删本机电脑事件和对应分段的 10 分钟摘要；iPhone 记录、已归档进仓库的不动 |
| `list_devices` | — | `[{ "id": "mac-…"/"iphone-…", "kind": "mac"/"iphone"/"win", "name", "this": 是否本机, "first": ISO, "last": ISO, "events": 条数, "bytes": 占用 }]`，本机排第一（读数据目录 devices/，缓存 60 秒） |
| `sync_status` | — | `{ configured, email, server, user, last, last_error, uploaded, need_login, running, shadow }` |
| `sync_now` | — | `{ uploaded, downloaded, errors }` |
| `account_signup` / `account_login` / `account_claim` / `account_recover` / `account_password` | 邮箱、主密码（signup 另要 invite，recover 另要 code） | signup、claim 返回恢复码 |
| `account_info` | — | `{ user, email, session, sessions: [{id, name, device, created, last_seen}], profile: {name, avatar, updated} }` |
| `account_remove_device` | `{ "id" }` | `null` |
| `account_logout` / `account_recovery_code` | — | `null` ／ 恢复码 |
| `get_profile` / `save_profile` | — ／ `{ name, avatar: data URL 或 null }` | `{ name, avatar, email }` ／ `null` |
| `list_projects` | — | `[{ name, domain, sec, last, aliases }]` |
| `merge_project` / `set_project_domain` | `{ from, into }` ／ `{ project, domain }` | `null` |
| `get_icons` | `{ "ids": [bundle id], "phone": bool }` | `{ id: { "icon": "data:image/png;base64,…" 或 null, "name": App Store 上的名字或 null } }`。电脑取本机图标；手机查 App Store（先中国区再美区），查不到的苹果自带 app 用 Mac 上对应的；缓存在 `Beayy/icons/` |
| `open_permission` | `{ "kind": "accessibility" \| "input_monitoring" \| "full_disk_access" }` | `null`（打开系统设置对应页） |
| `open_data_dir` | — | `null` |

**实现状态（10-15）**：表里命令都已在 Rust 实现（`src-tauri/src/main.rs`、`src-tauri/src/data.rs`），和 `ui/mock/生成样例.py` 的输出逐项对过：31 天 `list_days`、10-15 的 `get_day` 完全相同。调试可以不开界面直接看结果：`app/target/release/beayy --dump list_days`、`--dump get_day 2026-10-15`、`--dump get_settings`、`--dump get_rules`。`settings.json` 里沿用 Python 摘要脚本的键名（summary_model、daily_model、blacklist），由 Rust 换成上表的叫法。

**并跑版自检（只在影子模式下有效）**：
- 不经菜单栏打开主窗口：`open -a ~/Applications/Beayy-rs.app`（已在运行时会打开主窗口），或启动参数 `--open`。
- 截图钩子：往 `~/Library/Application Support/Beayy/shadow/snapshots/request.json` 写 `{"name": "…", "js": "…"}`。app 每秒看一次：打开主窗口 → 执行 js → 等 1 秒 → 截主窗口写 `snapshots/<name>.png`，结果写 `<name>.result.txt`，请求文件随即删除。锁屏时系统不给窗口内容，截出来是白的。
- `dev_report`：`invoke("dev_report", {name, text})` 把页面状态写到 `snapshots/<name>.txt`，配合截图钩子读页面里的数据。
- 主窗口标题栏是 Overlay、隐藏标题，系统窗口按钮叠在侧栏左上角。

`pack` 的字段以 `网站/build.py` 和 `网站/static/app.js` 现在用的为准（computer、phone、codex、git、cover 等）。新增字段只加不改名。

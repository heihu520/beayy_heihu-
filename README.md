# Beayy — Be Authentic. Your Yesterdays.

在后台记下你一天在电脑和手机上做了什么，每 10 分钟写一段摘要、每小时合成一段、每晚写一份日总结；告诉你时间花在了哪些领域和项目上，对照你自己定的规矩。

*Beayy quietly records what you do on your Mac and iPhone, writes a summary every 10 minutes and a journal every evening, and shows where your time actually went. Everything stays on your machine; optional end-to-end encrypted sync between devices.*

## 能做什么

- **今天**：在电脑前多久、手机多久、切换了多少次；一天的形状（每小时电脑和手机的使用）；时间花在哪（领域 · 项目、类型，两级分类）。
- **时间线**：按小时看在做什么，点开看每 10 分钟的摘要和每次拿起手机用了哪些 app；电脑、手机分开看。
- **总结**：每天的日总结（今天的一句话、时间去向、做成了什么、规矩、偏离、明天），最近 14 天作息图。
- **规矩**：用自己的话写，比如「22:00 以后不开电脑」「手机每天不超过 3 小时」「抖音每天不超过 30 分钟」，当天就对照。
- **设备与同步**：多台电脑登录同一个账号，记录在本机加密后同步，服务器读不到内容。

## 记什么、存在哪

| | |
|---|---|
| 电脑 | 切到哪个 app 和窗口、打字和发出去的内容、点了什么、滚动、屏幕上的文字（辅助功能读取）、在不在电脑前、睡眠锁屏。密码框不记；可以指定某些 app 完全不记；可以随时暂停、删掉最近 15 分钟／1 小时／今天的记录 |
| 手机 | iPhone 经 iCloud 同步到 Mac 的屏幕使用时间：每个 app 什么时候在前台、用了多久（看不到 app 里的内容） |
| 存储 | 全部在本机 `~/Library/Application Support/Beayy/`，按设备、每 10 分钟一个文件，只追加 |
| 摘要 | 把那 10 分钟的记录发给**你自己配置**的模型服务（任何 OpenAI 兼容接口），写回本机 |
| 同步（可选） | 本机压缩、XChaCha20-Poly1305 加密后上传；主密码只在设备上用（Argon2id 派生），服务器只存密文和登录校验值的哈希 |

## 安装

到 [Releases](../../releases) 下载 `Beayy.dmg`，拖进「应用程序」打开。第一次打开会带你走一遍：授权（辅助功能、输入监控、可选的完全磁盘访问）、填模型、要不要同步。

要求 macOS 14 以上。Windows 版在做（目前只记前台 app 和在不在电脑前，没在真机上充分测试）。

## 让 AI 读你的记录（MCP）

Beayy 自带一个本机 MCP 服务，Claude Code、Claude 桌面版这类本机 AI 可以直接查你的记录，数据不出这台电脑（只读）：

```bash
claude mcp add beayy -- ~/Applications/Beayy.app/Contents/MacOS/beayy --mcp
```

工具：`list_days`（最近每天概况）、`get_day`（某天的时长、每小时在做什么、时间花在哪、日总结）、`search`（在 10 分钟摘要里搜关键词）、`get_rules_and_projects`。

## 从源码编译

```bash
# Rust（rustup）和 Xcode 命令行工具
git clone https://github.com/hengfengliya/beayy && cd beayy
./build.sh            # 编译、签名（有 Developer ID 证书就用，没有就本机临时签名）、装到 ~/Applications/Beayy.app 并启动
./build.sh --shadow   # 测试版：装成 Beayy-rs.app，写独立的影子目录，可以和正式版同时跑
./build.sh --dmg      # 打安装包 target/Beayy-<版本>.dmg；用 Developer ID 签名并给了公证凭据就自动公证
```

只看界面：用浏览器打开 `ui/index.html`，读 `ui/mock/` 里的虚构样例数据（`python3 ui/mock/make_mock.py` 重新生成）。

## 结构

| 目录 | 内容 |
|---|---|
| `crates/beayy-core` | 事件格式与写入（按设备、UTC 整 10 分分段、只追加）、设备名、数据目录 |
| `crates/beayy-capture` | 采集：macOS 键鼠监听、打字与发送、界面文字、切 app、在场与心跳、权限；Windows 时长与在场 |
| `crates/beayy-phone` | 读 iPhone 经 iCloud 同步来的屏幕使用时间（macOS） |
| `crates/beayy-summary` | 10 分钟摘要、小时摘要、两级分类（类型、领域 · 项目）、项目名合并 |
| `crates/beayy-sync` | 多设备同步客户端：账号、加密、上传下载 |
| `src-tauri` | Tauri 2 外壳：菜单栏、主窗口、给网页的命令（`src-tauri/COMMANDS.md`）、定时任务、日总结 |
| `ui` | 网页界面：纯 HTML＋CSS＋JS |
| `sync-server` | 同步服务：Cloudflare Workers＋R2＋D1，只存密文；可以自己部署（见 `sync-server/wrangler.jsonc`） |

## 许可

MIT，见 [LICENSE](LICENSE)。用到的第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

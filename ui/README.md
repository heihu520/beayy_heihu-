# Beayy 网页界面（app/ui）

Tauri 2 外壳加载的网页：今天、日总结、规矩、设置四页。纯 HTML＋CSS＋原生 JS，不用打包工具，入口 `index.html`。

## 文件

| 文件 | 内容 |
|---|---|
| `index.html` | 壳：侧栏（品牌、四个入口、最近 12 天、记录状态）＋正文 |
| `app.js` | 取数、路由（`#/today`、`#/summary/YYYY-MM-DD`、`#/rules`、`#/settings`）、四页 |
| `style.css` | 壳的布局、作息图／一天的形状／读数（设计系统「人生记录」，取自 `网站/static/`，变量加 `rec-` 前缀）、页面专用的几样 |
| `vendor/moxian/` | 墨线的 `tokens.css`（由 tokens.json 生成）和 `bundle.css`（原样拷贝），不要手改 |
| `tools/同步墨线.py` | 墨线改了就跑一次：`python3 app/ui/tools/同步墨线.py` |
| `mock/` | 样例数据（全是虚构的）：`<命令名>.json` 和合成的 `mock.js`，由 `mock/make_mock.py` 生成 |

## 墨线怎么引用

Tauri 只能读 `app/ui/` 里面的文件，所以把 `设计系统/墨线/project/` 拷一份进 `vendor/moxian/`，不在页面里用相对路径跳出去。主题：默认跟随系统，设置页可固定成浅色或深色（`<html data-theme>`，记在 localStorage）。

## 取数

- 在 Tauri 里：`window.__TAURI__.core.invoke(命令, 参数)`，命令和返回格式见 `app/src-tauri/COMMANDS.md`。
- 浏览器里：读 `mock/<命令名>.json`；双击用 `file://` 打开时浏览器不让读本地文件，改读 `mock/mock.js`。写操作（保存规矩、设置、密钥、暂停）只改内存。
- `get_day.json` 一个文件装最近 14 天，按日期做键。
- 重新生成样例：`python3 app/ui/mock/make_mock.py`。

## 和 COMMANDS.md 对不上、需要 Rust 那边补的

- `get_day.segments[]` 多带一个 `recording`（「经过」，Markdown），页面点开时段要显示；没有时退回显示 `memory`。
- `get_day.segments[].kind` 除了 `10min` 还会有 `6h`（Codex 的 6 小时摘要），页面标「6 小时」。
- `get_day.phone.night_sec` 当成凌晨 0–5 点的使用秒数（同日数据包的 `dawn_sec`）；熬夜 = 电脑 `late_sec`＋手机 `late_sec`＋`night_sec`。
- `list_days[].hc`／`hp` 接受两种：`{"09": 秒}`（COMMANDS.md 的写法）或 24 个分钟数的数组（网站索引的写法）。
- 手机读不到时 `get_day.phone` 给 `null`；页面看 `get_status.permissions.full_disk_access`，没开就写「未授权完全磁盘访问」，不写 0。

## Tauri 窗口

`<html>` 在 Tauri 里会加 `is-tauri`：侧栏顶部左边让出 72 像素给系统窗口按钮，侧栏顶部和页头带 `data-tauri-drag-region` 可拖窗口。外壳那边窗口用 `titleBarStyle: "Overlay"`、隐藏标题。

## 自测

```bash
python3 -m http.server 8767 --directory "app/ui"
```

打开 http://localhost:8767 ，或直接双击 `index.html`。

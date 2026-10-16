// Beayy 网页界面：今天、日总结、规矩、设置四页。纯 JS，不用打包工具。
// 取数：Tauri 里用 window.__TAURI__.core.invoke（命令见 app/src-tauri/COMMANDS.md）；
// 浏览器里读 mock/<命令名>.json（双击 file:// 打开时改读 mock/mock.js）。
// 作息图、一天的形状、读数的画法取自 网站/static/app.js（设计系统「人生记录」）。

const $app = document.getElementById("app");
const TAURI = window.__TAURI__ && window.__TAURI__.core;

// ---------- 取数 ----------

let MOCK = null;
const mockState = {};

async function loadMock(name) {
  if (location.protocol !== "file:") {
    try {
      const r = await fetch(`mock/${name}.json`, { cache: "no-cache" });
      if (r.ok) return r.json();
    } catch (e) { /* 退回 mock.js */ }
  }
  if (!MOCK) {
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "mock/mock.js"; s.onload = ok; s.onerror = () => fail(new Error("读不到 mock/mock.js，先跑 mock/make_mock.py"));
      document.head.appendChild(s);
    });
    MOCK = window.BEAYY_MOCK;
  }
  return JSON.parse(JSON.stringify(MOCK[name]));
}

async function call(cmd, args = {}) {
  if (TAURI) return TAURI.invoke(cmd, args);
  // 浏览器里：写操作只改内存，读操作读样例
  switch (cmd) {
    case "save_rules": mockState.rules = args.rules; return null;
    case "save_settings": mockState.settings = { ...args.settings, has_api_key: (mockState.settings || {}).has_api_key }; return null;
    case "set_api_key": mockState.hasKey = true; return null;
    case "set_paused": mockState.paused = args.paused; return null;
    case "open_permission": case "open_data_dir": console.info(`样例模式：${cmd}`, args); return null;
    case "get_rules": return mockState.rules || loadMock("get_rules");
    case "get_settings": {
      const s = mockState.settings || await loadMock("get_settings");
      if (mockState.hasKey) s.has_api_key = true;
      return s;
    }
    case "get_status": {
      const s = await loadMock("get_status");
      if (mockState.paused !== undefined) s.paused = mockState.paused;
      return s;
    }
    case "get_day": return (await loadMock("get_day"))[args.date] || null;
    default: return loadMock(cmd);
  }
}

// ---------- 小工具 ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hh = (sec) => (sec == null ? "—" : (sec / 3600).toFixed(1));
const mins = (sec) => (sec == null ? "—" : String(Math.round(sec / 60)));
// 时间都按这台电脑的本地时区显示（以前写死了东八区）
const pad2 = (n) => String(n).padStart(2, "0");
const toDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd); };
const weekday = (d) => "周" + "日一二三四五六"[toDate(d).getDay()];
const short = (d) => `${d.slice(5)} ${weekday(d)}`;
const localDay = (t = new Date()) => `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
const hm = (iso) => { if (!iso) return ""; const t = new Date(iso); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
const mdhm = (iso) => { if (!iso) return ""; const t = new Date(iso); return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${hm(iso)}`; };
const addDays = (d, n) => localDay(new Date(toDate(d).getTime() + 12 * 3600e3 + n * 864e5));

/** 每小时秒数（电脑）：数据包的 active_hours {"09": 秒}，或老数据包的 hours {"09": {app: 秒}} */
function hourSecs(c) {
  c = c || {};
  const h = c.active_hours || Object.fromEntries(Object.entries(c.hours || {}).map(([k, v]) => [k, typeof v === "number" ? v : Object.values(v).reduce((a, b) => a + b, 0)]));
  return Array.from({ length: 24 }, (_, i) => h[String(i).padStart(2, "0")] || 0);
}

/** 区间 [[ISO, ISO]] 落在某天 hour 点以后的秒数 */
function secsAfter(spans, date, hour) {
  const from = toDate(date).getTime() + hour * 3600e3, to = toDate(date).getTime() + 864e5;
  return spans.reduce((s, [a, b]) => s + Math.max(0, Math.min(Date.parse(b), to) - Math.max(Date.parse(a), from)) / 1000, 0);
}

/** 每小时分钟数：接受数组（分钟）或 {"09": 秒} */
function hourMinutes(h) {
  if (Array.isArray(h)) return Array.from({ length: 24 }, (_, i) => h[i] || 0);
  return Array.from({ length: 24 }, (_, i) => Math.min(60, Math.round(((h || {})[String(i).padStart(2, "0")] || 0) / 60)));
}

const ICON = {
  chevL: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  chevR: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  chevD: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>',
  check: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  close: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
};

// 极简 Markdown：小标题、列表、段落，行内粗体和代码。先转义再加标记。
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); out.push(`<h5>${inline(m[1])}</h5>`); }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\d+[.、]\s*(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (line.startsWith(">")) { close(); out.push(`<p class="note">${inline(line.replace(/^>\s*/, ""))}</p>`); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return `<div class="md">${out.join("")}</div>`;
}

/** 按 ## 切日总结：开头的引用块是口径说明 */
function splitSummary(text) {
  const parts = []; let note = []; let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("## ")) { cur = { title: line.slice(3).trim(), body: [] }; parts.push(cur); }
    else if (cur) cur.body.push(line);
    else if (line.startsWith(">")) note.push(line.replace(/^>\s*/, ""));
  }
  return { note: note.join(" "), parts: parts.map((p) => ({ title: p.title, body: p.body.join("\n").trim() })) };
}

// ---------- 页面骨架 ----------

function header(title, right = "") {
  return `<header class="mx-head"><div class="mx-head-row" data-tauri-drag-region><h1 class="mx-title">${esc(title)}</h1><div class="mx-head-right">${right}</div></div></header>`;
}
const section = (title, body, { count, aside } = {}) =>
  `<section class="mx-sec"><div class="mx-sec-head"><h3>${esc(title)}</h3>${count != null ? `<span class="mx-count">${count}</span>` : ""}${aside ? `<span class="mx-sec-aside">${aside}</span>` : ""}</div>${body}</section>`;
const emptyInline = (text) => `<p class="mx-empty-inline">${esc(text)}</p>`;

// ---------- 人生记录：读数、一天的形状、作息图 ----------

const shade = (min, v) => (min ? `background:color-mix(in srgb, var(${v}) ${Math.round(30 + (Math.min(min, 60) / 60) * 70)}%, var(--rec-track))` : "");
const isNight = (h) => h >= 21 || h < 5;

function readout(k, v, unit, caption = "", over = false) {
  return `<div class="ro${over ? " over" : ""}"><div class="label">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="caption" title="${esc(caption)}">${esc(caption) || "&nbsp;"}</div></div>`;
}

function dayStrip(hc, hp, clickable = false) {
  const cells = (arr, v, name) => arr.map((m, h) => `<span style="${shade(m, v)}" title="${h}:00 ${name} ${m} 分钟"${clickable ? ` data-h="${h}"` : ""}></span>`).join("");
  return `<div role="img" aria-label="一天的形状：上排电脑，下排手机"><div class="strip">${cells(hc, "--rec-computer", "电脑")}${cells(hp, "--rec-phone", "手机")}</div>
    <div class="strip-axis" aria-hidden="true">${hc.map((_, h) => `<span>${h % 3 ? "" : h}</span>`).join("")}</div></div>`;
}

function actogram(rows, cur) {
  let html = "";
  for (const [k, x] of rows.entries()) {
    // 行末：这一晚的分钟数＝当天 21 点以后＋次日 0–5 点（次日没有数据就只算当天）
    const nx = rows[k + 1] || x.next;
    let late = nx ? [0, 1, 2, 3, 4].reduce((a, h) => a + Math.max(nx.hc[h], nx.hp[h]), 0) : 0;
    html += x.has ? `<a class="d${x.date === cur ? " cur" : ""}" href="#/summary/${x.date}">${short(x.date)}</a>` : `<span class="d">${short(x.date)}</span>`;
    for (let h = 0; h < 24; h++) {
      const c = x.hc[h], p = x.hp[h];
      if (h >= 21) late += Math.max(c, p);
      html += `<div class="cell${isNight(h) && (c || p) ? " n" : ""}" title="${short(x.date)} ${h}:00 电脑 ${c} 分钟 · 手机 ${p} 分钟"><span style="${shade(c, "--rec-computer")}"></span><span style="${shade(p, "--rec-phone")}"></span></div>`;
    }
    html += `<span class="late">${late > 10 ? late + "m" : ""}</span>`;
  }
  const axis = Array.from({ length: 8 }, (_, i) => `<span style="grid-column:${2 + i * 3}">${i * 3}</span>`).join("");
  return `<div role="img" aria-label="最近 ${rows.length} 天的作息图：每天一行，上条电脑，下条手机"><div class="acto">${html}</div><div class="acto-axis" aria-hidden="true">${axis}</div></div>
    <div class="legend"><span><i style="background:var(--rec-computer)"></i>电脑</span><span><i style="background:var(--rec-phone)"></i>手机</span><span><i style="background:var(--rec-night)"></i>夜间有活动（21:00 后、0–5 点），行末是这一晚（21:00 到次日 5 点）的分钟数</span></div>`;
}

// ---------- 状态 ----------

const S = { days: [], status: null, page: "today", rules: null, settings: null, draft: null };

async function boot() {
  [S.days, S.status, S.sync, S.profile] = await Promise.all([call("list_days"), call("get_status"), call("sync_status").catch(() => ({})), call("get_profile").catch(() => ({ name: "我" }))]);
  renderSide();
}

function renderSide() {
  // 侧栏只放导航；记录状态在「设备」页，这里只在缺权限、暂停、没在记录时给「设备」挂一个点
  const st = S.status || {};
  const perm = st.permissions || {};
  const bad = st.paused || !perm.accessibility || !perm.input_monitoring || !st.capturing;
  const dot = document.getElementById("dev-dot");
  if (dot) { dot.hidden = !bad; dot.title = st.paused ? "已暂停" : "没在记录或缺权限"; }
  const pf = S.profile || { name: "我" };
  const av = document.getElementById("me-avatar");
  if (av) av.innerHTML = avatarHtml(pf);
  const nm = document.getElementById("me-name");
  if (nm) nm.textContent = pf.name || "我";
  const sub = document.getElementById("me-sub");
  if (sub) sub.textContent = st.paused ? " · 已暂停" : !perm.accessibility || !perm.input_monitoring ? " · 缺权限" : st.capturing ? " · 记录中" : " · 没在记录";
  renderMeMenu();
}

/** 头像：有图片用图片，没有用名字第一个字 */
const avatarHtml = (pf) => (pf && pf.avatar ? `<img src="${esc(pf.avatar)}" alt="">` : esc(((pf && pf.name) || "我").trim().slice(0, 1).toUpperCase()));

// ---------- 左下角菜单（照 Claude） ----------

// 图标：Lucide（ISC 许可，见 app/THIRD_PARTY_NOTICES.md），24 格画布、细线
const lu = (paths) => `<svg class="mx-ico lu" viewBox="0 0 24 24">${paths}</svg>`;
const MI = {
  gear: lu('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  pause: lu('<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'),
  play: lu('<path d="M6 3l14 9-14 9z"/>'),
  devices: lu('<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/>'),
  folder: lu('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  info: lu('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  quit: lu('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
};

function renderMeMenu() {
  const menu = document.getElementById("me-menu");
  if (!menu) return;
  const st = S.status || {};
  menu.innerHTML = `<div class="mx-menu-group">${esc((S.sync && S.sync.email) || (st.device || "").replace(/^mac-/, "Mac · "))}</div>
    <button role="menuitem" data-me="settings">${MI.gear}设置<span class="mx-menu-val">⌘,</span></button>
    ${st.paused
      ? `<button role="menuitem" data-me="resume">${MI.play}继续记录${st.paused_until ? `<span class="mx-menu-val">${hm(st.paused_until)} 自动继续</span>` : ""}</button>`
      : `<button role="menuitem" data-me="pause">${MI.pause}暂停记录 1 小时</button>`}
    <button role="menuitem" data-me="devices">${MI.devices}设备与同步</button>
    <button role="menuitem" data-me="data">${MI.folder}打开数据目录</button>
    <hr>
    <button role="menuitem" disabled>${MI.info}版本<span class="mx-menu-val">${esc(st.version || "")}</span></button>
    <hr>
    <button role="menuitem" data-me="quit">${MI.quit}退出 Beayy</button>`;
}

function toggleMe(open) {
  const menu = document.getElementById("me-menu"), btn = document.getElementById("me");
  if (!menu) return;
  menu.hidden = open === undefined ? !menu.hidden : !open;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
}

document.getElementById("me").onclick = (e) => { e.stopPropagation(); toggleMe(); };
document.getElementById("me-menu").onclick = async (e) => {
  const b = e.target.closest("[data-me]"); if (!b) return;
  toggleMe(false);
  const k = b.dataset.me;
  if (k === "settings") location.hash = "#/settings";
  else if (k === "devices") location.hash = "#/devices";
  else if (k === "data") call("open_data_dir");
  else if (k === "quit") call("quit_app");
  else { await call("set_paused", k === "pause" ? { paused: true, minutes: 60 } : { paused: false }); S.status = await call("get_status"); renderSide(); if (S.page === "settings" || S.page === "devices") route(); }
};
document.addEventListener("click", (e) => { if (!e.target.closest(".me-wrap")) toggleMe(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleMe(false);
  if (e.metaKey && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
});

function markNav(page) {
  document.querySelectorAll("#nav a, .me").forEach((a) => a.classList.toggle("is-on", a.dataset.page === page));
}

// ---------- 今天 ----------

async function renderToday() {
  const today = localDay();
  // 今天总有实时数据（电脑来自自采事件，手机来自 iPhone 同步），不再等每晚的数据包
  const d = (await call("get_day", { date: today })) || { date: today };
  const pack = d.pack || {}, c = d.live || pack.computer || {}, ph = d.phone;
  const fda = ((S.status || {}).permissions || {}).full_disk_access;
  const phoneCap = ph ? `同步至 ${mdhm(ph.synced_until)}` : fda === false ? "未授权完全磁盘访问" : "取不到";
  const hc = hourMinutes(c.active_hours || {});
  const hp = hourMinutes(ph ? ph.hours : (pack.phone || {}).hours);
  const items = timelineItems(d);
  const counts = { all: items.length, computer: items.filter((x) => x.dev === "computer").length, phone: items.filter((x) => x.dev === "phone").length };
  const tab = TL.tab in counts ? TL.tab : "all";
  const shown = items.filter((x) => tab === "all" || x.dev === tab);
  // 照 Claude：标题下一行，左边「概览｜时间线」纯文字页签；时间线后面接「全部／电脑／手机」切换块；右边放同步时刻
  const view = TL.view === "timeline" ? "timeline" : "overview";
  const seg = `<div class="mx-seg" role="tablist" id="tl-tabs">${[["all", "全部"], ["computer", "电脑"], ["phone", "手机"]].map(([k, v]) =>
    `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? "is-on" : ""}" data-tab="${k}">${v}<span class="n">${counts[k]}</span></button>`).join("")}</div>`;
  const toolbar = `<div class="toolbar"><div class="toolbar-left"><div class="tabs" role="tablist" id="view-tabs">${[["overview", "概览"], ["timeline", "时间线"]].map(([k, v]) =>
      `<button role="tab" aria-selected="${k === view}" class="${k === view ? "is-on" : ""}" data-view="${k}">${v}</button>`).join("")}</div>
      ${view === "timeline" ? `<span class="tb-sep"></span>${seg}` : ""}</div>
    <div class="toolbar-right">${ph ? `<span class="note">手机同步到 ${hm(ph.synced_until)}</span>` : ""}</div></div>`;
  const overview = `<div class="readouts">
        ${readout("在电脑前", hh(c.active_sec), "h", c.first ? `${c.first}–${c.last}` : "还没有记录")}
        ${readout("手机", ph || fda !== false ? hh(ph ? ph.total_sec : (pack.phone || {}).total_sec) : "—", "h", phoneCap)}
        ${readout("切换", c.switches ?? "—", "次", "应用之间切换")}
      </div>
      <div style="margin-top:var(--space-6)">`
    + section("一天的形状", dayStrip(hc, hp, true) + `<div class="legend"><span><i style="background:var(--rec-computer)"></i>电脑（上排）</span><span><i style="background:var(--rec-phone)"></i>手机（下排）</span><span>点某个小时，到时间线里看那一小时</span></div>`)
    + workSection(d.work) + `</div>`;
  const timeline = shown.length ? `<div class="tl" id="tl">${tab === "all" ? hourRows(d, items) : shown.map(tlRow).join("")}</div>`
    : emptyInline(tab === "phone" ? "今天还没有手机记录。iPhone 的屏幕使用经 iCloud 同步过来，通常晚几个小时。" : "今天还没有记录。10 分钟摘要每个整 10 分过后 1 分钟写好。");

  $app.innerHTML = header("今天", `<span class="note mono">${short(today)}</span>`) + toolbar
    + `<div class="reading">${view === "timeline" ? timeline : overview}</div>`;

  document.getElementById("view-tabs").onclick = (e) => {
    const b = e.target.closest("[data-view]"); if (!b) return;
    TL.view = b.dataset.view;
    try { localStorage.setItem("today-view", TL.view); } catch (err) {}
    renderToday();
  };
  const tlTabs = document.getElementById("tl-tabs");
  if (tlTabs) tlTabs.onclick = (e) => {
    const b = e.target.closest("[data-tab]"); if (!b) return;
    TL.tab = b.dataset.tab;
    try { localStorage.setItem("tl-tab", TL.tab); } catch (err) {}
    renderToday();
  };
  // 点一天的形状里的某个小时：切到时间线，滚到那个小时
  $app.querySelectorAll(".strip [data-h]").forEach((cell) => (cell.onclick = () => {
    TL.view = "timeline"; TL.jump = +cell.dataset.h;
    renderToday();
  }));
  if (view === "timeline" && TL.jump != null) {
    const h = TL.jump; TL.jump = null;
    const rows = [...$app.querySelectorAll("#tl > [data-h]")];
    const hit = rows.filter((r) => +r.dataset.h === h).pop() || rows.find((r) => +r.dataset.h < h);
    if (hit) {
      hit.scrollIntoView({ block: "center" });
      hit.classList.remove("flash"); void hit.offsetWidth; hit.classList.add("flash");
    }
  }
  loadIcons();
}

// ---------- 时间花在哪：按项目、按类型（10 分钟摘要里模型给的标签 × 在电脑前的秒数） ----------

function workSection(w) {
  if (!w || !((w.domains || []).length || (w.activities || []).length)) return "";
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + "m" : hh(sec) + "h");
  // 两级：一级一条粗横条，下面缩进列二级
  const tree = (rows) => {
    const max = Math.max(...rows.map((r) => r.sec), 1);
    const bar = (r, kid) => `<div class="bar-row${kid ? " kid" : ""}"><span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar"><i style="width:${Math.max(2, Math.round((r.sec / max) * 100))}%"></i></span><span class="bar-v mono">${dur(r.sec)}</span></div>`;
    return `<div class="bars">${rows.map((r) => bar(r, false) + (r.children.length > 1 || (r.children[0] && r.children[0].name !== r.name) ? r.children.slice(0, 6).map((c) => bar(c, true)).join("") : "")).join("")}</div>`;
  };
  return section("时间花在哪", `<div class="work"><div><h4>为了什么（领域 · 项目）</h4>${tree(w.domains || [])}</div><div><h4>在做什么（类型）</h4>${tree(w.activities || [])}</div></div>
    <p class="note">按每 10 分钟摘要判断的领域、项目和类型，乘以那段在电脑前的时间累计；手机不算在内。</p>`);
}

// ---------- 时间线：电脑的 10 分钟摘要和手机的每次拿起，按设备分页签，新的在上 ----------

/** 「全部」页签按小时：每小时一行（小时摘要＋项目＋手机用了多久），点开看这一小时的 10 分钟明细和每次拿起；
 *  连着的「不在电脑前、也没碰手机」的小时合成一行灰字 */
function hourRows(d, items) {
  const hourOf = (iso) => { const t = new Date(iso); t.setMinutes(0, 0, 0); return t.getTime(); };
  const roll = Object.fromEntries((d.hours || []).map((h) => [hourOf(h.start), h]));
  const buckets = new Map();
  for (const x of items) {
    if (x.dev === "computer" && x.seg.kind === "idle") continue; // 合并过的空段按小时摘要算
    const k = hourOf(x.start);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  }
  for (const k of Object.keys(roll)) if (!buckets.has(+k)) buckets.set(+k, []);
  const keys = [...buckets.keys()].sort((a, b) => b - a);
  const now = Date.now();
  const out = [];
  let idleRun = null; // 连着的空小时 [最早, 最晚]
  const flushIdle = () => { if (idleRun) { out.push(`<div class="tl-row computer idle" data-h="${new Date(idleRun[0]).getHours()}"><span class="t">${hm(new Date(idleRun[0]).toISOString())}–${hm(new Date(idleRun[1] + 3600e3).toISOString())}</span><span>不在电脑前</span></div>`); idleRun = null; } };
  for (const k of keys) {
    const xs = buckets.get(k), r = roll[k];
    const comp = xs.filter((x) => x.dev === "computer"), ph = xs.filter((x) => x.dev === "phone");
    const idle = !comp.length && (!r || r.title === "不在电脑前") && k + 3600e3 <= now;
    if (idle && !ph.length) { idleRun = idleRun ? [k, idleRun[1]] : [k, k]; continue; }
    flushIdle();
    const phSec = ph.reduce((a, x) => a + x.ses.sec, 0);
    const phApps = {};
    for (const x of ph) for (const a of x.ses.apps) phApps[a.name] = (phApps[a.name] || 0) + a.sec;
    const topPh = Object.entries(phApps).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join("、");
    const latest = comp[0] && comp[0].seg;
    const title = r && r.title !== "不在电脑前" ? r.title : comp.length ? (k + 3600e3 > now ? `进行中：${latest.title}` : latest.title) : "不在电脑前";
    const desc = r && r.title !== "不在电脑前" ? r.description : comp.length && k + 3600e3 > now ? latest.description : "";
    // 项目：小时摘要里按秒累计好的，没有（进行中）就用这几段的
    const pj = {};
    for (const p of (r && r.parts) || []) if (p.project) pj[p.project] = (pj[p.project] || 0) + p.sec;
    if (!r) for (const x of comp) for (const p of x.seg.parts || []) if (p.project) pj[p.project] = (pj[p.project] || 0) + (x.seg.active_sec || 0) * p.share;
    const chips = Object.entries(pj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `<span class="mx-tag">${esc(n)} ${Math.round(v / 60)}m</span>`).join("");
    const inner = xs.sort((a, b) => (a.start < b.start ? 1 : -1)).map(tlRow).join("");
    out.push(`<details class="tl-row hour" data-h="${new Date(k).getHours()}"><summary><span class="t">${hm(new Date(k).toISOString())}–${hm(new Date(k + 3600e3).toISOString())}</span><span>
        <span class="name${title === "不在电脑前" ? " dim" : ""}">${esc(title)}</span>${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
        ${chips ? `<div class="chips">${chips}</div>` : ""}${phSec ? `<div class="ph-line">手机 ${minText(phSec)}${topPh ? ` · ${esc(topPh)}` : ""}</div>` : ""}</span>
        ${inner ? `<span class="chev">${ICON.chevR}</span>` : "<span></span>"}</summary>${inner ? `<div class="hour-in">${inner}</div>` : ""}</details>`);
  }
  flushIdle();
  return out.join("");
}


const TL = {
  tab: (() => { try { return localStorage.getItem("tl-tab") || "all"; } catch (e) { return "all"; } })(),
  view: (() => { try { return localStorage.getItem("today-view") || "overview"; } catch (e) { return "overview"; } })(),
  jump: null,
};
const localHour = (iso) => +hm(iso).slice(0, 2);
/** 系统界面这类不是「在用的 app」，不画图标 */
const NOT_APPS = new Set(["com.apple.dock", "com.apple.loginwindow", "com.apple.notificationcenterui", "com.apple.controlcenter", "com.apple.Spotlight", "com.apple.systemuiserver", "com.apple.WindowManager", "org.p0deje.Maccy"]);

function timelineItems(d) {
  const out = [];
  for (const s of d.segments || []) out.push({ dev: "computer", start: s.start, end: s.end, seg: s });
  for (const x of (d.phone && d.phone.sessions) || []) out.push({ dev: "phone", start: x.start, end: x.end, ses: x });
  return out.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}

const minText = (sec) => (sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`);

function icons(ids, phone, names = {}) {
  const list = ids.filter((b) => b && !NOT_APPS.has(b)).slice(0, 10);
  if (!list.length) return "";
  return `<div class="apps">${list.map((b) => {
    const name = names[b] || b.split(".").pop();
    return `<span class="ico" data-b="${esc(b)}" data-p="${phone ? 1 : 0}" title="${esc(name)}">${esc((name[0] || "?").toUpperCase())}</span>`;
  }).join("")}</div>`;
}

function tlRow(x) {
  const t = `<span class="t">${hm(x.start)}–${hm(x.end)}</span>`;
  const h = `data-h="${localHour(x.start)}"`;
  if (x.dev === "phone") {
    const s = x.ses;
    const names = Object.fromEntries(s.apps.map((a) => [a.bundle_id, a.name]));
    if (s.kind === "brief") return `<div class="tl-row phone brief" ${h}>${t}<span><span class="name">手机 · 拿起 ${s.count} 次，共 ${minText(s.sec)}</span>${icons(s.apps.map((a) => a.bundle_id), true, names)}</span></div>`;
    const top = s.apps.filter((a) => a.sec >= 5).slice(0, 4).map((a) => `${esc(a.name)} ${minText(a.sec)}`).join("、");
    return `<div class="tl-row phone" ${h}>${t}<span><span class="name">手机 · ${minText(s.sec)}</span>${top ? `<div class="desc">${top}</div>` : ""}${icons(s.apps.map((a) => a.bundle_id), true, names)}</span></div>`;
  }
  const s = x.seg;
  // 连续的「不在电脑前」已由 Rust 合成一段：一行灰字，不能展开
  if (s.kind === "idle") return `<div class="tl-row computer idle" ${h}>${t}<span>${esc(s.title)}</span></div>`;
  const ctx = (s.context || []).filter((y) => !y.includes("/Users/"));
  const more = [
    ctx.length ? `<div><h4>涉及</h4>${md(ctx.map((y) => "- " + y).join("\n"))}</div>` : "",
    s.recording ? `<div><h4>经过</h4>${md(s.recording)}</div>` : s.memory ? `<div><h4>经过</h4>${md(s.memory)}</div>` : "",
  ].join("");
  const tag = s.kind === "6h" ? `<span class="mx-tag">6 小时</span>` : s.source === "codex" ? `<span class="mx-tag">Codex</span>` : "";
  return `<details class="tl-row computer" ${h}><summary>${t}<span><span class="name">${esc(s.title || "（没有标题）")}${tag}</span>${s.description ? `<div class="desc">${esc(s.description)}</div>` : ""}${icons(s.apps || [], false)}</span>${more ? `<span class="chev">${ICON.chevR}</span>` : "<span></span>"}</summary>${more ? `<div class="more">${more}</div>` : ""}</details>`;
}

/** 先画首字母，图标取到后换上（手机 app 第一次要联网查，之后走缓存） */
const ICONS = { 0: {}, 1: {} };
async function loadIcons() {
  for (const p of [0, 1]) {
    const els = [...$app.querySelectorAll(`.ico[data-p="${p}"]`)];
    const need = [...new Set(els.map((e) => e.dataset.b))].filter((b) => !(b in ICONS[p]));
    if (need.length && TAURI) Object.assign(ICONS[p], await call("get_icons", { ids: need, phone: !!p }).catch(() => ({})));
    for (const e of $app.querySelectorAll(`.ico[data-p="${p}"]`)) {
      const got = ICONS[p][e.dataset.b];
      // 名字表里没有的 app，用 App Store 上的名字
      if (got && got.name && e.title === e.dataset.b.split(".").pop()) e.title = got.name;
      if (got && got.icon && !e.querySelector("img")) { e.textContent = ""; e.classList.add("has-img"); const img = new Image(); img.src = got.icon; img.alt = ""; e.appendChild(img); }
    }
  }
}

// ---------- 日总结 ----------

const SUM = { err: null };

async function renderSummary(arg) {
  const dates = S.days.map((x) => x.date);
  const date = dates.includes(arg) ? arg : dates[0];
  if (!date) { $app.innerHTML = header("总结") + emptyInline("还没有日数据。"); return; }
  markNav("summary");
  const i = dates.indexOf(date);
  const prev = dates[i + 1], next = dates[i - 1];
  const d = await call("get_day", { date });
  const idx = S.days[i];
  const pack = (d && d.pack) || {}, ph = (d && d.phone) || null;
  // 还没有数据包（通常是今天）：电脑读数用自采事件实时算的
  const c = pack.computer && pack.computer.active_sec != null && !pack.partial ? pack.computer : (d && d.live) || pack.computer || {};
  const pp = pack.phone || {};
  // 熬夜＝这一晚：当天 21:00 以后＋次日 0–5 点（规格/日总结.md：凌晨 0–5 点属于前一晚），电脑和手机分别算再相加
  const nd = addDays(date, 1);
  const n = dates.includes(nd) ? await call("get_day", { date: nd }) : null;
  const npack = (n && n.pack) || {};
  const lateC = c.late_sec ?? secsAfter((d && d.live && d.live.spans) || [], date, 21);
  const lateP = ph ? ph.late_sec || 0 : pp.late_sec || 0;
  const dawnP = n ? (n.phone ? n.phone.night_sec || 0 : (npack.phone || {}).dawn_sec || 0) : 0;
  const dawnC = n ? hourSecs((n.live && n.live.active_hours) ? n.live : npack.computer).slice(0, 5).reduce((a, b) => a + b, 0) : 0;
  const night = Math.round((lateC + lateP + dawnP + dawnC) / 60);
  const hasNight = c.late_sec != null || (d && d.live) || ph || pp.late_sec != null;
  const sum = d && d.summary_md ? splitSummary(d.summary_md) : null;

  const right = `<button class="mx-iconbtn" id="prev" aria-label="前一天" title="前一天" ${prev ? "" : "disabled"}>${ICON.chevL}</button>
    <button class="mx-iconbtn" id="next" aria-label="后一天" title="后一天" ${next ? "" : "disabled"}>${ICON.chevR}</button>
    <div class="pick"><button class="mx-btn mx-btn--secondary mono" id="pick" aria-haspopup="menu" aria-expanded="false">${short(date)}${ICON.chevD}</button>
      <div class="mx-menu" role="menu" id="pick-menu" hidden>${dates.map((x) => `<button role="menuitemradio" aria-checked="${x === date}" data-date="${x}">${short(x)}${x === date ? `<span class="mx-check">${ICON.check}</span>` : ""}</button>`).join("")}</div></div>`;

  // 最近 14 天：截至这一天
  const byDate = Object.fromEntries(S.days.map((x) => [x.date, x]));
  const rows = Array.from({ length: 14 }, (_, k) => {
    const ymd = addDays(date, k - 13), x = byDate[ymd];
    return { date: ymd, has: !!x, hc: hourMinutes(x && x.hc), hp: hourMinutes(x && x.hp) };
  });
  const after = byDate[nd];
  if (after) rows[rows.length - 1].next = { hc: hourMinutes(after.hc), hp: hourMinutes(after.hp) };

  // 布局照 Claude「自定义」页：标题单独一行；下面一行左边 日／周／月 页签（周、月后续做），右边翻日期
  const kinds = `<div class="tabs" role="tablist"><button role="tab" aria-selected="true" class="is-on">日</button><button role="tab" aria-selected="false" disabled title="后续做">周</button><button role="tab" aria-selected="false" disabled title="后续做">月</button></div>`;
  $app.innerHTML = header("总结") + `<div class="toolbar">${kinds}<div class="toolbar-right">${right}</div></div>` + `<div class="reading">
    <div class="readouts">
      ${readout("在电脑前", hh(c.active_sec ?? idx.active_sec), "h", c.first ? `${c.first}–${c.last}` : "取不到")}
      ${readout("手机", hh(ph ? ph.total_sec : pp.total_sec ?? idx.phone_sec), "h", ph ? `同步至 ${mdhm(ph.synced_until)}` : pp.synced_at ? `同步至 ${pp.synced_at.slice(5)}` : "取不到")}
      ${readout("拿起", ph ? ph.pickups : pp.pickups ?? "—", "次", "按前台空档推算")}
      ${readout("熬夜", hasNight ? night : "—", "分钟", "21:00 后到次日 5 点", night > 10)}
    </div>
    ${sum && sum.note ? `<p class="note" style="margin:var(--space-3) 0 0">${esc(sum.note)}</p>` : ""}
    <div style="margin-top:var(--space-6)">
      ${sum ? sum.parts.map((p) => section(p.title, p.title === "今天的一句话" ? `<p class="quote">${esc(p.body)}</p>` : md(p.body))).join("")
            : section("这一天", `<div class="gen-empty"><p class="mx-empty-inline">这一天还没有日总结。每天 21:30 会自动写当天的，第二天凌晨再用完整的一天重写一次；也可以现在就生成一份。</p>
                <button class="mx-btn mx-btn--primary mx-btn--sm" id="gen-daily">现在生成</button>${SUM.err ? `<div class="mx-field-error">${esc(SUM.err)}</div>` : ""}</div>`)}
      ${section("最近 14 天", actogram(rows, date), { aside: "点日期翻到那一天" })}
    </div></div>`;

  const gen = document.getElementById("gen-daily");
  if (gen) gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "生成中…"; SUM.err = null;
    try { await call("generate_daily", { date }); } catch (x) { SUM.err = String(x); }
    renderSummary(date);
  };
  const go = (x) => { if (x) location.hash = `#/summary/${x}`; };
  document.getElementById("prev").onclick = () => go(prev);
  document.getElementById("next").onclick = () => go(next);
  const pick = document.getElementById("pick"), menu = document.getElementById("pick-menu");
  pick.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; pick.setAttribute("aria-expanded", String(!menu.hidden)); };
  menu.onclick = (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.date); };
}

// ---------- 规矩 ----------

const RS = { adding: false, editing: null, deleting: null };

/** 把一条规矩识别成能算的三类；识别不了返回 null（交给日总结对照）
 *  after：几点以后不用（电脑／手机／都不用）；limit：某设备每天不超过多久；app：某个 app 每天不超过多久 */
function parseRule(text) {
  const t = String(text).replace(/\s+/g, "");
  const dev = /电脑|mac/i.test(t) ? "computer" : /手机|iphone/i.test(t) ? "phone" : "any";
  let m = t.match(/(\d{1,2})(?:[:：点](\d{2})?)?(?:分)?(?:以后|之后|后)/);
  if (m && /不|别|停|关|禁/.test(t)) return { kind: "after", dev, h: +m[1] + (+m[1] < 12 && /晚上|夜里|夜间|下午|傍晚/.test(t) ? 12 : 0), m: +(m[2] || 0) };
  m = t.match(/(不超过|少于|最多|以内|不到|≤|<=?)(\d+(?:\.\d+)?)(小时|h|分钟|min|分)/i) || t.match(/(\d+(?:\.\d+)?)(小时|h|分钟|min|分)(以内|以下)/i);
  if (m) {
    const [num, unit] = /\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[3]];
    const minutes = +num * (/小时|h/i.test(unit) ? 60 : 1);
    const subject = t.split(/每天|一天|每日|不超过|少于|最多|不到/)[0].replace(/^(用|玩|刷|看)/, "");
    if (dev !== "any" && /^(用|玩|刷|看)?(电脑|手机|mac|iphone)?$/i.test(subject)) return { kind: "limit", dev, minutes };
    if (subject) return { kind: "app", app: subject.replace(/^(用|玩|刷|看)/, ""), minutes };
  }
  return null;
}

/** 用今天的实时数据对照一条规矩：{label: 对照什么, value: 今天多少, ok: 是否守住（null＝还没到点）} */
function checkRule(r, d) {
  if (!d) return null;
  const live = d.live || {}, ph = d.phone || {};
  const dayStart = toDate(d.date).getTime();
  const overlap = (a, b, from) => Math.max(0, Math.min(b, dayStart + 864e5) - Math.max(a, from)) / 1000;
  if (r.kind === "after") {
    const from = dayStart + (r.h * 60 + r.m) * 6e4;
    const when = `${pad2(r.h)}:${pad2(r.m)}`;
    const what = r.dev === "phone" ? "用手机" : r.dev === "computer" ? "用电脑" : "用电脑和手机";
    if (Date.now() < from) return { label: `还没到 ${when}`, value: "", ok: null };
    let sec = 0;
    if (r.dev !== "phone") for (const [a, b] of live.spans || []) sec += overlap(Date.parse(a), Date.parse(b), from);
    if (r.dev !== "computer") for (const x of ph.sessions || []) { const a = Date.parse(x.start), b = Date.parse(x.end); sec += b > a ? (overlap(a, b, from) / ((b - a) / 1000)) * x.sec : 0; }
    return { label: `${when} 以后${what}`, value: `${Math.round(sec / 60)} 分钟`, ok: sec < 60 };
  }
  if (r.kind === "limit") {
    const sec = r.dev === "phone" ? ph.total_sec || 0 : live.active_sec || 0;
    return { label: `今天${r.dev === "phone" ? "手机" : "电脑"}`, value: `${hh(sec)} / ${+(r.minutes / 60).toFixed(1)} 小时`, ok: sec <= r.minutes * 60 };
  }
  if (r.kind === "app") {
    const key = r.app.toLowerCase();
    const hit = (x) => (x.name || "").toLowerCase().includes(key) || (x.bundle_id || "").toLowerCase().includes(key);
    let sec = 0;
    for (const x of ph.sessions || []) for (const a of x.apps) if (hit(a)) sec += a.sec;
    for (const a of live.apps || []) if (hit(a)) sec += a.sec;
    return { label: `今天${r.app}（电脑和手机）`, value: `${Math.round(sec / 60)} / ${r.minutes} 分钟`, ok: sec <= r.minutes * 60 };
  }
  return null;
}

async function renderRules() {
  if (!S.rules) S.rules = await call("get_rules");
  const rules = S.rules;
  const today = await call("get_day", { date: localDay() }).catch(() => null);
  const verdict = (r) => {
    if (r.enabled === false) return `<div class="verdict muted">暂不对照</div>`;
    const c = checkRule(parseRule(r.text) || {}, today);
    if (!c) return `<div class="verdict muted">这条算不出来，交给日总结对照</div>`;
    return `<div class="verdict ${c.ok === null ? "muted" : c.ok ? "ok" : "over"}"><span>${esc(c.label)}</span>${c.value ? `<b>${esc(c.value)}</b>` : ""}${c.ok === null ? "" : c.ok ? ` · 守住了` : ` · 没守住`}</div>`;
  };
  const editor = (id, text, saveTitle) => `<div class="editor" data-id="${id}">
      <textarea class="mx-input" placeholder="用自己的话写一条规矩" aria-label="规矩">${esc(text)}</textarea>
      <div class="mx-form-actions"><button class="mx-btn mx-btn--text" data-act="cancel">取消</button><button class="mx-btn mx-btn--secondary" data-act="save">${saveTitle}</button></div></div>`;
  const row = (r, i) => RS.editing === r.id ? editor(r.id, r.text, "保存改动") : `<div class="rule${r.enabled === false ? " off" : ""}" data-id="${r.id}">
      <div class="mx-row"><span class="mx-row-mark mono">${i + 1}</span>
        <div class="mx-row-main"><div class="mx-row-name">${esc(r.text)}</div>${verdict(r)}</div>
        <div class="acts"><button class="mx-btn mx-btn--text mx-btn--sm" data-act="edit">改</button><button class="mx-btn mx-btn--text mx-btn--sm" data-act="delete">删除</button></div>
        <button class="mx-switch" role="switch" aria-checked="${r.enabled !== false}" aria-label="对照这条" title="${r.enabled !== false ? "日总结对照这条" : "暂不对照"}" data-act="toggle"></button>
      </div>
      ${RS.deleting === r.id ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>删除这条规矩？</b><span>删除后日总结不再对照它，删了找不回来。</span></div><button class="mx-btn mx-btn--secondary" data-act="keep">取消</button><button class="mx-btn mx-btn--danger" data-act="remove">删除这条</button></div>` : ""}
    </div>`;
  $app.innerHTML = header("规矩", `<button class="mx-btn mx-btn--primary" id="add" ${RS.adding ? "disabled" : ""}>加一条规矩</button>`)
    + `<div class="reading" id="rules">
      ${RS.adding ? editor("new", "", "加上这条") : ""}
      ${rules.length ? rules.map(row).join("") : RS.adding ? "" : emptyInline("用自己的话写下想守的规矩，比如「21:00 以后不开电脑」「手机每天不超过 3 小时」「抖音每天不超过 30 分钟」。这三类会用今天的数据当场对照，别的写法交给日总结逐条对照。")}
    </div>`;
  const save = async () => { await call("save_rules", { rules: S.rules }); renderRules(); };
  document.getElementById("add").onclick = () => { RS.adding = true; RS.editing = RS.deleting = null; renderRules(); };
  const ta = $app.querySelector(".editor textarea");
  if (ta) { ta.focus(); ta.onkeydown = (e) => { if (e.key === "Escape") { RS.adding = false; RS.editing = null; renderRules(); } if (e.key === "Enter" && e.metaKey) ta.closest(".editor").querySelector('[data-act="save"]').click(); }; }
  const keepBtn = $app.querySelector('[data-act="keep"]');
  if (keepBtn) keepBtn.focus();
  document.getElementById("rules").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const box = b.closest("[data-id]"), id = box.dataset.id, act = b.dataset.act;
    if (act === "cancel") { RS.adding = false; RS.editing = null; return renderRules(); }
    if (act === "save") {
      const text = box.querySelector("textarea").value.trim(); if (!text) return box.querySelector("textarea").focus();
      if (id === "new") { S.rules.unshift({ id: "r" + Date.now().toString(36), text, enabled: true }); RS.adding = false; }
      else { S.rules.find((r) => r.id === id).text = text; RS.editing = null; }
      return save();
    }
    if (act === "edit") { RS.editing = id; RS.adding = false; RS.deleting = null; return renderRules(); }
    if (act === "delete") { RS.deleting = id; return renderRules(); }
    if (act === "keep") { RS.deleting = null; return renderRules(); }
    if (act === "remove") { S.rules = S.rules.filter((r) => r.id !== id); RS.deleting = null; return save(); }
    if (act === "toggle") { const r = S.rules.find((x) => x.id === id); r.enabled = r.enabled === false; return save(); }
  };
  $app.onkeydown = (e) => { if (e.key === "Escape" && RS.deleting) { RS.deleting = null; renderRules(); } };
}

// ---------- 设备：绑定的电脑和手机，各自的记录状态 ----------

const DS = { open: null, adding: false, msg: null, err: null, busy: false, account: null, removing: null };
const DEV_ICON = {
  mac: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  win: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  iphone: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
};
const bytesText = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
const numText = (n) => Number(n || 0).toLocaleString("en-US");

async function renderDevices() {
  const [devs, st, sy] = await Promise.all([call("list_devices").catch(() => []), call("get_status"), call("sync_status").catch(() => ({}))]);
  // 登录着的设备：进页面取一次，失败（没网、令牌失效）就不显示
  if (sy.email && !sy.need_login && !DS.account) { DS.account = {}; call("account_info").then((a) => { DS.account = a; if (S.page === "devices") renderDevices(); }).catch(() => {}); }
  S.status = st; renderSide();
  const perm = st.permissions || {};
  const m = String(st.phone_sync || "").match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  const permRow = (kind, name, desc) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>
    <span class="mx-status mx-status--${perm[kind] ? "ok" : "warn"}">${perm[kind] ? "已授权" : "未授权"}</span>${perm[kind] ? "" : `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-perm="${kind}">去授权</button>`}</div>`;
  const status = (d) => {
    if (d.this) {
      const missing = !perm.accessibility || !perm.input_monitoring;
      const [cls, text] = st.paused ? ["", st.paused_until ? `已暂停，${hm(st.paused_until)} 自动继续` : "已暂停"] : missing ? ["warn", "缺权限，展开去授权"] : st.capturing ? ["ok", "记录中"] : ["", "没在记录"];
      return `<span class="dot ${cls}"></span>${text} · 今天已记 ${numText(st.events_today)} 条`;
    }
    if (d.kind === "iphone") return `<span class="dot ok"></span>经 iCloud 同步，记录到 ${mdhm(m ? m[0] : d.last)}`;
    return `最近一条 ${mdhm(d.last)}`;
  };
  const detail = (d) => {
    const base = `<dl class="kv"><dt>记录从</dt><dd>${mdhm(d.first)}</dd><dt>最近一条</dt><dd>${mdhm(d.last)}</dd><dt>共</dt><dd>${numText(d.events)} 条 · ${bytesText(d.bytes)}</dd><dt>设备编号</dt><dd class="mono">${esc(d.id)}</dd></dl>`;
    if (d.this) return base + `<div class="dev-sub">记什么：切换 app 和窗口、键盘输入和发送、点击、滚动、界面文字、在不在电脑前。每 10 分钟写一段摘要。</div>`
      + `<h4 class="dev-h">权限</h4>` + permRow("accessibility", "辅助功能", "读输入框内容、点中的元素、窗口标题。")
      + permRow("input_monitoring", "输入监控", "被动监听键盘和鼠标，只用来计时和判断是人还是代理在操作。")
      + permRow("full_disk_access", "完全磁盘访问", "读 iPhone 同步到这台电脑的屏幕使用记录。");
    if (d.kind === "iphone") return base + `<div class="dev-sub">记什么：每个 app 什么时候在前台、用了多久（看不到 app 里的内容）。来源是 iPhone 的屏幕使用时间，经 iCloud 同步到这台 Mac，每 5 分钟读一次，通常晚几个小时。</div>`;
    return base;
  };
  const adding = `<div class="add-dev">
      <div class="add-opt">${DEV_ICON.iphone}<div><b>iPhone</b><span>不用装 app。iPhone 上打开 设置 → 屏幕使用时间 →「跨设备共享」，用同一个 Apple 账号，这台 Mac 就能读到。</span></div></div>
      <div class="add-opt">${DEV_ICON.mac}<div><b>另一台 Mac</b><span>装上 Beayy，在设置里用同一个账号登录，记录就会同步过来，出现在下面的列表里。</span></div></div>
      <div class="add-opt">${DEV_ICON.win}<div><b>Windows 电脑</b><span>Windows 版还没有安装包（代码能编译，没在真机上测过）。</span></div></div>
    </div>`;
  $app.innerHTML = header("设备", `<button class="mx-btn mx-btn--${DS.adding ? "secondary" : "primary"}" id="add-dev">${DS.adding ? "收起" : "添加设备"}</button>`)
    + `<div class="reading">${DS.adding ? adding : ""}${syncCard(sy)}<div class="devs">${devs.map((d) => `<div class="dev${DS.open === d.id ? " open" : ""}" data-id="${esc(d.id)}">
        <button class="dev-head" aria-expanded="${DS.open === d.id}"><span class="dev-ico">${DEV_ICON[d.kind] || DEV_ICON.mac}</span>
          <span class="dev-main"><span class="dev-name">${esc(d.name)}${d.this ? `<span class="mx-tag">本机</span>` : ""}${d.synced ? `<span class="mx-tag">经同步</span>` : ""}</span><span class="dev-status">${status(d)}</span></span>
          <span class="chev">${ICON.chevR}</span></button>
        ${DS.open === d.id ? `<div class="dev-body">${detail(d)}</div>` : ""}</div>`).join("") || emptyInline("还没有设备的记录。")}</div></div>`;
  document.getElementById("add-dev").onclick = () => { DS.adding = !DS.adding; renderDevices(); };
  $app.querySelectorAll(".dev-head").forEach((b) => (b.onclick = () => { const id = b.closest(".dev").dataset.id; DS.open = DS.open === id ? null : id; renderDevices(); }));
  $app.querySelectorAll("[data-perm]").forEach((b) => (b.onclick = () => call("open_permission", { kind: b.dataset.perm })));
  bindSync();
}

/** 多设备同步：按账号。登录了就显示同步状态和「登录着的设备」（可移除）；没登录就引导去设置里登录 */
function syncCard(sy) {
  if (sy.shadow) return "";
  const msg = DS.err ? `<div class="mx-field-error">${esc(DS.err)}</div>` : DS.msg ? `<p class="note">${esc(DS.msg)}</p>` : "";
  if (!sy.configured) return `<section class="sync-card"><div class="sync-head"><b>多设备同步</b><span class="mx-status">没登录</span></div>
      <p class="note">登录账号后，这台电脑和 iPhone 的记录在本机加密后同步到云端，别的电脑登录同一个账号就能看到。服务器只存加密后的数据，读不到内容。</p>
      <div class="btns sync-btns"><a class="mx-btn mx-btn--primary mx-btn--sm" href="#/settings">去登录或注册</a></div></section>`;
  if (!sy.email) return `<section class="sync-card"><div class="sync-head"><b>多设备同步</b><span class="mx-status mx-status--warn">要设账号</span></div>
      <p class="note">这台电脑用的是早期的配对码账号。到设置里设好邮箱和主密码，别的设备用邮箱登录就行，已经同步的数据不用重传。</p>
      <div class="btns sync-btns"><a class="mx-btn mx-btn--primary mx-btn--sm" href="#/settings">去设置</a></div></section>`;
  if (sy.need_login) return `<section class="sync-card"><div class="sync-head"><b>多设备同步</b><span class="mx-status mx-status--warn">要重新登录</span></div>
      <p class="note">这台电脑的登录已经失效（在别的设备上用恢复码重设了主密码，或者把这台移除了）。重新登录后接着同步。</p>
      <div class="btns sync-btns"><a class="mx-btn mx-btn--primary mx-btn--sm" href="#/settings">重新登录</a></div></section>`;
  const sessions = (DS.account && DS.account.sessions) || [];
  const me = DS.account && DS.account.session;
  return `<section class="sync-card"><div class="sync-head"><b>多设备同步</b><span class="mx-status mx-status--${sy.last_error ? "warn" : "ok"}">${sy.running || DS.busy ? "同步中…" : sy.last_error ? "上次有错" : "已开"}</span></div>
      <p class="note">${esc(sy.email)} · ${sy.last ? `上次 ${mdhm(sy.last)}` : "还没同步过"} · 已传 ${numText(sy.uploaded)} 段 · 每 5 分钟一轮</p>
      ${sy.last_error ? `<div class="mx-field-error">${esc(sy.last_error)}</div>` : ""}
      ${sessions.length ? `<div class="sess"><div class="sess-h">登录着这个账号的设备</div>${sessions.map((x) => `<div class="sess-row"><span>${esc(x.name || x.device)}${x.id === me ? `<span class="mx-tag">这台</span>` : ""}</span><span class="note">最近 ${mdhm(new Date(x.last_seen).toISOString())}</span>${x.id === me ? "<span></span>" : DS.removing === x.id
        ? `<span class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" data-sess-keep>取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" data-sess-go="${esc(x.id)}">移除</button></span>`
        : `<button class="mx-btn mx-btn--text mx-btn--sm" data-sess="${esc(x.id)}">移除</button>`}</div>`).join("")}</div>` : ""}
      <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="sync-now" ${DS.busy ? "disabled" : ""}>立即同步</button></div>
      ${msg}</section>`;
}

function bindSync() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("sync-now", async () => { DS.busy = true; DS.err = DS.msg = null; renderDevices(); try { const r = await call("sync_now"); DS.msg = `上传 ${r.uploaded} 段，下载 ${r.downloaded} 段${r.errors.length ? "，有错：" + r.errors.join("；") : ""}`; } catch (x) { DS.err = String(x); } DS.busy = false; renderDevices(); });
  $app.querySelectorAll("[data-sess]").forEach((b) => (b.onclick = () => { DS.removing = b.dataset.sess; renderDevices(); }));
  $app.querySelectorAll("[data-sess-keep]").forEach((b) => (b.onclick = () => { DS.removing = null; renderDevices(); }));
  $app.querySelectorAll("[data-sess-go]").forEach((b) => (b.onclick = async () => {
    try { await call("account_remove_device", { id: b.dataset.sessGo }); DS.msg = "已移除。那台设备要重新登录才能再同步。"; } catch (x) { DS.err = String(x); }
    DS.removing = null; DS.account = null; renderDevices();
  }));
}

// ---------- 设置 ----------

const THEMES = [["", "跟随系统"], ["light", "浅色"], ["dark", "深色"]];
const SETTING_KEYS = ["gateway", "model_segment", "repo_path", "blocklist"];
const same = (a, b) => JSON.stringify(SETTING_KEYS.map((k) => a[k])) === JSON.stringify(SETTING_KEYS.map((k) => b[k]));
const KEY_SOURCE = { keychain: "已存（钥匙串）", env: "在用环境变量里的" };
const DELETES = [["15", "最近 15 分钟"], ["60", "最近 1 小时"], ["today", "今天全部"]];
const SS = { deleting: null, deleted: null, advanced: false };
/** 头像和名称：editing 时显示编辑框；draftAvatar＝选了还没保存的头像（null＝用首字母） */
const PF = { editing: false, draftAvatar: undefined, err: null };
/** 项目：merging＝{from, into} 等确认 */
const PJ = { merging: null, err: null, list: null };

function profileRow() {
  const pf = S.profile || { name: "我" };
  if (!PF.editing) return `<div class="mx-setting"><div class="profile"><span class="avatar big">${avatarHtml(pf)}</span><div><div class="mx-setting-name">${esc(pf.name)}</div><div class="mx-setting-desc">${pf.email ? esc(pf.email) : "显示在左下角"}</div></div></div>
      <button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-edit">编辑</button></div>`;
  const shown = PF.draftAvatar === undefined ? pf : { ...pf, avatar: PF.draftAvatar };
  return `<div class="acct pf-edit"><div class="profile"><span class="avatar big">${avatarHtml(shown)}</span>
      <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-pick">换头像</button><button class="mx-btn mx-btn--text mx-btn--sm" id="pf-clear">用名字首字</button><input type="file" id="pf-file" accept="image/*" hidden></div></div>
    <div class="mx-field"><label for="pf-name">名称</label><input class="mx-input" id="pf-name" value="${esc(pf.name)}" maxlength="40"></div>
    ${PF.err ? `<div class="mx-field-error">${esc(PF.err)}</div>` : ""}
    <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary" id="pf-cancel">取消</button><button class="mx-btn mx-btn--primary" id="pf-save">保存</button></div></div>`;
}

/** 选的图片居中裁成方的、缩到 128 像素，转成 JPEG data URL */
function shrinkImage(file) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement("canvas");
      c.width = c.height = 128;
      c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      ok(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => fail("读不了这张图片");
    img.src = URL.createObjectURL(file);
  });
}

function bindProfile() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("pf-edit", () => { PF.editing = true; PF.draftAvatar = undefined; PF.err = null; renderSettings(); });
  on("pf-cancel", () => { PF.editing = false; renderSettings(); });
  on("pf-pick", () => document.getElementById("pf-file").click());
  on("pf-clear", () => { PF.draftAvatar = null; renderSettings(); });
  const file = document.getElementById("pf-file");
  if (file) file.onchange = async () => { if (!file.files[0]) return; try { PF.draftAvatar = await shrinkImage(file.files[0]); } catch (x) { PF.err = String(x); } const n = document.getElementById("pf-name").value; renderSettings().then(() => { document.getElementById("pf-name").value = n; }); };
  on("pf-save", async () => {
    const name = document.getElementById("pf-name").value.trim();
    if (!name) { PF.err = "名称不能空。"; return renderSettings(); }
    const avatar = PF.draftAvatar === undefined ? (S.profile || {}).avatar || null : PF.draftAvatar;
    try { await call("save_profile", { name, avatar }); S.profile = await call("get_profile"); PF.editing = false; PF.err = null; renderSide(); } catch (x) { PF.err = String(x); }
    renderSettings();
  });
}

const DOMAINS = ["工作", "成长", "生活", "健康", "关系", "休闲"];

function projectsSection() {
  const list = PJ.list || [];
  if (!list.length) return "";
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + " 分钟" : hh(sec) + " 小时");
  const byDom = DOMAINS.map((d) => [d, list.filter((p) => p.domain === d)]).filter(([, xs]) => xs.length);
  const rows = byDom.map(([d, xs]) => `<div class="pj-group">${d}</div>` + xs.map((p) => `<div class="pj-row" data-p="${esc(p.name)}">
      <div class="pj-main"><div class="mx-setting-name">${esc(p.name)}</div><div class="mx-setting-desc">累计 ${dur(p.sec)}${p.aliases.length ? ` · 也叫 ${esc(p.aliases.join("、"))}` : ""}</div></div>
      <select class="mx-input pj-dom" aria-label="领域">${DOMAINS.map((x) => `<option ${x === p.domain ? "selected" : ""}>${x}</option>`).join("")}</select>
      <select class="mx-input pj-merge" aria-label="合并到"><option value="">合并到…</option>${list.filter((q) => q.name !== p.name).map((q) => `<option>${esc(q.name)}</option>`).join("")}</select></div>
      ${PJ.merging && PJ.merging.from === p.name ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>把「${esc(p.name)}」合并到「${esc(PJ.merging.into)}」？</b><span>以前和以后记成「${esc(p.name)}」的时间都算到「${esc(PJ.merging.into)}」。之后还能在这里改。</span></div><button class="mx-btn mx-btn--secondary" id="pj-keep">取消</button><button class="mx-btn mx-btn--primary" id="pj-go">合并</button></div>` : ""}`).join("")).join("");
  return section("项目", `<p class="note">项目和它属于哪个领域由摘要自动判断。判断错了在这里改：改领域、把同一件事的不同叫法合并。你改过的，自动判断不会再覆盖。</p><div class="pj">${rows}</div>${PJ.err ? `<div class="mx-field-error">${esc(PJ.err)}</div>` : ""}`);
}

function bindProjects() {
  $app.querySelectorAll(".pj-dom").forEach((sel) => (sel.onchange = async () => {
    try { await call("set_project_domain", { project: sel.closest("[data-p]").dataset.p, domain: sel.value }); PJ.list = await call("list_projects"); } catch (x) { PJ.err = String(x); }
    renderSettings();
  }));
  $app.querySelectorAll(".pj-merge").forEach((sel) => (sel.onchange = () => { if (sel.value) { PJ.merging = { from: sel.closest("[data-p]").dataset.p, into: sel.value }; renderSettings(); } }));
  const keep = document.getElementById("pj-keep"); if (keep) keep.onclick = () => { PJ.merging = null; renderSettings(); };
  const go = document.getElementById("pj-go"); if (go) go.onclick = async () => {
    try { await call("merge_project", PJ.merging); PJ.list = await call("list_projects"); } catch (x) { PJ.err = String(x); }
    PJ.merging = null; renderSettings();
  };
}

/** 账号：mode＝login／signup／recover／claim／password；code＝刚拿到、要给用户看的恢复码 */
const AC = { mode: "login", busy: false, err: null, msg: null, code: null, showCode: false, confirmLogout: false };

function accountSection(sy) {
  return section("账号", profileRow() + accountBody(sy));
}

function accountBody(sy) {
  const err = AC.err ? `<div class="mx-field-error">${esc(AC.err)}</div>` : "";
  const msg = AC.msg ? `<p class="note">${esc(AC.msg)}</p>` : "";
  const f = (id, label, type = "text", ph = "") => `<div class="mx-field"><label for="${id}">${label}</label><input class="mx-input${type === "text" ? "" : " mono"}" id="${id}" type="${type}" autocomplete="off" placeholder="${ph}"></div>`;
  const codeBox = (code) => `<div class="code-box"><code class="mono">${esc(code)}</code><button class="mx-btn mx-btn--secondary mx-btn--sm" id="copy-rc">复制</button></div>
    <p class="note warn-text">恢复码是忘了主密码时找回数据的唯一办法：存进密码管理器或抄在纸上。主密码和恢复码都丢了，云端的数据就再也解不开，我们也帮不了。</p>`;
  if (AC.code) return (`<div class="acct">${codeBox(AC.code)}<div class="btns sync-btns"><button class="mx-btn mx-btn--primary" id="code-done">我已存好</button></div></div>`);
  if (sy.configured && sy.email && !sy.need_login) {
    if (AC.mode === "password") return (`<div class="acct">${f("pw1", "新主密码", "password", "至少 8 位")}${f("pw2", "再输一次", "password")}${err}
      <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary" id="ac-cancel">取消</button><button class="mx-btn mx-btn--primary" id="ac-password" ${AC.busy ? "disabled" : ""}>改主密码</button></div></div>`);
    return (`<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${esc(sy.email)}</div><div class="mx-setting-desc">记录在这台电脑上加密后同步，别的设备用这个邮箱登录。</div></div>
        ${AC.confirmLogout ? `<div class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" id="logout-keep">取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" id="logout-go">退出登录</button></div>` : `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-logout">退出登录</button>`}</div>
      <div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">主密码</div><div class="mx-setting-desc">只在设备上用，不会发给服务器。</div></div><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-to-password">改主密码</button></div>
      <div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">恢复码</div><div class="mx-setting-desc">忘了主密码时用它重设。</div></div><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-show-code">${AC.showCode ? "收起" : "显示"}</button></div>
      ${AC.showCode ? codeBox(AC.showCode) : ""}${msg}${err}`);
  }
  if (sy.configured && !sy.email) return (`<div class="acct"><p class="note">这台电脑用的是早期的配对码账号。设好邮箱和主密码，别的设备用邮箱登录就行；已经同步的 ${numText(sy.uploaded)} 段数据不用重传。</p>
      ${f("em", "邮箱", "text", "you@example.com")}${f("pw1", "主密码", "password", "至少 8 位，记得住又别人猜不到")}${f("pw2", "再输一次", "password")}${err}
      <div class="btns sync-btns"><button class="mx-btn mx-btn--primary" id="ac-claim" ${AC.busy ? "disabled" : ""}>${AC.busy ? "设置中…" : "设好账号"}</button></div></div>`);
  const tabs = `<div class="tabs" role="tablist" id="ac-tabs">${[["login", "登录"], ["signup", "注册"], ["recover", "忘了主密码"]].map(([k, v]) => `<button role="tab" class="${AC.mode === k ? "is-on" : ""}" data-mode="${k}">${v}</button>`).join("")}</div>`;
  const forms = {
    login: f("em", "邮箱", "text", "you@example.com") + f("pw1", "主密码", "password"),
    signup: f("em", "邮箱", "text", "you@example.com") + f("pw1", "主密码", "password", "至少 8 位，记得住又别人猜不到") + f("pw2", "再输一次", "password") + f("inv", "邀请码", "password", "现在注册要邀请码"),
    recover: f("em", "邮箱", "text", "you@example.com") + f("rc", "恢复码", "text", "XXXX-XXXX-…") + f("pw1", "新主密码", "password", "至少 8 位") + f("pw2", "再输一次", "password"),
  };
  const go = { login: "登录", signup: "注册并登录", recover: "重设并登录" }[AC.mode];
  return (`<div class="acct">${sy.need_login ? `<p class="note warn-text">这台电脑的登录已经失效，重新登录后接着同步。</p>` : `<p class="note">登录后，这台电脑的记录在本机加密后同步到云端，别的设备登录同一个账号就能看到。服务器读不到内容。</p>`}
    ${tabs}${forms[AC.mode]}${err}<div class="btns sync-btns"><button class="mx-btn mx-btn--primary" id="ac-go" ${AC.busy ? "disabled" : ""}>${AC.busy ? "请稍候…" : go}</button></div></div>`);
}

function bindAccount() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  const run = async (f) => { AC.busy = true; AC.err = AC.msg = null; renderSettings(); try { await f(); } catch (x) { AC.err = String(x); } AC.busy = false; renderSettings(); };
  const pw = () => {
    const a = document.getElementById("pw1").value, b = document.getElementById("pw2");
    if (a.length < 8) throw "主密码至少 8 位。";
    if (b && b.value !== a) throw "两次输入的主密码不一样。";
    return a;
  };
  const email = () => { const e = val("em"); if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw "邮箱格式不对。"; return e; };
  const tabs = document.getElementById("ac-tabs");
  if (tabs) tabs.onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { AC.mode = b.dataset.mode; AC.err = null; renderSettings(); } };
  on("ac-go", () => run(async () => {
    if (AC.mode === "login") await call("account_login", { email: email(), password: document.getElementById("pw1").value });
    else if (AC.mode === "signup") { const e = email(), p = pw(); AC.code = await call("account_signup", { invite: val("inv"), email: e, password: p }); }
    else { const e = email(), p = pw(); await call("account_recover", { email: e, code: val("rc"), password: p }); AC.msg = "已重设主密码并登录。其他设备要用新主密码重新登录。"; }
    DS.account = null;
  }));
  on("ac-claim", () => run(async () => { const e = email(), p = pw(); AC.code = await call("account_claim", { email: e, password: p }); DS.account = null; }));
  on("code-done", () => { AC.code = null; AC.msg = null; renderSettings(); });
  on("copy-rc", async () => { try { await navigator.clipboard.writeText(AC.code || AC.showCode); AC.msg = "恢复码已复制。"; } catch (x) { AC.err = "复制不了，手动选中复制。"; } renderSettings(); });
  on("ac-to-password", () => { AC.mode = "password"; AC.err = null; renderSettings(); });
  on("ac-cancel", () => { AC.mode = "login"; AC.err = null; renderSettings(); });
  on("ac-password", () => run(async () => { const p = pw(); await call("account_password", { password: p }); AC.mode = "login"; AC.msg = "主密码已改。别的设备不受影响，下次登录新设备用新主密码。"; }));
  on("ac-show-code", async () => { AC.showCode = AC.showCode ? false : await call("account_recovery_code"); renderSettings(); });
  on("ac-logout", () => { AC.confirmLogout = true; renderSettings(); });
  on("logout-keep", () => { AC.confirmLogout = false; renderSettings(); });
  on("logout-go", async () => { await call("account_logout"); AC.confirmLogout = false; AC.mode = "login"; AC.msg = null; DS.account = null; renderSettings(); });
}

/** 到明早 8 点还有几分钟 */
function minutesToMorning() {
  const now = new Date(), t = new Date(now);
  t.setHours(8, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.ceil((t - now) / 60000);
}

async function renderSettings() {
  if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
  const sy = await call("sync_status").catch(() => ({}));
  S.sync = sy;
  if (!PJ.list) PJ.list = await call("list_projects").catch(() => []);
  S.profile = await call("get_profile").catch(() => S.profile);
  S.status = await call("get_status");
  renderSide();
  const st = S.status, dr = S.draft;
  const theme = document.documentElement.dataset.theme || "";
  const gwBad = dr.gateway && !/^https?:\/\//.test(dr.gateway.trim());
  const keySrc = S.settings.api_key_source;
  const pauseRow = st.paused
    ? `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">已暂停</div><div class="mx-setting-desc">${st.paused_until ? `到 ${hm(st.paused_until)} 自动继续。` : "一直暂停，点继续才恢复。"}暂停时不记键盘、鼠标、界面文字和切换 app。</div></div>
        <button class="mx-btn mx-btn--primary" data-pause="off">继续记录</button></div>`
    : `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">暂停记录</div><div class="mx-setting-desc">暂停时不记键盘、鼠标、界面文字和切换 app；和菜单栏里的「暂停记录」是同一个开关。</div></div>
        <div class="btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="60">暂停 1 小时</button><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="morning">到明早 8 点</button><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="on">一直暂停</button></div></div>`;
  const delRow = SS.deleting
    ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>删除${DELETES.find((x) => x[0] === SS.deleting)[1]}的记录？</b><span>这段时间电脑上的键盘、点击、界面文字和 10 分钟摘要都会删掉，删了找不回来。手机记录不动。</span></div><button class="mx-btn mx-btn--secondary" data-del="keep">取消</button><button class="mx-btn mx-btn--danger" data-del="go">删除</button></div>`
    : `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">删除最近的记录</div><div class="mx-setting-desc">${SS.deleted != null ? `刚删掉 ${SS.deleted} 条。` : "不想留下的一段，比如刚输过的私人内容。前一天及更早的已经归档进仓库，不在这里删。"}</div></div>
        <div class="btns">${DELETES.map(([k, v]) => `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-del="${k}">${v}</button>`).join("")}</div></div>`;

  $app.innerHTML = header("设置") + `<div class="form">
    ${same(dr, S.settings) ? "" : `<div class="mx-confirm" id="dirty"><div class="mx-confirm-text"><b>设置改了还没保存</b><span>${gwBad ? "网关地址不对，改好才能保存。" : "保存后写进 settings.json，下一轮就按新设置记录和摘要。"}</span></div><button class="mx-btn mx-btn--secondary" id="discard">放弃改动</button><button class="mx-btn mx-btn--primary" id="save" ${gwBad ? "disabled" : ""}>保存设置</button></div>`}
    ${sy.shadow ? section("账号", profileRow()) : accountSection(sy)}
    ${projectsSection()}
    ${section("记录", pauseRow
      + `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">开机自动启动</div><div class="mx-setting-desc">登录后自动开始记录，不用每次手动打开。</div></div>
        <button class="mx-switch" role="switch" id="login" aria-checked="${!!st.login_item}" aria-label="开机自动启动"></button></div>
      <div class="block"><div><div class="mx-setting-name">不记录的 app</div><div class="mx-setting-desc">写 app 名或 bundle id。这些 app 在前台时只记「在用它」和时长，窗口标题、输入、点击、界面文字都不记。</div></div>
        ${dr.blocklist.length ? `<div class="mx-chips" id="chips">${dr.blocklist.map((b, i) => `<button class="mx-chip" data-i="${i}" title="移出">${esc(b)}${ICON.close}</button>`).join("")}</div>` : ""}
        <div class="inline"><input class="mx-input mono" id="block-new" placeholder="比如 1Password 或 com.1password.1password" aria-label="不记录的 app"><button class="mx-btn mx-btn--secondary" id="block-add">加入</button></div></div>`)}
    ${section("数据", delRow + `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">数据目录</div><div class="mx-setting-desc mono">~/Library/Application Support/Beayy/</div></div><button class="mx-btn mx-btn--secondary" id="open-dir">在访达中打开</button></div>
      <div class="mx-field" style="padding-top:14px"><label for="repo">人生记录仓库（日数据包和日总结从这里读）</label><input class="mx-input mono" id="repo" data-k="repo_path" value="${esc(dr.repo_path)}"></div>`)}
    ${section("外观", `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">主题</div></div>
      <div class="mx-seg" role="tablist" id="theme">${THEMES.map(([k, v]) => `<button role="tab" aria-selected="${k === theme}" class="${k === theme ? "is-on" : ""}" data-theme="${k}">${v}</button>`).join("")}</div></div>`)}
    <details class="adv" ${SS.advanced || gwBad ? "open" : ""} id="adv"><summary>高级：摘要用的网关、模型和密钥</summary><div class="stack">
        <div class="mx-field"><label for="gw">网关地址</label><input class="mx-input mono${gwBad ? " is-error" : ""}" id="gw" data-k="gateway" value="${esc(dr.gateway)}">${gwBad ? `<div class="mx-field-error">网关地址要以 https:// 开头，比如 https://api.openai.com/v1</div>` : ""}</div>
        <div class="mx-field"><label for="m1">10 分钟摘要的模型</label><input class="mx-input mono" id="m1" data-k="model_segment" value="${esc(dr.model_segment)}"></div>
        <div><div class="mx-setting" style="border-top:1px solid var(--line)"><div class="mx-setting-main"><div class="mx-setting-name">网关密钥</div><div class="mx-setting-desc">按环境变量、钥匙串、TOOLS.md 的顺序找。存进钥匙串的只能写入，页面读不到。</div></div>
          <span class="mx-status mx-status--${keySrc ? "ok" : "warn"}">${KEY_SOURCE[keySrc] || "还没有"}</span></div>
          <div class="mx-field" style="padding-top:14px"><label for="key">${keySrc === "keychain" ? "换一把密钥" : "存一把密钥进钥匙串"}</label>
            <div class="inline"><input class="mx-input mono" id="key" type="password" autocomplete="off" placeholder="sk-…"><button class="mx-btn mx-btn--secondary" id="key-save">存进钥匙串</button></div>
            <div class="mx-field-error" id="key-err" hidden></div></div></div></div></details>
  </div>`;

  const rerender = () => { const f = document.activeElement && document.activeElement.id; renderSettings().then(() => { const el = f && document.getElementById(f); if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }); };
  $app.querySelectorAll("[data-k]").forEach((el) => {
    el.oninput = () => { const was = same(S.draft, S.settings); S.draft[el.dataset.k] = el.value; if (was !== same(S.draft, S.settings)) rerender(); };
    el.onchange = () => rerender();
  });
  bindAccount();
  bindProfile();
  bindProjects();
  document.getElementById("adv").ontoggle = (e) => { SS.advanced = e.target.open; };
  document.getElementById("theme").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const t = b.dataset.theme;
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { t ? localStorage.setItem("theme", t) : localStorage.removeItem("theme"); } catch (err) {}
    renderSettings();
  };
  $app.querySelectorAll("[data-pause]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.pause;
    if (k === "off") await call("set_paused", { paused: false });
    else await call("set_paused", { paused: true, minutes: k === "on" ? null : k === "morning" ? minutesToMorning() : +k });
    renderSettings();
  }));
  document.getElementById("login").onclick = async () => {
    try { await call("set_login_item", { on: !st.login_item }); } catch (x) { alert(`没改成：${x}`); }
    renderSettings();
  };
  $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.del;
    if (k === "keep") { SS.deleting = null; return renderSettings(); }
    if (k === "go") {
      const what = SS.deleting; SS.deleting = null;
      SS.deleted = await call("delete_since", what === "today" ? { today: true } : { minutes: +what });
      return renderSettings();
    }
    SS.deleting = k; SS.deleted = null; renderSettings();
  }));
  const addBlock = () => { const v = document.getElementById("block-new").value.trim(); if (v && !S.draft.blocklist.includes(v)) { S.draft.blocklist.push(v); renderSettings(); } };
  document.getElementById("block-add").onclick = addBlock;
  document.getElementById("block-new").onkeydown = (e) => { if (e.key === "Enter") addBlock(); };
  const chips = document.getElementById("chips");
  if (chips) chips.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { S.draft.blocklist.splice(+b.dataset.i, 1); renderSettings(); } };
  document.getElementById("key-save").onclick = async () => {
    const k = document.getElementById("key").value.trim(), err = document.getElementById("key-err");
    if (!k) { err.hidden = false; err.textContent = "先把密钥粘进上面的框。"; return; }
    try { await call("set_api_key", { key: k }); S.settings = await call("get_settings"); S.draft = { ...S.draft, has_api_key: true }; renderSettings(); }
    catch (x) { err.hidden = false; err.textContent = `没存进钥匙串：${x}。再点一次；还不行就看钥匙串访问里同名条目是否被锁住。`; }
  };
  document.getElementById("open-dir").onclick = () => call("open_data_dir");
  const discard = document.getElementById("discard");
  if (discard) {
    discard.onclick = () => { S.draft = JSON.parse(JSON.stringify(S.settings)); renderSettings(); };
    document.getElementById("save").onclick = async () => {
      const { has_api_key, api_key_source, ...rest } = S.draft;
      rest.gateway = rest.gateway.trim();
      await call("save_settings", { settings: rest });
      S.settings = { ...rest, has_api_key: S.settings.has_api_key, api_key_source: S.settings.api_key_source }; S.draft = JSON.parse(JSON.stringify(S.settings));
      renderSettings();
    };
  }
}

// ---------- 首次启动引导 ----------

const OB = { step: 0, err: null, msg: null, busy: false, timer: null };

async function renderOnboarding() {
  document.documentElement.classList.add("onboarding");
  if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
  const st = (S.status = await call("get_status"));
  const perm = st.permissions || {};
  const steps = ["这是什么", "授权", "模型", "同步"];
  const dots = `<div class="ob-steps">${steps.map((x, i) => `<span class="${i === OB.step ? "is-on" : i < OB.step ? "done" : ""}">${i + 1}. ${x}</span>`).join("")}</div>`;
  const permRow = (kind, name, desc) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>
    <span class="mx-status mx-status--${perm[kind] ? "ok" : "warn"}">${perm[kind] ? "已授权" : "未授权"}</span>${perm[kind] ? "" : `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-perm="${kind}">去授权</button>`}</div>`;
  const msg = (OB.err ? `<div class="mx-field-error">${esc(OB.err)}</div>` : "") + (OB.msg ? `<p class="note">${esc(OB.msg)}</p>` : "");
  const body = [
    `<h1 class="ob-title">Be Authentic. Your Yesterdays.</h1>
     <p class="ob-lead">Beayy 在后台记下你一天在电脑和手机上做了什么，每 10 分钟写一段摘要，每晚写一份日总结。</p>
     <div class="ob-list">
       <div><b>记什么</b><span>电脑：切换了哪个 app 和窗口、打字和发出去的内容、点了什么、屏幕上的文字、在不在电脑前。手机：每个 app 用了多久（看不到 app 里的内容）。密码框不记；你可以指定某些 app 完全不记，也可以随时暂停或删掉最近的记录。</span></div>
       <div><b>存在哪</b><span>全部存在这台电脑上。写摘要时，会把那 10 分钟的记录发给你自己配置的模型服务。开启同步的话，记录在本机加密后再上传，服务器读不到内容。</span></div>
     </div>`,
    `<h2>授权</h2><p class="ob-lead">macOS 要你亲自打开这三项权限。点「去授权」会打开系统设置，把 Beayy 的开关打开再回来。</p>
     ${permRow("accessibility", "辅助功能", "读输入框内容、点中的元素、窗口标题和屏幕上的文字。")}
     ${permRow("input_monitoring", "输入监控", "知道什么时候在打字、点击，判断是你本人还是程序在操作。")}
     ${permRow("full_disk_access", "完全磁盘访问（可选）", "读 iPhone 经 iCloud 同步过来的屏幕使用时间。iPhone 上要打开 设置 → 屏幕使用时间 →「跨设备共享」。")}`,
    `<h2>模型</h2><p class="ob-lead">摘要和日总结要用一个大模型。填任何兼容 OpenAI 接口的服务都行：OpenAI、各家云厂商、或你自己的转发网关。不填也能先只记录，以后在设置里补。</p>
     <div class="stack"><div class="mx-field"><label for="ob-gw">接口地址</label><input class="mx-input mono" id="ob-gw" value="${esc(S.draft.gateway || "https://api.openai.com/v1")}"></div>
       <div class="mx-field"><label for="ob-model">模型名</label><input class="mx-input mono" id="ob-model" value="${esc(S.draft.model_segment || "")}" placeholder="比如 gpt-4.1-mini"></div>
       <div class="mx-field"><label for="ob-key">密钥</label><input class="mx-input mono" id="ob-key" type="password" autocomplete="off" placeholder="${S.settings.has_api_key ? "已经存过一把，不改就留空" : "sk-…"}"></div>
       <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ob-test" ${OB.busy ? "disabled" : ""}>${OB.busy ? "测试中…" : "存下并测试一下"}</button></div></div>`,
    `<h2>同步（可选）</h2><p class="ob-lead">有好几台电脑，或者想在别的设备上看记录，就注册或登录一个账号。记录在本机加密后同步，服务器读不到内容。只用这一台的话可以跳过。</p>
     <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary" id="ob-account">去登录或注册</button></div>`,
  ][OB.step];
  const last = OB.step === steps.length - 1;
  $app.innerHTML = `<div class="ob">${dots}<div class="ob-body">${body}${msg}</div>
    <div class="ob-nav">${OB.step ? `<button class="mx-btn mx-btn--text" id="ob-back">上一步</button>` : "<span></span>"}
      <button class="mx-btn mx-btn--primary" id="ob-next">${last ? "开始使用" : OB.step === 2 && !S.settings.has_api_key ? "先跳过" : "继续"}</button></div></div>`;
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  $app.querySelectorAll("[data-perm]").forEach((b) => (b.onclick = () => call("open_permission", { kind: b.dataset.perm })));
  // 授权这一步：每 2 秒看一次权限，用户从系统设置回来就更新
  clearInterval(OB.timer);
  if (OB.step === 1) OB.timer = setInterval(async () => { const p = (await call("get_status")).permissions || {}; if (JSON.stringify(p) !== JSON.stringify(perm)) renderOnboarding(); }, 2000);
  const saveModel = async () => {
    const gw = document.getElementById("ob-gw").value.trim(), model = document.getElementById("ob-model").value.trim(), key = document.getElementById("ob-key").value.trim();
    S.draft = { ...S.draft, gateway: gw, model_segment: model, model_daily: model };
    const { has_api_key, api_key_source, ...rest } = S.draft;
    await call("save_settings", { settings: rest });
    if (key) await call("set_api_key", { key });
    S.settings = await call("get_settings");
  };
  on("ob-test", async () => {
    OB.busy = true; OB.err = OB.msg = null; renderOnboarding();
    try { await saveModel(); await call("test_model"); OB.msg = "连上了，模型能用。"; } catch (x) { OB.err = `没连上：${x}`; }
    OB.busy = false; renderOnboarding();
  });
  on("ob-back", () => { OB.step--; OB.err = OB.msg = null; renderOnboarding(); });
  const finish = async (to) => {
    clearInterval(OB.timer);
    const { has_api_key, api_key_source, ...rest } = { ...S.draft, onboarded: true };
    await call("save_settings", { settings: rest });
    S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings));
    document.documentElement.classList.remove("onboarding");
    location.hash = to; route();
  };
  on("ob-account", () => finish("#/settings"));
  on("ob-next", async () => {
    if (OB.step === 2 && (document.getElementById("ob-model").value.trim() || document.getElementById("ob-key").value.trim())) { try { await saveModel(); } catch (x) { OB.err = String(x); return renderOnboarding(); } }
    if (last) return finish("#/today");
    OB.step++; OB.err = OB.msg = null; renderOnboarding();
  });
}

// ---------- 路由 ----------

async function route() {
  const [page = "today", arg] = location.hash.replace(/^#\/?/, "").split("/");
  S.page = ["today", "summary", "rules", "devices", "settings"].includes(page) ? page : "today";
  markNav(S.page);
  try {
    if (!S.days.length && !S.status) await boot();
    if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
    if (!S.settings.onboarded && TAURI) return renderOnboarding();
    if (S.page === "summary") await renderSummary(arg);
    else if (S.page === "rules") await renderRules();
    else if (S.page === "devices") await renderDevices();
    else if (S.page === "settings") await renderSettings();
    else await renderToday();
    document.getElementById("main").scrollTop = 0;
  } catch (e) {
    $app.innerHTML = header("出错了") + `<p class="mx-error">${esc(e && e.message ? e.message : e)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("pick-menu");
  if (menu && !menu.hidden && !e.target.closest(".pick")) menu.hidden = true;
});
document.addEventListener("keydown", (e) => {
  const menu = document.getElementById("pick-menu");
  if (e.key === "Escape" && menu && !menu.hidden) menu.hidden = true;
});
// 后退／前进：自己记一份走过的页面，没得退或没得进时按钮置灰（照 Claude）
const NAV = { stack: [], pos: -1, jumping: false };
function trackNav() {
  const h = location.hash || "#/today";
  if (NAV.jumping) NAV.jumping = false;
  else if (NAV.stack[NAV.pos] !== h) { NAV.stack = NAV.stack.slice(0, NAV.pos + 1).concat(h); NAV.pos = NAV.stack.length - 1; }
  document.getElementById("go-back").disabled = NAV.pos <= 0;
  document.getElementById("go-fwd").disabled = NAV.pos >= NAV.stack.length - 1;
}
const jump = (d) => { const p = NAV.pos + d; if (p < 0 || p >= NAV.stack.length) return; NAV.pos = p; NAV.jumping = true; location.hash = NAV.stack[p]; };
document.getElementById("go-back").onclick = () => jump(-1);
document.getElementById("go-fwd").onclick = () => jump(1);
window.addEventListener("hashchange", trackNav);
trackNav();
document.getElementById("side-toggle").onclick = () => {
  const root = document.documentElement, collapsed = root.dataset.side === "collapsed";
  if (collapsed) delete root.dataset.side; else root.dataset.side = "collapsed";
  const btn = document.getElementById("side-toggle"), label = collapsed ? "收起侧栏" : "展开侧栏";
  btn.setAttribute("aria-label", label); btn.title = label;
  try { collapsed ? localStorage.removeItem("side") : localStorage.setItem("side", "collapsed"); } catch (e) {}
};
if (document.documentElement.dataset.side === "collapsed") { const b = document.getElementById("side-toggle"); b.setAttribute("aria-label", "展开侧栏"); b.title = "展开侧栏"; }
window.addEventListener("hashchange", route);
// 今天页每分钟自动刷新（展开着某一段、或正在看别的页时不刷）
setInterval(async () => {
  if (S.page !== "today" || document.hidden || $app.querySelector("details[open]")) return;
  const y = document.getElementById("main").scrollTop;
  try { [S.days, S.status] = await Promise.all([call("list_days"), call("get_status")]); renderSide(); await renderToday(); } catch (e) { return; }
  document.getElementById("main").scrollTop = y;
}, 60000);
route();

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

// ---------- 弹层（墨线 Dialog 小窗口）：新建、编辑、填几项再提交都在这里，页面上不展开编辑框 ----------
// 同一时间只开一个，挂在 body 上，页面重画不影响它。点遮罩、Esc、关闭都等于取消；提交中不关。

let DLG = null;

/** title、body（HTML）、ok（主按钮文字）、okClass（primary／danger）、busy（提交中的按钮文字）、cancel（false＝不要取消钮）、
 *  closable（false＝只能点主按钮关）、submit(el)：抛错就把错写在窗口里、不关，返回 false 也不关；onOpen(el, d) 绑窗口里的交互 */
function openDialog({ title, body, ok, okClass = "primary", busy, cancel = "取消", closable = true, submit, onOpen }) {
  closeDialog();
  const root = document.createElement("div");
  root.className = "mx-scrim dlg-root";
  root.innerHTML = `<div class="mx-dialog mx-dialog--sm" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <div class="mx-dialog-head"><h2 id="dlg-title">${esc(title)}</h2>${closable ? `<button class="mx-iconbtn" data-dlg="close" aria-label="关闭">${ICON.close}</button>` : ""}</div>
    <div class="mx-dialog-body">${body}<div class="mx-field-error" data-dlg="err" hidden></div></div>
    <div class="mx-dialog-foot">${cancel ? `<button class="mx-btn mx-btn--secondary" data-dlg="close">${esc(cancel)}</button>` : ""}${ok ? `<button class="mx-btn mx-btn--${okClass}" data-dlg="ok">${esc(ok)}</button>` : ""}</div></div>`;
  document.body.appendChild(root);
  const el = root.querySelector(".mx-dialog"), okBtn = root.querySelector('[data-dlg="ok"]'), err = root.querySelector('[data-dlg="err"]');
  const d = (DLG = { root, el, closable, busy: false, back: document.activeElement });
  d.setErr = (m) => { err.hidden = !m; err.textContent = m || ""; };
  d.setOk = (text) => { if (okBtn) okBtn.textContent = text; };
  d.go = async () => {
    if (d.busy || !okBtn || okBtn.disabled) return;
    const label = okBtn.textContent;
    d.busy = true; okBtn.disabled = true; d.setErr(null); if (busy) okBtn.textContent = busy;
    try { if ((await submit(el, d)) !== false) { d.busy = false; return closeDialog(); } }
    catch (x) { d.setErr(String(x && x.message ? x.message : x)); }
    d.busy = false; okBtn.disabled = false; okBtn.textContent = label;
  };
  const cancelable = () => closable && !d.busy;
  root.addEventListener("mousedown", (e) => { if (e.target === root && cancelable()) closeDialog(); });
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-dlg]"); if (!b) return; if (b.dataset.dlg === "close" && cancelable()) closeDialog(); else if (b.dataset.dlg === "ok") d.go(); });
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { if (cancelable()) closeDialog(); return; }
    // 单行输入框里回车、任何地方 ⌘↩ 都等于点主按钮；输入法选字时的回车不算
    if (e.key === "Enter" && !e.isComposing && (e.metaKey || e.target.tagName === "INPUT")) { e.preventDefault(); d.go(); return; }
    if (e.key === "Tab") {
      const fs = [...el.querySelectorAll("button:not(:disabled), input:not([hidden]), textarea, [tabindex='0']")];
      if (!fs.length) return;
      const i = fs.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); fs[fs.length - 1].focus(); }
      else if (!e.shiftKey && i === fs.length - 1) { e.preventDefault(); fs[0].focus(); }
    }
  });
  if (onOpen) onOpen(el, d);
  const first = el.querySelector(".mx-dialog-body input:not([hidden]), .mx-dialog-body textarea") || okBtn || el.querySelector("[data-dlg]");
  if (first) { first.focus(); if (first.setSelectionRange && first.value) first.setSelectionRange(first.value.length, first.value.length); }
  return d;
}

function closeDialog() {
  const d = DLG; if (!d) return;
  DLG = null; d.root.remove();
  if (d.back && d.back.isConnected && d.back.focus) d.back.focus();
}

/** 弹层里的一项输入 */
const dlgField = (id, label, { type = "text", ph = "", value = "", mono = false, help = "" } = {}) =>
  `<div class="mx-field"><label for="${id}">${label}</label><input class="mx-input${mono ? " mono" : ""}" id="${id}" type="${type}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(value)}">${help ? `<p class="note">${help}</p>` : ""}</div>`;
const dlgVal = (el, id) => { const x = el.querySelector("#" + id); return x ? x.value.trim() : ""; };

// ---------- 人生记录：读数、一天的形状、作息图 ----------

const shade = (min, v) => (min ? `background:color-mix(in srgb, var(${v}) ${Math.round(30 + (Math.min(min, 60) / 60) * 70)}%, var(--rec-track))` : "");
const isNight = (h) => h >= 21 || h < 5;

function readout(k, v, unit, caption = "", over = false) {
  return `<div class="ro${over ? " over" : ""}"><div class="label">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="caption" title="${esc(caption)}">${esc(caption) || "&nbsp;"}</div></div>`;
}

/** 一天的形状。只给电脑、手机两排时照旧（上排电脑、下排手机）；给了 opt（手表说话的分钟数 hw、停留点 visits、日期 date）
 *  就按设备一排一排、行首写设备名，最上面一条地点色带 */
function dayStrip(hc, hp, clickable = false, opt = null) {
  const cells = (arr, v, name, unit = "分钟") => arr.map((m, h) => `<span style="${shade(m, v)}" title="${h}:00 ${name} ${m} ${unit}"${clickable ? ` data-h="${h}"` : ""}></span>`).join("");
  const axis = (n) => `<div class="strip-axis" aria-hidden="true">${Array.from({ length: n }, (_, h) => `<span>${h % 3 ? "" : h}</span>`).join("")}</div>`;
  if (!opt) return `<div role="img" aria-label="一天的形状：上排电脑，下排手机"><div class="strip">${cells(hc, "--rec-computer", "电脑")}${cells(hp, "--rec-phone", "手机")}</div>${axis(24)}</div>`;
  const rows = [];
  if (opt.visits && opt.visits.length) rows.push(["地点", placeBand(opt.visits, opt.date), "k-pl"]);
  rows.push(["电脑", `<div class="strip">${cells(hc, "--rec-computer", "电脑")}</div>`]);
  rows.push(["手机", `<div class="strip">${cells(hp, "--rec-phone", "手机")}</div>`]);
  // 说话：手表录的，和没戴手表时 iPhone 自己录的，合在一排
  if (opt.hw) rows.push(["说话", `<div class="strip">${cells(opt.hw, "--rec-watch", "说话")}</div>`]);
  return `<div role="img" aria-label="一天的形状：${rows.map((r) => r[0]).join("、")}各一排"><div class="strip-rows">${rows.map(([k, v, c]) => `<span class="k${c ? " " + c : ""}">${k}</span>${v}`).join("")}<span></span>${axis(24)}</div></div>`;
}

/** 两个停留点之间不超过 3 小时算「路上」，更长的和首尾算「没记到」（同 脚本/日数据包.py 的 TRANSIT_MAX） */
const TRANSIT_MAX = 3 * 3600e3;
/** 地点的显示名：起过名的用名字；没起名的只要地点名，不带区名（「望湖区 · 云杉食堂」→「云杉食堂」） */
const placeName = (v) => (v && (v.label || (v.name || "").split(" · ").pop())) || "没有地名";
const visitEnd = (v) => (v.end ? Date.parse(v.end) : Date.now());
const hmMs = (ms) => hm(new Date(ms).toISOString());
/** 停留的起止：从前一天待过来的写真实到达时刻（「昨天 22:10」），还没走的写「现在」 */
function visitSpan(v) {
  let a = hm(v.start);
  if (!v.arrive_known && v.arrive) {
    const t = new Date(v.arrive), y = new Date(Date.parse(v.start) - 864e5);
    a = (localDay(t) === localDay(y) ? "昨天 " : `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} `) + hm(v.arrive);
  }
  return `${a}–${v.end ? hm(v.end) : "现在"}`;
}
const spanText = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} 分钟` : `${hh(sec)}h`);

/** 把一天按停留点切开：停留、两段之间的路上（≤ 3 小时）、没记到（更长的空档和首尾），按时间先后。只算到现在 */
function placeBlocks(visits, date) {
  const day0 = toDate(date).getTime(), stop = Math.min(Date.now(), day0 + 864e5);
  const vs = [...visits].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out = [];
  let cur = day0;
  for (const v of vs) {
    const a = Date.parse(v.start), z = Math.min(visitEnd(v), stop);
    if (a > cur) out.push({ kind: cur > day0 && a - cur <= TRANSIT_MAX ? "go" : "none", a: cur, z: a });
    out.push({ kind: "stay", v, a, z });
    cur = Math.max(cur, z);
  }
  if (stop > cur) out.push({ kind: "none", a: cur, z: stop });
  return out.filter((b) => b.z > b.a);
}

/** 地点色带：底色只画到现在；每段停留按起止画在当天 0–24 点上，相邻两段交替深浅；够宽的地名写在段上，
 *  窄的写在下面一行（layoutPlaceNames 排）；两段之间的路上画一条细线；今天画一条「现在」竖线 */
function placeBand(visits, date) {
  const day0 = toDate(date).getTime(), now = Date.now(), today = now < day0 + 864e5;
  const pct = (ms) => `${(Math.max(0, Math.min(1, (ms - day0) / 864e5)) * 100).toFixed(3)}%`;
  const wid = (a, z) => `${(Math.max((z - a) / 864e5, 0.002) * 100).toFixed(3)}%`;
  const blocks = placeBlocks(visits, date);
  let html = `<span class="bg" style="width:${today ? pct(now) : "100%"}"></span>`, i = 0;
  const narrow = [];
  for (const b of blocks) {
    if (b.kind === "go") html += `<span class="go" style="left:${pct(b.a)};width:${wid(b.a, b.z)}" title="路上 ${spanText((b.z - b.a) / 1000)}"></span>`;
    if (b.kind !== "stay") continue;
    const name = placeName(b.v), wide = (b.z - b.a) / 3600e3 >= 1.2;
    html += `<span class="st${i++ % 2 ? " alt" : ""}" style="left:${pct(b.a)};width:${wid(b.a, b.z)}" title="${esc(name)} ${visitSpan(b.v)}">${wide ? esc(name) : ""}</span>`;
    if (!wide) narrow.push([((b.a - day0) / 864e5), name]);
  }
  if (today) html += `<span class="now" style="left:${pct(now)}" title="现在 ${hmMs(now)}"></span>`;
  return `<div><div class="places">${html}</div><div class="pl-names" data-names="${esc(JSON.stringify(narrow))}"></div></div>`;
}

/** 窄段的地名写在色带下面：从左往右排，和前一个挤在一起或超出右边就不写（悬停里有）。页面画好以后、窗口变宽窄时调用 */
function layoutPlaceNames(root = document) {
  for (const box of root.querySelectorAll(".pl-names[data-names]")) {
    const names = JSON.parse(box.dataset.names || "[]"), W = box.getBoundingClientRect().width;
    box.innerHTML = "";
    const m = document.createElement("span"); box.appendChild(m);
    let right = -Infinity, html = "";
    for (const [f, n] of names) {
      m.textContent = n;
      const w = m.getBoundingClientRect().width, x = f * W;
      if (x < right + 8 || x + w > W) continue;
      html += `<span style="left:${x.toFixed(1)}px">${esc(n)}</span>`; right = x + w;
    }
    box.innerHTML = html;
  }
}
let PL_RESIZE = null;
window.addEventListener("resize", () => { clearTimeout(PL_RESIZE); PL_RESIZE = setTimeout(() => layoutPlaceNames(), 120); });

/** 某段时间里待得最久的停留点 */
function placeAt(visits, a, z) {
  let best = null, most = 0;
  for (const v of visits || []) {
    const o = Math.min(z, visitEnd(v)) - Math.max(a, Date.parse(v.start));
    if (o > most) { most = o; best = v; }
  }
  return best;
}

/** 说话的时长：不到一小时写分钟 */
const talkText = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} 分钟` : `${hh(sec)}h`);
/** 说话的人：按说话时长排，本人排第一 */
function speakers(talk, self) {
  return [...talk].sort((a, b) => (b.speaker === self) - (a.speaker === self) || b.sec - a.sec).map((t) => t.speaker);
}

/** 概览里的「去了哪」：先按地点合计（加上路上、没记到），再按时间一个停留一行；点一行给这个地方起名 */
function placesSection(visits, date) {
  if (!visits.length) return "";
  const blocks = placeBlocks(visits, date);
  const tot = new Map();
  let go = 0, none = 0;
  for (const b of blocks) {
    const sec = (b.z - b.a) / 1000;
    if (b.kind === "go") go += sec;
    else if (b.kind === "none") none += sec;
    else tot.set(placeName(b.v), (tot.get(placeName(b.v)) || 0) + sec);
  }
  const rows = [...tot].sort((a, b) => b[1] - a[1]).map(([n, sec]) => ({ n, sec, c: "pl" }));
  if (go) rows.push({ n: "路上", sec: go, c: "go" });
  if (none) rows.push({ n: "没记到", sec: none, c: "none" });
  const max = Math.max(...rows.map((r) => r.sec), 1), all = rows.reduce((a, r) => a + r.sec, 0) || 1;
  const pct = (sec) => { const p = (sec / all) * 100; return p < 1 ? "<1%" : Math.round(p) + "%"; };
  const bars = `<div class="bars pl-bars">${rows.map((r) => `<div class="bar-row"><span class="bar-chev"></span><span class="bar-name${r.c === "pl" ? "" : " dim"}" title="${esc(r.n)}">${esc(r.n)}</span><span class="bar"><i class="${r.c}" style="width:${Math.max(2, Math.round((r.sec / max) * 100))}%"></i></span><span class="bar-v mono">${r.sec < 3600 ? Math.round(r.sec / 60) + "m" : hh(r.sec) + "h"}</span><span class="bar-p mono">${pct(r.sec)}</span></div>`).join("")}</div>`;
  const list = `<div class="visits">${visits.map((v, i) => `<button class="v-row" data-visit="${i}"><span class="t">${visitSpan(v)}</span><span class="n">${esc(placeName(v))}${v.label ? "" : `<span class="sub">${esc(["没起名", ...(v.name || "").split(" · ").slice(0, -1)].join(" · "))}</span>`}</span><span class="d">${spanText((visitEnd(v) - Date.parse(v.start)) / 1000)}</span><span class="act">${v.label ? "改名" : "起名"}</span></button>`).join("")}</div>`;
  return section("去了哪", bars + list + `<p class="note">iPhone 和手表记下的停留点，路上不记。路上＝两个停留点之间不超过 3 小时的空档；没记到＝更长的空档和一天的首尾。点一行给这个地方起名，以后附近 150 米内的停留都用这个名字。</p>`, { count: visits.length });
}

/** 给一个地方起名（小弹层）：名字＋种类，存进本机的地点名单；清空＝删掉这个名字 */
function placeDialog(v) {
  const TYPES = [["home", "家"], ["work", "工作"], ["other", "其他"]];
  let kind = v.type || "other";
  openDialog({
    title: v.label ? `改「${v.label}」的名字` : `给「${placeName(v)}」起名`, ok: "保存",
    body: dlgField("pl-name", "名字", { value: v.label || "", ph: "比如 家、公司、健身房", help: v.label ? "清空就删掉这个名字，改回显示地名。" : `地图上查到的地名是「${esc(v.name || "没有")}」。` })
      + `<div class="mx-field"><label>种类</label><div class="mx-seg" role="tablist" id="pl-kind">${TYPES.map(([k, t]) => `<button role="tab" aria-selected="${k === kind}" class="${k === kind ? "is-on" : ""}" data-v="${k}">${t}</button>`).join("")}</div></div>`,
    onOpen: (el) => {
      el.querySelector("#pl-name").maxLength = 20;
      el.querySelector("#pl-kind").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        kind = b.dataset.v;
        el.querySelectorAll("#pl-kind button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
      };
    },
    submit: async (el) => { await call("set_place_label", { lat: v.lat, lon: v.lon, label: dlgVal(el, "pl-name"), kind }); renderToday(); },
  });
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
  loadUpdate();
  setInterval(loadUpdate, 10 * 60 * 1000);
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
  // 正常记录时不写；暂停、缺权限、没在记录才提示
  if (sub) sub.textContent = st.paused ? " · 已暂停" : !perm.accessibility || !perm.input_monitoring ? " · 缺权限" : st.capturing ? "" : " · 没在记录";
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
  update: lu('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  quit: lu('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
};

// ---------- 自动更新：后台下好了，菜单和设置里出「重启更新」 ----------

/** 左下角菜单里的一行：下好了可以点；还在下就只显示 */
function updateItem() {
  const u = S.update || {};
  if (!u.newer || u.updatable) return "";
  return u.ready ? `<button role="menuitem" data-me="update">${MI.update}重启更新到 ${esc(u.latest)}</button>` : `<button role="menuitem" disabled>${MI.update}正在下载 ${esc(u.latest)}</button>`;
}

async function loadUpdate() {
  if (!TAURI) return;
  try { S.update = await call("update_status"); renderSide(); } catch (e) {}
}

async function applyUpdate() {
  try { await call("update_apply"); } catch (x) { alert(`没更新成功：${x}`); }
}

function aboutSection() {
  const u = S.update || {}, st = S.status || {};
  const state = u.checking ? "正在检查…" : u.updatable ? u.updatable : u.error ? u.error
    : u.newer ? (u.ready ? `${u.latest} 已经下好，重启就能用。` : `正在下载 ${u.latest}…`)
    : u.checked ? `已是最新版本（${mdhm(u.checked)} 检查过）` : "每 6 小时自动检查一次。";
  const btn = u.newer && u.ready && !u.updatable ? `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="up-go">重启更新</button>` : `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="up-check" ${u.checking ? "disabled" : ""}>检查更新</button>`;
  return section("关于", `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">版本 ${esc(u.current || st.version || "")}</div><div class="mx-setting-desc">${esc(state)}</div>${u.newer && u.notes ? `<div class="mx-setting-desc">${esc(u.notes)}</div>` : ""}</div>${TAURI ? btn : ""}</div>`);
}

function bindAbout() {
  const c = document.getElementById("up-check");
  if (c) c.onclick = async () => { S.update = { ...(S.update || {}), checking: true }; renderSettings(); try { S.update = await call("update_check"); } catch (x) {} renderSide(); renderSettings(); };
  const g = document.getElementById("up-go");
  if (g) g.onclick = applyUpdate;
}

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
    ${updateItem()}<button role="menuitem" disabled>${MI.info}版本<span class="mx-menu-val">${esc(st.version || "")}</span></button>
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
  else if (k === "update") applyUpdate();
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
  const sp = d.speech, visits = (d.places && d.places.visits) || [];
  // 说话按分钟画，不满 1 分钟的也算 1 分钟，免得零碎的几句看不见
  const hw = sp ? Array.from({ length: 24 }, (_, i) => Math.min(60, Math.ceil(((sp.hours || {})[pad2(i)] || 0) / 60))) : null;
  const items = timelineItems(d);
  const counts = { all: items.length, computer: items.filter((x) => x.dev === "computer").length, phone: items.filter((x) => x.dev === "phone" && !x.visit).length };
  if (sp) counts.watch = items.filter((x) => x.dev === "watch").length;
  const tab = TL.tab in counts ? TL.tab : "all";
  const shown = items.filter((x) => tab === "all" || x.dev === tab);
  // 照 Claude：标题下一行，左边「概览｜时间线」纯文字页签；时间线后面接「全部／电脑／手机」切换块；右边放同步时刻
  const view = TL.view === "timeline" ? "timeline" : "overview";
  const seg = `<div class="mx-seg" role="tablist" id="tl-tabs">${[["all", "全部"], ["computer", "电脑"], ["phone", "手机"], ["watch", "手表"]].filter(([k]) => k in counts).map(([k, v]) =>
    `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? "is-on" : ""}" data-tab="${k}">${v}<span class="n">${counts[k]}</span></button>`).join("")}</div>`;
  const toolbar = `<div class="toolbar"><div class="toolbar-left"><div class="tabs" role="tablist" id="view-tabs">${[["overview", "概览"], ["timeline", "时间线"]].map(([k, v]) =>
      `<button role="tab" aria-selected="${k === view}" class="${k === view ? "is-on" : ""}" data-view="${k}">${v}</button>`).join("")}</div>
      ${view === "timeline" ? `<span class="tb-sep"></span>${seg}` : ""}</div>
    <div class="toolbar-right">${ph ? `<span class="note">手机同步到 ${hm(ph.synced_until)}</span>` : ""}</div></div>`;
  const overview = `<div class="readouts">
        ${readout("在电脑前", hh(c.active_sec), "h", c.first ? `${c.first}–${c.last}` : "还没有记录")}
        ${readout("手机", ph || fda !== false ? hh(ph ? ph.total_sec : (pack.phone || {}).total_sec) : "—", "h", phoneCap)}
        ${sp ? readout("说话", sp.talk_sec < 3600 ? mins(sp.talk_sec) : hh(sp.talk_sec), sp.talk_sec < 3600 ? "分钟" : "h", sp.first ? `录音 ${hm(sp.first)}–${hm(sp.last)}` : "今天还没有录音") : ""}
        ${readout("切换", c.switches ?? "—", "次", "应用之间切换")}
      </div>
      <div style="margin-top:var(--space-6)">`
    + section("一天的形状", dayStrip(hc, hp, true, { hw, visits, date: today }) + `<div class="legend"><span><i style="background:var(--rec-computer)"></i>电脑</span><span><i style="background:var(--rec-phone)"></i>手机</span>${sp ? `<span><i style="background:var(--rec-watch)"></i>说话</span>` : ""}${visits.length ? `<span><i style="background:var(--rec-place-alt)"></i>地点</span><span><i class="line"></i>路上</span>` : ""}<span>点某个小时，到时间线里看那一小时</span></div>`)
    + placesSection(visits, today)
    + workSection(d.work) + `</div>`;
  const timeline = shown.length ? `<div class="tl" id="tl">${tab === "all" ? hourRows(d, items) : tab === "phone" && visits.length ? phoneByPlace(shown, visits, today) : shown.map(tlRow).join("")}</div>`
    : emptyInline(tab === "phone" ? "今天还没有手机记录。iPhone 的屏幕使用经 iCloud 同步过来，通常晚几个小时。"
      : tab === "watch" ? "今天还没有对话。手表录的音传到录音服务器、转写好以后，这里每 10 分钟拉一次，通常晚 20 分钟左右。"
      : "今天还没有记录。10 分钟摘要每个整 10 分过后 1 分钟写好。");

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
  layoutPlaceNames($app);
  $app.querySelectorAll("[data-visit]").forEach((b) => (b.onclick = () => placeDialog(visits[+b.dataset.visit])));
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

/** 展开着的一级（「domains:工作」这样的键），记在本机，每分钟自动刷新后保持 */
const WORK_OPEN = new Set((() => { try { return JSON.parse(localStorage.getItem("work-open") || "[]"); } catch (e) { return []; } })());

function workSection(w) {
  if (!w || !((w.domains || []).length || (w.activities || []).length)) return "";
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + "m" : hh(sec) + "h");
  // 两级：一级一行，有二级的点开才列；条长按这一列最长的一级比，百分比按这一列合计算
  const tree = (kind, rows) => {
    const max = Math.max(...rows.map((r) => r.sec), 1), total = rows.reduce((a, r) => a + r.sec, 0) || 1;
    const pct = (sec) => { const p = (sec / total) * 100; return p < 1 ? "<1%" : Math.round(p) + "%"; };
    const cells = (r) => `<span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar"><i style="width:${Math.max(2, Math.round((r.sec / max) * 100))}%"></i></span><span class="bar-v mono">${dur(r.sec)}</span><span class="bar-p mono">${pct(r.sec)}</span>`;
    return `<div class="bars">${rows.map((r) => {
      const kids = r.children.length > 1 || (r.children[0] && r.children[0].name !== r.name) ? r.children.slice(0, 6) : [];
      if (!kids.length) return `<div class="bar-row"><span class="bar-chev"></span>${cells(r)}</div>`;
      const k = `${kind}:${r.name}`, open = WORK_OPEN.has(k);
      return `<div class="bar-grp"><button class="bar-row top" data-work="${esc(k)}" aria-expanded="${open}"><span class="bar-chev">${ICON.chevR}</span>${cells(r)}</button>
        <div class="bar-kids"${open ? "" : " hidden"}>${kids.map((c) => `<div class="bar-row kid"><span class="bar-chev"></span>${cells(c)}</div>`).join("")}</div></div>`;
    }).join("")}</div>`;
  };
  return section("时间花在哪", `<div class="work"><div><h4>为了什么（领域 · 项目）</h4>${tree("domains", w.domains || [])}</div><div><h4>在做什么（类型）</h4>${tree("activities", w.activities || [])}</div></div>
    <p class="note">按每 10 分钟摘要判断的领域、项目和类型，乘以那段在电脑前的时间累计；手机不算在内。点一级展开看明细。</p>`);
}

// 展开／收起一级：直接改这一块，不重画整页
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-work]"); if (!b) return;
  const k = b.dataset.work, open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", open);
  b.nextElementSibling.hidden = !open;
  open ? WORK_OPEN.add(k) : WORK_OPEN.delete(k);
  try { localStorage.setItem("work-open", JSON.stringify([...WORK_OPEN])); } catch (x) {}
});

// ---------- 时间线：电脑的 10 分钟摘要和手机的每次拿起，按设备分页签，新的在上 ----------

/** 「全部」页签按小时：每小时一行（小时摘要＋项目＋手机用了多久），点开看这一小时的 10 分钟明细和每次拿起；
 *  连着的「不在电脑前、也没碰手机」的小时合成一行灰字 */
function hourRows(d, items) {
  const hourOf = (iso) => { const t = new Date(iso); t.setMinutes(0, 0, 0); return t.getTime(); };
  const roll = Object.fromEntries((d.hours || []).map((h) => [hourOf(h.start), h]));
  const buckets = new Map();
  const put = (k, x) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(x); };
  for (const x of items) {
    if (x.dev === "computer" && x.seg.kind === "idle") continue; // 合并过的空段按小时摘要算
    if (x.visit) continue; // 停留点写在每小时行首
    if (x.conv) {
      // 对话按小时切开：每个小时只放这一小时里说的句子
      const by = new Map();
      for (const l of x.conv.lines || []) { const k = hourOf(l.start); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
      for (const [k, lines] of by) {
        const talk = {};
        for (const l of lines) talk[l.speaker] = (talk[l.speaker] || 0) + (Date.parse(l.end) - Date.parse(l.start)) / 1000;
        put(k, { dev: x.dev, start: lines[0].start, end: lines[lines.length - 1].end, conv: { lines, talk: Object.entries(talk).map(([speaker, sec]) => ({ speaker, sec: Math.round(sec) })) } });
      }
      continue;
    }
    put(hourOf(x.start), x);
  }
  const visits = (d.places && d.places.visits) || [];
  const talkH = (d.speech && d.speech.hours) || {};
  for (const k of Object.keys(roll)) if (!buckets.has(+k)) buckets.set(+k, []);
  const keys = [...buckets.keys()].sort((a, b) => b - a);
  const now = Date.now();
  const out = [];
  let idleRun = null; // 连着的空小时 [最早, 最晚]
  const flushIdle = () => { if (idleRun) { out.push(`<div class="tl-row computer idle" data-h="${new Date(idleRun[0]).getHours()}"><span class="t">${hm(new Date(idleRun[0]).toISOString())}–${hm(new Date(idleRun[1] + 3600e3).toISOString())}</span><span>不在电脑前</span></div>`); idleRun = null; } };
  for (const k of keys) {
    const xs = buckets.get(k), r = roll[k];
    const comp = xs.filter((x) => x.dev === "computer"), ph = xs.filter((x) => x.dev === "phone" && x.ses), wt = xs.filter((x) => x.conv);
    const idle = !comp.length && (!r || r.title === "不在电脑前") && k + 3600e3 <= now;
    if (idle && !ph.length && !wt.length) { idleRun = idleRun ? [k, idleRun[1]] : [k, k]; continue; }
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
    // 地点只在和上一个小时不一样时写（到了新地方），免得每小时都重复「公司」
    const here = placeAt(visits, k, k + 3600e3), before = placeAt(visits, k - 3600e3, k);
    const where = here && (!before || placeName(before) !== placeName(here)) ? placeName(here) : null;
    const talkSec = talkH[pad2(new Date(k).getHours())] || 0;
    const talkWho = {};
    for (const x of wt) for (const t of x.conv.talk) talkWho[t.speaker] = (talkWho[t.speaker] || 0) + t.sec;
    const who = speakers(Object.entries(talkWho).map(([speaker, sec]) => ({ speaker, sec })), SELF);
    const inner = xs.sort((a, b) => (a.start < b.start ? 1 : -1)).map(tlRow).join("");
    out.push(`<details class="tl-row hour" data-h="${new Date(k).getHours()}"><summary><span class="t">${hm(new Date(k).toISOString())}–${hm(new Date(k + 3600e3).toISOString())}${where ? `<div class="where" title="${esc(where)}">${esc(where)}</div>` : ""}</span><span>
        <span class="name${title === "不在电脑前" ? " dim" : ""}">${esc(title)}</span>${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
        ${chips ? `<div class="chips">${chips}</div>` : ""}${phSec ? `<div class="ph-line">手机 ${minText(phSec)}${topPh ? ` · ${esc(topPh)}` : ""}</div>` : ""}${wt.length ? `<div class="ph-line">对话 ${talkText(talkSec)} · ${esc(who.slice(0, 3).join("、"))}${who.length > 3 ? ` 等 ${who.length} 人` : ""}</div>` : ""}</span>
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

/** 这天有摘要的电脑、设备页里改过的名字：时间线每行标上是哪台 */
let DAY_COMPUTERS = [], DAY_NAMES = {};
/** 设备 → 标签：改过名用改的名；没改过 mac-… 叫 Mac、win-… 叫 Windows，同一种有两台时带上机器名 */
function devLabel(dev) {
  if (DAY_NAMES[dev]) return DAY_NAMES[dev];
  const kind = (x) => (x.startsWith("win-") ? "Windows" : x.startsWith("mac-") ? "Mac" : x);
  const k = kind(dev || "");
  return DAY_COMPUTERS.filter((x) => kind(x) === k).length > 1 ? `${k} · ${dev.replace(/^(mac|win)-/, "")}` : k;
}

/** 手机页签：按停留点分组，新的在上。每组一行标题（地点、起止、待了多久），这段时间里拿手机的记录排在它下面；
 *  两个停留点之间的空档也成一组（路上／没记到位置），没有拿手机就不列 */
function phoneByPlace(items, visits, date) {
  const ses = items.filter((x) => !x.visit);
  const blocks = placeBlocks(visits, date).map((b) => ({ ...b, items: [] }));
  for (const x of ses) {
    const t = Date.parse(x.start);
    const b = blocks.find((y) => t >= y.a && t < y.z) || (t < blocks[0].a ? blocks[0] : blocks[blocks.length - 1]);
    b.items.push(x);
  }
  return blocks.reverse().filter((b) => b.kind === "stay" || b.items.length).map((b) => {
    const h = `data-h="${new Date(b.a).getHours()}"`;
    const head = b.kind === "stay"
      ? `<div class="tl-place" ${h}><span class="t">${visitSpan(b.v)}</span><span class="n"><i></i>${esc(placeName(b.v))}</span><span class="d">${spanText((b.z - b.a) / 1000)}${b.items.some((x) => x.ses) ? ` · 手机 ${minText(b.items.reduce((n, x) => n + (x.ses ? x.ses.sec : 0), 0))}` : ""}</span></div>`
      : `<div class="tl-place gap" ${h}><span class="t">${hmMs(b.a)}–${hmMs(b.z)}</span><span class="n">${b.kind === "go" ? "路上" : "没记到位置"}</span><span class="d">${spanText((b.z - b.a) / 1000)}</span></div>`;
    return head + b.items.sort((x, y) => (x.start < y.start ? 1 : -1)).map(tlRow).join("");
  }).join("");
}

function timelineItems(d) {
  DAY_COMPUTERS = d.computers || [];
  DAY_NAMES = d.device_names || {};
  const out = [];
  for (const s of d.segments || []) out.push({ dev: "computer", start: s.start, end: s.end, seg: s });
  for (const x of (d.phone && d.phone.sessions) || []) out.push({ dev: "phone", start: x.start, end: x.end, ses: x });
  for (const v of (d.places && d.places.visits) || []) out.push({ dev: "phone", start: v.start, end: v.end, visit: v });
  SELF = (d.speech && d.speech.self) || null;
  // 对话按录它的设备归页签：手表录的在「手表」，iPhone 自己录的在「手机」
  for (const c of (d.speech && d.speech.conversations) || []) out.push({ dev: (c.device || "").startsWith("iphone-") ? "phone" : "watch", start: c.start, end: c.end, conv: c });
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

/** 本人在转写里的名字（录音服务器按声纹认出的那个） */
let SELF = null;

/** 一段对话：标题行写时长和谁在说，第一句做预览，点开看原文 */
function convRow(c, h, t) {
  const who = speakers(c.talk || [], SELF);
  const sec = (c.talk || []).reduce((a, x) => a + x.sec, 0);
  const first = (c.lines || []).find((l) => l.text.length >= 4) || (c.lines || [])[0];
  const lines = (c.lines || []).map((l) => `<li><span class="ut">${hm(l.start)}${new Date(l.start).getSeconds() ? ":" + pad2(new Date(l.start).getSeconds()) : ":00"}</span><span class="who${l.speaker === SELF ? " self" : ""}">${esc(l.speaker)}</span><span>${esc(l.text)}</span></li>`).join("");
  return `<details class="tl-row watch" ${h}><summary>${t}<span><span class="name">对话 · ${talkText(sec)}</span><div class="desc">${esc(who.slice(0, 4).join("、"))}${who.length > 4 ? ` 等 ${who.length} 人` : ""}</div>${first ? `<div class="talk-line">${esc(first.speaker)}：${esc(first.text.length > 60 ? first.text.slice(0, 60) + "…" : first.text)}</div>` : ""}</span><span class="chev">${ICON.chevR}</span></summary>
    <div class="more"><ul class="utts">${lines}</ul><p class="note" style="margin:0">手表录音转写，可能有错字。「${esc(SELF || "本人")}」按声纹认出，「他人N」只在当天内是同一个人，「未辨」是太短认不出。</p></div></details>`;
}

function tlRow(x) {
  const t = `<span class="t">${hm(x.start)}–${x.end ? hm(x.end) : "现在"}</span>`;
  const h = `data-h="${localHour(x.start)}"`;
  if (x.conv) return convRow(x.conv, h, t);
  if (x.visit) return `<div class="tl-row phone place" ${h}>${t}<span><span class="name">在 ${esc(x.visit.name || "没有地名的地方")}</span></span></div>`;
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
  const tag = (s.kind === "6h" ? `<span class="mx-tag">6 小时</span>` : s.source === "codex" ? `<span class="mx-tag">Codex</span>` : "")
    + (s.device ? `<span class="mx-tag">${esc(devLabel(s.device))}</span>` : "");
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

const RS = { deleting: null };

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

/** 加一条或改一条规矩（小弹层） */
function ruleDialog(r, save) {
  openDialog({
    title: r ? "改规矩" : "加一条规矩", ok: r ? "保存改动" : "加上这条",
    body: `<div class="mx-field"><label for="rule-text">规矩</label><textarea class="mx-input dlg-ta" id="rule-text" placeholder="用自己的话写，比如「21:00 以后不开电脑」">${esc(r ? r.text : "")}</textarea>
      <p class="note">「几点以后不用电脑／手机」「电脑／手机每天不超过几小时」「某个 app 每天不超过几分钟」会当场对照，别的写法交给日总结。⌘↩ 保存。</p></div>`,
    submit: async (el) => {
      const text = dlgVal(el, "rule-text");
      if (!text) throw "先写一条规矩。";
      if (r) S.rules.find((x) => x.id === r.id).text = text;
      else S.rules.unshift({ id: "r" + Date.now().toString(36), text, enabled: true });
      await save();
    },
  });
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
  const row = (r, i) => `<div class="rule${r.enabled === false ? " off" : ""}" data-id="${r.id}">
      <div class="mx-row"><span class="mx-row-mark mono">${i + 1}</span>
        <div class="mx-row-main"><div class="mx-row-name">${esc(r.text)}</div>${verdict(r)}</div>
        <div class="acts"><button class="mx-btn mx-btn--text mx-btn--sm" data-act="edit">改</button><button class="mx-btn mx-btn--text mx-btn--sm" data-act="delete">删除</button></div>
        <button class="mx-switch" role="switch" aria-checked="${r.enabled !== false}" aria-label="对照这条" title="${r.enabled !== false ? "日总结对照这条" : "暂不对照"}" data-act="toggle"></button>
      </div>
      ${RS.deleting === r.id ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>删除这条规矩？</b><span>删除后日总结不再对照它，删了找不回来。</span></div><button class="mx-btn mx-btn--secondary" data-act="keep">取消</button><button class="mx-btn mx-btn--danger" data-act="remove">删除这条</button></div>` : ""}
    </div>`;
  $app.innerHTML = header("规矩", `<button class="mx-btn mx-btn--primary" id="add">加一条规矩</button>`)
    + `<div class="reading" id="rules">
      ${rules.length ? rules.map(row).join("") : emptyInline("用自己的话写下想守的规矩，比如「21:00 以后不开电脑」「手机每天不超过 3 小时」「抖音每天不超过 30 分钟」。这三类会用今天的数据当场对照，别的写法交给日总结逐条对照。")}
    </div>`;
  const save = async () => { await call("save_rules", { rules: S.rules }); renderRules(); };
  document.getElementById("add").onclick = () => { RS.deleting = null; ruleDialog(null, save); };
  const keepBtn = $app.querySelector('[data-act="keep"]');
  if (keepBtn) keepBtn.focus();
  document.getElementById("rules").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const box = b.closest("[data-id]"), id = box.dataset.id, act = b.dataset.act;
    if (act === "edit") { RS.deleting = null; return ruleDialog(S.rules.find((r) => r.id === id), save); }
    if (act === "delete") { RS.deleting = id; return renderRules(); }
    if (act === "keep") { RS.deleting = null; return renderRules(); }
    if (act === "remove") { S.rules = S.rules.filter((r) => r.id !== id); RS.deleting = null; return save(); }
    if (act === "toggle") { const r = S.rules.find((x) => x.id === id); r.enabled = r.enabled === false; return save(); }
  };
  $app.onkeydown = (e) => { if (e.key === "Escape" && RS.deleting) { RS.deleting = null; renderRules(); } };
}

// ---------- 设备：绑定的电脑和手机，各自的记录状态 ----------

const DS = { open: null, msg: null, err: null, busy: false, account: null, removing: null };
const DEV_ICON = {
  mac: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  win: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  iphone: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
  watch: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="12" height="12" x="6" y="6" rx="3"/><path d="M9 6l.6-3.5h4.8L15 6M9 18l.6 3.5h4.8L15 18"/></svg>',
};
const bytesText = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
const numText = (n) => Number(n || 0).toLocaleString("en-US");

/** 设备页：照墨线的列表页和设置页——「设备」一组（一台一行，点进去是设备详情页）、「同步」一组（设置行）。
 *  本机缺权限时顶上一条提示 */
async function renderDevices() {
  const [devs, st, sy] = await Promise.all([call("list_devices").catch(() => []), call("get_status"), call("sync_status").catch(() => ({}))]);
  // 登录着的设备：进页面取一次，失败（没网、令牌失效）就不显示
  if (sy.email && !sy.need_login && !DS.account) { DS.account = {}; call("account_info").then((a) => { DS.account = a; if (S.page === "devices" && !DEV.id) renderDevices(); }).catch(() => {}); }
  S.status = st; S.sync = sy; renderSide();
  // 登录着的设备列表也用改过的名字
  DS.names = Object.fromEntries(devs.filter((d) => d.custom).map((d) => [d.id, d.name]));
  DS.devs = devs;
  const perm = st.permissions || {};
  const me = devs.find((d) => d.this);
  const missing = [["accessibility", "辅助功能"], ["input_monitoring", "输入监控"], ["full_disk_access", "完全磁盘访问"]].filter(([k]) => perm[k] === false).map(([, n]) => n);
  const notice = me && missing.length ? `<div class="mx-notice"><span>这台电脑缺${missing.join("、")}权限，记不全。</span><a class="mx-btn mx-btn--secondary mx-btn--sm" href="#/devices/${encodeURIComponent(me.id)}">去处理</a></div>` : "";
  const adding = `<div class="add-dev">
      <div class="add-opt">${DEV_ICON.iphone}<div><b>iPhone</b><span>不用装 app。iPhone 上打开 设置 → 屏幕使用时间 →「跨设备共享」，用同一个 Apple 账号，这台 Mac 就能读到。</span></div></div>
      <div class="add-opt">${DEV_ICON.mac}<div><b>另一台 Mac</b><span>装上 Beayy，在设置里用同一个账号登录，记录就会同步过来，出现在下面的列表里。</span></div></div>
      <div class="add-opt">${DEV_ICON.win}<div><b>Windows 电脑</b><span>装上 Windows 版，用同一个账号登录。记的内容和 Mac 一样（打字、点击、界面文字、切换程序、在不在电脑前），还在试用。</span></div></div>
    </div>`;
  const rows = devs.map((d) => `<a class="mx-row" href="#/devices/${encodeURIComponent(d.id)}"><span class="mx-row-mark">${DEV_ICON[d.kind] || DEV_ICON.mac}</span>
      <span class="mx-row-main"><div class="mx-row-name">${esc(d.name)}${d.this ? `<span class="mx-tag">本机</span>` : ""}${d.synced ? `<span class="mx-tag">经同步</span>` : ""}</div><div class="mx-row-desc">${devStatus(d, st)}</div></span>
      <span class="mx-row-side">${ICON.chevR}</span></a>`).join("");
  $app.innerHTML = header("设备", `<button class="mx-btn mx-btn--primary" id="add-dev">添加设备</button>`)
    + `<div class="reading">${notice}${section("设备", rows ? `<div class="mx-list">${rows}</div>` : emptyInline("还没有设备的记录。装上 Beayy 的电脑、同步过来的 iPhone 和手表会列在这里。"))}${syncSection(sy)}</div>`;
  document.getElementById("add-dev").onclick = () => openDialog({ title: "添加设备", body: adding, cancel: "关闭" });
  bindSync();
  if (sy.running || DS.busy) pollSync();
}

/** 设备一行下面那句状态 */
function devStatus(d, st) {
  const perm = (st && st.permissions) || {};
  if (d.this) {
    const missing = !perm.accessibility || !perm.input_monitoring;
    const [cls, text] = st.paused ? ["", st.paused_until ? `已暂停，${hm(st.paused_until)} 自动继续` : "已暂停"] : missing ? ["warn", "缺权限"] : st.capturing ? ["ok", "记录中"] : ["", "没在记录"];
    return `<span class="dot ${cls}"></span>${text} · 今天已记 ${numText(st.events_today)} 条`;
  }
  const m = String((st && st.phone_sync) || "").match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  if (d.kind === "iphone" && !d.synced) return `<span class="dot ok"></span>经 iCloud 同步，记录到 ${mdhm(m ? m[0] : d.last)}`;
  if (d.synced) return `经同步 · 最近一条 ${mdhm(d.last)}`;
  return `最近一条 ${mdhm(d.last)}`;
}

/** 每种设备记什么：一行一项 */
const DEV_RECORDS = {
  mac: ["切换 app 和窗口", "键盘输入和发送（密码框打码）", "点击和滚动", "界面上的文字", "在不在电脑前、锁屏、睡眠", "每 10 分钟写一段摘要"],
  win: ["切换程序和窗口", "键盘输入和发送（密码框打码）", "点击和滚动", "界面上的文字（以管理员身份运行的程序读不到）", "在不在电脑前、锁屏、睡眠", "每 10 分钟写一段摘要"],
  iphone: ["每个 app 什么时候在前台、用了多久（看不到 app 里的内容）", "来源是屏幕使用时间，经 iCloud 同步到这台 Mac，每 5 分钟读一次，通常晚几个小时", "停留点：到了哪、待了多久（Beayy iPhone app 记，经录音服务器拉来）"],
  watch: ["全天录音转成的文字，分出说话人（音频在录音服务器上 7 天后删）", "录音时记下的停留点", "每 10 分钟从录音服务器拉一次"],
};

/** 设备详情页：DetailHeader（返回、名字、状态、操作菜单）＋ 下划线页签 概况／事件 */
const DEV = { id: null, tab: "overview", events: [], more: false, type: "all", live: true, open: new Set(), timer: null, err: null };
async function renderDevice(id, tab) {
  if (DEV.id !== id) { DEV.events = []; DEV.more = false; DEV.type = "all"; DEV.open = new Set(); DEV.err = null; }
  DEV.id = id; DEV.tab = tab === "events" ? "events" : "overview";
  const [devs, st] = await Promise.all([DS.devs ? Promise.resolve(DS.devs) : call("list_devices").catch(() => []), call("get_status")]);
  S.status = st; renderSide();
  const d = devs.find((x) => x.id === id);
  if (!d) { location.hash = "#/devices"; return; }
  const base = `#/devices/${encodeURIComponent(id)}`;
  const head = `<div class="dev-detail"><a class="mx-back" href="#/devices">${ICON.chevL}设备</a>
    <div class="mx-detail"><span class="mx-detail-mark">${DEV_ICON[d.kind] || DEV_ICON.mac}</span><div class="mx-detail-main"><h1>${esc(d.name)}</h1><p>${devStatus(d, st)}${d.this ? " · 本机" : ""}</p></div>
      <div class="pick"><button class="mx-btn mx-btn--secondary" id="dev-ops" aria-haspopup="menu" aria-expanded="false">操作${ICON.chevD}</button>
        <div class="mx-menu" role="menu" hidden><button role="menuitem" id="dev-rename">重命名</button></div></div></div>
    <nav class="mx-utabs"><a href="${base}" class="${DEV.tab === "overview" ? "is-on" : ""}">概况</a><a href="${base}/events" class="${DEV.tab === "events" ? "is-on" : ""}">事件</a></nav></div>`;
  $app.innerHTML = `<div class="reading">${head}<div id="dev-body">${DEV.tab === "events" ? evShell(d) : devOverview(d, st)}</div></div>`;
  bindPick(document.getElementById("dev-ops"));
  document.getElementById("dev-rename").onclick = () => renameDialog(d, () => { DS.devs = null; renderDevice(id, DEV.tab); });
  $app.querySelectorAll("[data-perm]").forEach((b) => (b.onclick = () => call("open_permission", { kind: b.dataset.perm })));
  if (DEV.tab === "events") { DEV.drawn = false; bindEvents(d); await loadEvents(d, false); startEventsTimer(d); } else stopEventsTimer();
}

function devOverview(d, st) {
  const perm = st.permissions || {};
  const permRow = (kind, name, desc) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>
    <span class="mx-status mx-status--${perm[kind] ? "ok" : "warn"}">${perm[kind] ? "已授权" : "未授权"}</span>${perm[kind] ? "" : `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-perm="${kind}">去授权</button>`}</div>`;
  const stats = `<div class="mx-stats dev-stats">
      <div class="mx-stat"><div class="mx-stat-label">记录从</div><div class="mx-stat-value mx-num">${esc(mdhm(d.first) || "—")}</div></div>
      <div class="mx-stat"><div class="mx-stat-label">最近一条</div><div class="mx-stat-value mx-num">${esc(mdhm(d.last) || "—")}</div></div>
      <div class="mx-stat"><div class="mx-stat-label">共</div><div class="mx-stat-value mx-num">${numText(d.events)}<small>条</small></div></div>
      <div class="mx-stat"><div class="mx-stat-label">占用</div><div class="mx-stat-value mx-num">${bytesText(d.bytes).replace(/ (\S+)$/, "<small>$1</small>")}</div></div></div>`;
  const kind = d.kind === "win" ? "win" : d.kind;
  const recs = DEV_RECORDS[kind] || DEV_RECORDS.mac;
  const what = section("记什么", `<ul class="dev-recs">${recs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`, { aside: `<a href="#/devices/${encodeURIComponent(d.id)}/events">看最近的事件</a>` });
  const perms = d.this && !IS_WIN ? section("权限", `<div class="rows">${permRow("accessibility", "辅助功能", "读输入框内容、点中的元素、窗口标题。")}${permRow("input_monitoring", "输入监控", "被动监听键盘和鼠标，只用来计时和判断是人还是代理在操作。")}${permRow("full_disk_access", "完全磁盘访问", "读 iPhone 同步到这台电脑的屏幕使用记录。")}</div>`) : "";
  return stats + what + perms + `<p class="note dev-id">设备编号 <span class="mono">${esc(d.id)}</span></p>`;
}

// ---------- 设备详情 · 事件：最近的原始事件，新的在上；页面开着时每 3 秒刷新 ----------

/** 筛选：显示名 → 事件种类（以「.」结尾按前缀）；每种设备只列它会有的 */
const EV_TYPES = {
  all: ["全部", null],
  input: ["打字和发送", ["keyboard."]],
  mouse: ["点击和滚动", ["mouse."]],
  switch: ["切换", ["app.activated", "window.changed", "app.focus"]],
  ui: ["界面文字", ["ui.text"]],
  presence: ["在不在", ["presence", "heartbeat", "screen.", "system."]],
  speech: ["对话", ["speech."]],
  place: ["位置", ["place.visit"]],
  bg: ["后台", ["sync.run", "summary.run", "phone.sync", "relay.sync", "app.launch", "app.quit", "permission.", "tap.started"]],
};
const EV_KINDS = { mac: ["all", "input", "mouse", "switch", "ui", "presence", "bg"], win: ["all", "input", "mouse", "switch", "ui", "presence", "bg"], iphone: ["all", "switch", "place"], watch: ["all", "speech", "place"] };

/** 一条事件的种类标签 */
function evTag(t) {
  const m = { "keyboard.text_input": "打字", "keyboard.submit": "发送", "keyboard.return": "回车", "keyboard.shortcut": "快捷键", "mouse.click": "点击", "mouse.scroll": "滚动",
    "app.activated": "切换", "window.changed": "窗口", "app.focus": "前台", "ui.text": "界面文字", heartbeat: "心跳", presence: "在不在", "speech.utterance": "说话", "speech.segment": "录音",
    "place.visit": "停留", "sync.run": "同步", "summary.run": "摘要", "phone.sync": "读 iPhone", "relay.sync": "拉录音", "app.launch": "启动", "app.quit": "退出" };
  return m[t] || (/^(screen|system)\./.test(t) ? "屏幕" : /^permission\./.test(t) ? "权限" : t);
}

/** 打的字：去掉方向键、退格这些控制字符，回车写成 ⏎ */
const typedText = (s) => String(s || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n/g, " ⏎ ").trim();
/** 这次打字敲了几下键（人敲的＋代理敲的） */
const keyCount = (e) => Object.values(e.keys || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n) + "…" : s);
const durText = (sec) => (sec < 60 ? `${Math.round(sec)} 秒` : sec < 3600 ? `${Math.round(sec / 60)} 分钟` : `${hh(sec)} 小时`);

/** 一条事件的一句人话（打的字、界面文字原样写出来：只在本机显示） */
function evText(e) {
  const app = e.app_name || "";
  const at = app ? `在 ${app} ` : "";
  const el = e.element || {};
  const who = e.actor && e.actor.kind === "agent" ? `代理（${e.actor.source_proc || "别的程序"}）` : e.actor_kind === "agent" ? "代理" : "";
  const elName = el.title || el.description || ({ AXButton: "按钮", AXTextField: "输入框", AXTextArea: "输入框", AXLink: "链接", AXMenuItem: "菜单项", AXCheckBox: "勾选框", AXTab: "页签", AXImage: "图片", AXStaticText: "文字" }[el.role] || "");
  switch (e.event_type) {
    case "keyboard.text_input": { const t = typedText(e.text || e.typed), n = keyCount(e); return t ? `${who}${at}打了「${clip(t)}」` : `${who}${at}敲了${n ? ` ${n} 下` : ""}键盘（没读到打的内容）`; }
    case "keyboard.submit": { const t = typedText(e.text), n = keyCount(e); return `${who}${at}发出${t ? `「${clip(t)}」` : ""}${n ? `（敲了 ${n} 下）` : ""}`; }
    case "keyboard.return": return `${who}${at}按了回车`;
    case "keyboard.shortcut": return `${who}${at}按了 ${e.keys || ""}`;
    case "mouse.click": return `${who}${at}点了${elName ? `「${clip(elName, 40)}」` : "一下"}${e.button === "right" ? "（右键）" : ""}`;
    case "mouse.scroll": return `${who}${at}滚了 ${e.ticks || 1} 格`;
    case "app.activated": return `切到 ${app}${e.window_title ? ` · ${clip(e.window_title, 50)}` : ""}`;
    case "window.changed": return `${app} 换了窗口${e.window_title ? `：${clip(e.window_title, 50)}` : ""}`;
    case "ui.text": return `读到 ${app} 的界面文字 ${e.lines || 0} 行${e.has_secure_field ? "（有密码框，已打码）" : ""}`;
    case "heartbeat": return e.state === "idle" ? `没在操作，空闲 ${durText(e.idle_seconds || 0)}` : `在用 ${app}`;
    case "presence": return e.state === "active" ? "回到电脑前" : `离开电脑（空闲 ${durText(e.idle_seconds || 0)}）`;
    case "screen.sleep": return "屏幕关了";
    case "screen.wake": return "屏幕亮了";
    case "screen.locked": return "锁屏";
    case "screen.unlocked": return "解锁";
    case "system.sleep": return "电脑睡眠";
    case "system.wake": return "电脑唤醒";
    case "app.focus": { const n = (ICONS[1][e.bundle_id] || {}).name || String(e.bundle_id || "").split(".").pop(); return `${e.state === "start" ? "打开" : "离开"} ${n}`; }
    case "speech.utterance": return `${e.speaker || "未辨"}：${clip(String(e.text || ""), 120)}`;
    case "speech.segment": return `录了一段 ${durText(e.audio_sec || 0)}，有人说话 ${durText(e.speech_sec || 0)}${e.battery != null ? `，电量 ${Math.round(e.battery * 100)}%` : ""}`;
    case "place.visit": return `${e.depart ? "离开" : "到了"} ${e.label || e.name || "没有地名的地方"}`;
    case "sync.run": return `同步一轮：传 ${e.uploaded || 0} 段、收 ${e.downloaded || 0} 段${e.errors ? `，${e.errors} 个错` : ""}`;
    case "summary.run": return `写了 ${e.written || 0} 段摘要（${e.seconds || 0} 秒）`;
    case "phone.sync": return `从 iCloud 读到 iPhone 新记录 ${numText(e.added)} 条`;
    case "relay.sync": return `从录音服务器拉来 ${numText(e.added)} 条`;
    case "app.launch": return `Beayy ${e.version || ""} 启动${e.shadow ? "（测试版）" : ""}`;
    case "app.quit": return "Beayy 退出";
    case "tap.started": return "开始监听键盘和鼠标";
    case "permission.requested": return `申请${{ accessibility: "辅助功能", input_monitoring: "输入监控", full_disk_access: "完全磁盘访问" }[e.service] || e.service || ""}权限`;
    case "permission.changed": return "权限变了";
    default: return e.event_type || "（没有种类）";
  }
}

const hms = (iso) => { const t = new Date(iso); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
/** 一条事件的键：时刻＋种类＋第几条（同一秒可能有好几条） */
const evKey = (e, i) => `${e.timestamp}|${e.event_type}|${i}`;

function evShell(d) {
  const kinds = EV_KINDS[d.kind] || EV_KINDS.mac;
  if (!kinds.includes(DEV.type)) DEV.type = "all";
  return `<div class="toolbar ev-bar"><div class="toolbar-left"><div class="pick"><button class="mx-btn mx-btn--secondary" id="ev-type" aria-haspopup="menu" aria-expanded="false">${EV_TYPES[DEV.type][0]}${ICON.chevD}</button>
      <div class="mx-menu" role="menu" hidden>${kinds.map((k) => `<button role="menuitemradio" aria-checked="${k === DEV.type}" data-ev-type="${k}">${EV_TYPES[k][0]}${k === DEV.type ? `<span class="mx-check">${ICON.check}</span>` : ""}</button>`).join("")}</div></div></div>
    <div class="toolbar-right"><span class="mx-status ${DEV.live ? "mx-status--ok" : ""}" id="ev-live-state">${DEV.live ? "实时 · 每 3 秒刷新" : "已暂停刷新"}</span><button class="mx-btn mx-btn--text mx-btn--sm" id="ev-live">${DEV.live ? "暂停" : "继续"}</button></div></div>
    <div id="ev-list"><p class="note">读取中…</p></div>
    <p class="note">打的字和界面文字只在这台电脑上显示，不进网站；密码框在记录时就打了码。</p>`;
}

function bindEvents(d) {
  bindPick(document.getElementById("ev-type"));
  $app.querySelectorAll("[data-ev-type]").forEach((b) => (b.onclick = () => { DEV.type = b.dataset.evType; DEV.events = []; DEV.open = new Set(); renderDevice(d.id, "events"); }));
  document.getElementById("ev-live").onclick = () => { DEV.live = !DEV.live; renderDevice(d.id, "events"); };
}

/** 读事件：older＝接着往前读一页；不然读最新一页，和已经读到的更早的那些接上 */
async function loadEvents(d, older) {
  const types = EV_TYPES[DEV.type][1];
  const before = older && DEV.events.length ? DEV.events[DEV.events.length - 1].timestamp : null;
  let r;
  try { r = await call("recent_events", { device: d.id, before, limit: 200, types }); DEV.err = null; }
  catch (x) { DEV.err = String(x && x.message ? x.message : x); return drawEvents(d); }
  if (older) { DEV.events = DEV.events.concat(r.events); DEV.more = r.more; }
  else {
    const oldest = r.events.length ? r.events[r.events.length - 1].timestamp : null;
    const keep = oldest ? DEV.events.filter((e) => e.timestamp < oldest) : [];
    const same = DEV.events.length && r.events.length && DEV.events[0].timestamp === r.events[0].timestamp && DEV.events.length >= r.events.length;
    if (same && DEV.drawn) return;
    DEV.events = r.events.concat(keep);
    if (!keep.length) DEV.more = r.more;
  }
  drawEvents(d);
}

function drawEvents(d) {
  const box = document.getElementById("ev-list"); if (!box) return;
  DEV.drawn = true;
  if (DEV.err) { box.innerHTML = `<p class="mx-error">读不到事件：${esc(DEV.err)}</p>`; return; }
  if (!DEV.events.length) { box.innerHTML = emptyInline(d.this ? "最近 8 小时没有这一类事件。" : "最近 8 小时没有这一类事件。同步来的设备要等它下次同步。"); return; }
  const phone = d.kind === "iphone";
  box.innerHTML = `<div class="ev-list">${DEV.events.map((e, i) => {
    const k = evKey(e, i), app = e.bundle_id && (e.app_name || phone) ? `<span class="ico" data-b="${esc(e.bundle_id)}" data-p="${phone ? 1 : 0}" title="${esc(e.app_name || e.bundle_id)}">${esc(((e.app_name || e.bundle_id.split(".").pop())[0] || "?").toUpperCase())}</span>` : `<span class="ico ico-none"></span>`;
    const raw = JSON.stringify(e, null, 2);
    const extra = e.event_type === "ui.text" && e.text ? `<pre class="ev-text">${esc(clip(String(e.text), 2000))}</pre>` : "";
    return `<details class="ev-row" data-k="${esc(k)}"${DEV.open.has(k) ? " open" : ""}><summary><span class="t mono">${hms(e.timestamp)}</span><span class="mx-tag">${esc(evTag(e.event_type))}</span>${app}<span class="ev-say">${esc(evText(e))}</span></summary>
      <div class="ev-more">${extra}<pre class="ev-raw mono">${esc(raw)}</pre></div></details>`;
  }).join("")}</div>${DEV.more ? `<div class="btns ev-older"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ev-older">加载更早</button></div>` : ""}`;
  box.querySelectorAll(".ev-row").forEach((x) => x.addEventListener("toggle", () => { x.open ? DEV.open.add(x.dataset.k) : DEV.open.delete(x.dataset.k); }));
  const older = document.getElementById("ev-older"); if (older) older.onclick = () => loadEvents(d, true);
  loadIcons().then(() => { if (phone) box.querySelectorAll(".ev-row").forEach((x, i) => { const e = DEV.events[i]; if (e && e.event_type === "app.focus") x.querySelector(".ev-say").textContent = evText(e); }); });
}

function startEventsTimer(d) {
  stopEventsTimer();
  if (!DEV.live) return;
  DEV.timer = setInterval(() => {
    if (S.page !== "devices" || DEV.id !== d.id || DEV.tab !== "events" || !document.getElementById("ev-list")) return stopEventsTimer();
    loadEvents(d, false);
  }, 3000);
}
function stopEventsTimer() { if (DEV.timer) { clearInterval(DEV.timer); DEV.timer = null; } }

/** 下拉菜单（.pick 里的按钮＋.mx-menu）：点按钮开关，点外面或 Esc 关（见文末） */
function bindPick(btn) {
  if (!btn) return;
  const menu = btn.parentElement.querySelector(".mx-menu");
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
}

/** 给设备改名（小弹层）。改的名字会同步到别的设备，时间线上的标签也用它；清空＝改回默认名 */
function renameDialog(d, done) {
  if (!d) return;
  openDialog({
    title: "重命名设备", ok: "保存",
    body: dlgField("dev-name", "名称", { value: d.custom ? d.name : "", ph: d.default_name, help: "时间线上用这个名字标出是哪台。清空就改回默认的名字。会同步到你登录的其他设备。" }),
    onOpen: (el) => { el.querySelector("#dev-name").maxLength = 40; },
    submit: async (el) => { await call("rename_device", { id: d.id, name: dlgVal(el, "dev-name") }); DS.devs = null; done ? done() : renderDevices(); },
  });
}

/** 同步进行中：每 2 秒只刷新同步卡片（进度条），同步完了整页重画一次（设备列表、最近一条会变） */
let SYNC_POLL = null;
function pollSync() {
  if (SYNC_POLL) return;
  SYNC_POLL = setTimeout(async function tick() {
    SYNC_POLL = null;
    if (S.page !== "devices" || DEV.id) return;
    const sy = await call("sync_status").catch(() => null);
    const card = document.getElementById("sync-sec");
    if (!sy || !card) return;
    if (!sy.running && !DS.busy) return renderDevices();
    card.outerHTML = syncSection(sy);
    bindSync();
    SYNC_POLL = setTimeout(tick, 2000);
  }, 2000);
}

/** 多设备同步：设备页「同步」一组设置行——账号、登录着的设备（点开小弹层，可移除）、立即同步。没登录就引导登录 */
function syncSection(sy) {
  if (sy.shadow) return "";
  const msg = DS.err ? `<div class="mx-field-error">${esc(DS.err)}</div>` : DS.msg ? `<p class="note">${esc(DS.msg)}</p>` : "";
  const row = (name, desc, side) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div>${desc ? `<div class="mx-setting-desc">${desc}</div>` : ""}</div>${side}</div>`;
  const wrap = (rows) => section("同步", `<div class="rows">${rows}</div>${msg}`).replace('<section class="mx-sec"', '<section class="mx-sec" id="sync-sec"');
  if (!sy.configured) return wrap(row("多设备同步", "登录账号后，这台电脑和 iPhone 的记录在本机加密后同步到云端，别的电脑登录同一个账号就能看到。服务器读不到内容。",
    `<span class="mx-status">没登录</span><span class="btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-signup">注册</button><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-login">登录</button></span>`));
  if (!sy.email) return wrap(row("多设备同步", "这台电脑用的是早期的配对码账号。设好邮箱和主密码，别的设备用邮箱登录就行，已经同步的数据不用重传。",
    `<span class="mx-status mx-status--warn">要设账号</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-claim">设好账号</button>`));
  if (sy.need_login) return wrap(row("多设备同步", "这台电脑的登录已经失效（在别的设备上重设了主密码，或者把这台移除了）。重新登录后接着同步。",
    `<span class="mx-status mx-status--warn">要重新登录</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-login">重新登录</button>`));
  const sessions = (DS.account && DS.account.sessions) || [];
  const pg = sy.progress || {};
  const busy = sy.running || DS.busy;
  const going = busy && pg.phase && pg.total > 0;
  const bar = going ? `<div class="sync-prog"><div class="sync-prog-text"><span>${pg.phase === "upload" ? "上传" : "下载"}</span><span class="mono">${numText(pg.done)} / ${numText(pg.total)} 段</span></div><div class="bar"><i style="width:${Math.min(100, Math.round((pg.done / pg.total) * 100))}%"></i></div></div>` : "";
  const state = busy ? `<span class="mx-status">同步中…</span>` : sy.last_error ? `<span class="mx-status mx-status--warn">上次有错</span>` : `<span class="mx-status mx-status--ok">已开${sy.last ? ` · 上次 ${hm(sy.last)}` : ""}</span>`;
  return wrap(row("账号", esc(sy.email), state)
    + (bar ? `<div class="sync-bar-row">${bar}</div>` : "")
    + (sy.last_error ? `<div class="mx-error">${esc(sy.last_error)}</div>` : "")
    + (sessions.length ? row("登录着的设备", "", `<button class="mx-btn mx-btn--text mx-btn--sm" id="sess-open">${sessions.length} 台${ICON.chevR}</button>`) : "")
    + row("立即同步", `每 5 分钟自动一轮${sy.uploaded ? `，已传 ${numText(sy.uploaded)} 段` : ""}`, `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="sync-now" ${busy ? "disabled" : ""}>立即同步</button>`));
}

/** 登录着这个账号的设备（小弹层）：这台标出来，别的可以移除（先点「移除」，再点一次确认） */
function sessionsDialog() {
  let removing = null;
  const body = () => {
    const sessions = (DS.account && DS.account.sessions) || [], me = DS.account && DS.account.session;
    return `<div class="sess">${sessions.map((x) => `<div class="sess-row"><span>${esc((DS.names || {})[x.device] || x.name || x.device)}${x.id === me ? `<span class="mx-tag">这台</span>` : ""}</span><span class="note">最近 ${mdhm(new Date(x.last_seen).toISOString())}</span>${x.id === me ? "<span></span>" : removing === x.id
      ? `<span class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" data-sess-keep>取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" data-sess-go="${esc(x.id)}">移除</button></span>`
      : `<button class="mx-btn mx-btn--text mx-btn--sm" data-sess="${esc(x.id)}">移除</button>`}</div>`).join("")}</div>
      <p class="note">移除后，那台设备要重新登录才能再同步，它已经传上来的记录还在。</p>`;
  };
  const d = openDialog({ title: "登录着这个账号的设备", body: `<div id="sess-body">${body()}</div>`, cancel: "关闭", ok: null,
    onOpen: (el) => {
      const draw = () => { el.querySelector("#sess-body").innerHTML = body(); bind(); };
      const bind = () => {
        el.querySelectorAll("[data-sess]").forEach((b) => (b.onclick = () => { removing = b.dataset.sess; draw(); }));
        el.querySelectorAll("[data-sess-keep]").forEach((b) => (b.onclick = () => { removing = null; draw(); }));
        el.querySelectorAll("[data-sess-go]").forEach((b) => (b.onclick = async () => {
          try { await call("account_remove_device", { id: b.dataset.sessGo }); DS.account = await call("account_info").catch(() => DS.account); DS.msg = "已移除。那台设备要重新登录才能再同步。"; }
          catch (x) { DS.err = String(x); }
          removing = null; draw(); if (S.page === "devices" && !DEV.id) renderDevices();
        }));
      };
      bind();
    } });
  return d;
}

function bindSync() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ac-login", () => loginDialog("login"));
  on("ac-signup", () => loginDialog("signup"));
  on("ac-claim", claimDialog);
  on("sess-open", sessionsDialog);
  on("sync-now", async () => { DS.busy = true; DS.err = DS.msg = null; renderDevices(); try { const r = await call("sync_now"); DS.msg = `上传 ${r.uploaded} 段，下载 ${r.downloaded} 段${r.errors.length ? "，有错：" + r.errors.join("；") : ""}`; } catch (x) { DS.err = String(x); } DS.busy = false; renderDevices(); });
}

// ---------- 设置 ----------

const THEMES = [["", "跟随系统"], ["light", "浅色"], ["dark", "深色"]];
const SETTING_KEYS = ["gateway", "model_segment", "repo_path", "blocklist", "relay_server"];
const same = (a, b) => JSON.stringify(SETTING_KEYS.map((k) => a[k])) === JSON.stringify(SETTING_KEYS.map((k) => b[k]));
/** Windows 版：没有钥匙串和系统授权（密钥存数据目录，采集不用授权） */
const IS_WIN = /Windows/.test(navigator.userAgent);
const KEY_SOURCE = { keychain: "已存（钥匙串）", file: "已存（数据目录）", env: "在用环境变量里的" };
const KEY_STORE = IS_WIN ? "数据目录" : "钥匙串";
const DELETES = [["15", "最近 15 分钟"], ["60", "最近 1 小时"], ["today", "今天全部"]];
const SS = { deleting: null, deleted: null, advanced: false };
/** 项目列表（设置页进来时取一次，改过后重取） */
const PJ = { err: null, list: null };

function profileRow() {
  const pf = S.profile || { name: "我" };
  return `<div class="mx-setting"><div class="profile"><span class="avatar big">${avatarHtml(pf)}</span><div><div class="mx-setting-name">${esc(pf.name)}</div><div class="mx-setting-desc">${pf.email ? esc(pf.email) : "显示在左下角"}</div></div></div>
      <button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-edit">编辑</button></div>`;
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

/** 编辑头像和名称（小弹层）。avatar：undefined＝没动，null＝改用名字首字 */
function profileDialog() {
  const pf = S.profile || { name: "我" };
  let avatar;
  openDialog({
    title: "编辑个人资料", ok: "保存",
    body: `<div class="profile"><span class="avatar big" id="pf-av">${avatarHtml(pf)}</span>
        <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-pick">换头像</button><button class="mx-btn mx-btn--text mx-btn--sm" id="pf-clear">用名字首字</button><input type="file" id="pf-file" accept="image/*" hidden></div></div>
      ${dlgField("pf-name", "名称", { value: pf.name || "", help: pf.email ? "显示在左下角，换设备登录也是这个。" : "显示在左下角。" })}`,
    onOpen: (el, d) => {
      const av = el.querySelector("#pf-av"), file = el.querySelector("#pf-file"), name = el.querySelector("#pf-name");
      name.maxLength = 40;
      const show = () => (av.innerHTML = avatarHtml({ name: name.value.trim() || pf.name, avatar: avatar === undefined ? pf.avatar : avatar }));
      name.oninput = show;
      el.querySelector("#pf-pick").onclick = () => file.click();
      el.querySelector("#pf-clear").onclick = () => { avatar = null; show(); };
      file.onchange = async () => { if (!file.files[0]) return; try { avatar = await shrinkImage(file.files[0]); d.setErr(null); show(); } catch (x) { d.setErr(String(x)); } };
    },
    submit: async (el) => {
      const name = dlgVal(el, "pf-name");
      if (!name) throw "名称不能空。";
      await call("save_profile", { name, avatar: avatar === undefined ? pf.avatar || null : avatar });
      S.profile = await call("get_profile"); renderSide(); renderSettings();
    },
  });
}

function bindProfile() {
  const b = document.getElementById("pf-edit");
  if (b) b.onclick = profileDialog;
}

const DOMAINS = ["工作", "成长", "生活", "健康", "关系", "休闲"];

function projectsSection() {
  const list = PJ.list || [];
  if (!list.length) return "";
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + " 分钟" : hh(sec) + " 小时");
  const byDom = DOMAINS.map((d) => [d, list.filter((p) => p.domain === d)]).filter(([, xs]) => xs.length);
  const rows = byDom.map(([d, xs]) => `<div class="pj-group">${d}</div>` + xs.map((p) => `<div class="pj-row" data-p="${esc(p.name)}">
      <div class="pj-main"><div class="mx-setting-name">${esc(p.name)}</div><div class="mx-setting-desc">累计 ${dur(p.sec)}${p.aliases.length ? ` · 也叫 ${esc(p.aliases.join("、"))}` : ""}</div></div>
      <button class="mx-btn mx-btn--text mx-btn--sm" data-pj-edit>编辑</button></div>`).join("")).join("");
  return section("项目", `<p class="note">项目和它属于哪个领域由摘要自动判断。判断错了在这里改：改领域、把同一件事的不同叫法合并。你改过的，自动判断不会再覆盖。</p><div class="pj">${rows}</div>${PJ.err ? `<div class="mx-field-error">${esc(PJ.err)}</div>` : ""}`);
}

/** 编辑一个项目（小弹层）：改领域，或者合并到另一个项目 */
function projectDialog(p) {
  const others = (PJ.list || []).filter((q) => q.name !== p.name);
  const why = "同一件事有两个叫法时，把一个合并到另一个。";
  let domain = p.domain, into = "";
  openDialog({
    title: `编辑「${p.name}」`, ok: "保存",
    body: `<div class="mx-field" id="pj-dom-f"><label>领域</label><div class="mx-seg" role="tablist" id="pj-dom">${DOMAINS.map((x) => `<button role="tab" aria-selected="${x === domain}" class="${x === domain ? "is-on" : ""}" data-v="${x}">${x}</button>`).join("")}</div></div>
      ${others.length ? `<div class="mx-field"><label>合并到</label><div class="pick-list" role="listbox" id="pj-into"><button role="option" aria-selected="true" data-v=""><span>不合并</span>${ICON.check}</button>${others.map((q) => `<button role="option" aria-selected="false" data-v="${esc(q.name)}"><span>${esc(q.name)}</span><span class="mx-menu-val">${esc(q.domain)}</span>${ICON.check}</button>`).join("")}</div>
        <p class="note" id="pj-why">${why}</p></div>` : ""}`,
    onOpen: (el, d) => {
      el.querySelector("#pj-dom").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        domain = b.dataset.v;
        el.querySelectorAll("#pj-dom button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
      };
      const lst = el.querySelector("#pj-into"); if (!lst) return;
      lst.onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        into = b.dataset.v;
        lst.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b));
        el.querySelector("#pj-why").textContent = into ? `以前和以后记成「${p.name}」的时间都算到「${into}」。之后还能在这里改。` : why;
        el.querySelector("#pj-dom-f").hidden = !!into;
        d.setOk(into ? `合并到「${into}」` : "保存");
      };
    },
    submit: async () => {
      if (into) await call("merge_project", { from: p.name, into });
      else if (domain !== p.domain) await call("set_project_domain", { project: p.name, domain });
      else return;
      PJ.err = null; PJ.list = await call("list_projects"); renderSettings();
    },
  });
}

function bindProjects() {
  $app.querySelectorAll("[data-pj-edit]").forEach((b) => (b.onclick = () => projectDialog(PJ.list.find((p) => p.name === b.closest("[data-p]").dataset.p))));
}

/** 账号：msg＝页面上留一句结果；confirmLogout＝退出登录等确认。登录、注册、改密码这些都在小弹层里 */
const AC = { msg: null, confirmLogout: false };

function accountSection(sy) {
  return section("账号", profileRow() + accountBody(sy));
}

function accountBody(sy) {
  const msg = AC.msg ? `<p class="note ac-msg">${esc(AC.msg)}</p>` : "";
  const row = (name, desc, right) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>${right}</div>`;
  const btn = (id, text) => `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="${id}">${text}</button>`;
  if (sy.configured && sy.email && !sy.need_login) return row(esc(sy.email), "记录在这台电脑上加密后同步，别的设备用这个邮箱登录。",
      AC.confirmLogout ? `<div class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" id="logout-keep">取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" id="logout-go">退出登录</button></div>` : btn("ac-logout", "退出登录"))
    + row("主密码", "只在设备上用，不会发给服务器。", btn("ac-password", "改主密码"))
    + row("恢复码", "忘了主密码时用它重设。", btn("ac-show-code", "查看")) + msg;
  if (sy.configured && !sy.email) return row("邮箱和主密码", `这台电脑用的是早期的配对码账号。设好邮箱和主密码，别的设备用邮箱登录就行；已经同步的 ${numText(sy.uploaded)} 段数据不用重传。`, btn("ac-claim", "设好账号")) + msg;
  return row(sy.need_login ? "登录已失效" : "没登录",
    sy.need_login ? "这台电脑的登录已经失效（在别的设备上重设了主密码，或者把这台移除了），重新登录后接着同步。" : "登录后，这台电脑的记录在本机加密后同步到云端，别的设备登录同一个账号就能看到。服务器读不到内容。",
    `<div class="btns">${sy.need_login ? "" : btn("ac-signup", "注册")}${btn("ac-login", sy.need_login ? "重新登录" : "登录")}</div>`) + msg;
}

const checkEmail = (e) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw "邮箱格式不对。";
  // 常见手滑：.con、gmial 这类，邮箱错了以后登录不上
  if (/\.(con|cmo|cm|comm|om|vom|xom)$/i.test(e) || /@(gmial|gamil|gmai|gmal|gmaill|qq\.con)\b/i.test(e)) throw "邮箱像是拼错了（比如 .com 打成了 .con），检查一下再提交。";
  return e;
};
const checkPw = (el) => {
  const a = el.querySelector("#pw1").value, b = el.querySelector("#pw2");
  if (a.length < 8) throw "主密码至少 8 位。";
  if (b && b.value !== a) throw "两次输入的主密码不一样。";
  return a;
};
/** 账号变了：登录着的设备列表重取，当前页重画（设置页和设备页都能开这些弹层） */
const accountChanged = () => { DS.account = null; return S.page === "devices" ? renderDevices() : renderSettings(); };

/** 登录、注册、用恢复码重设（小弹层，底下可以互相切换） */
function loginDialog(mode = "login", email = "") {
  const sy = S.sync || {};
  const em = dlgField("em", "邮箱", { ph: "you@example.com", value: email || sy.email || "" });
  const pw2 = dlgField("pw2", "再输一次", { type: "password" });
  const forms = {
    login: ["登录", em + dlgField("pw1", "主密码", { type: "password" }), "登录", "登录中…"],
    signup: ["注册", em + dlgField("pw1", "主密码", { type: "password", ph: "至少 8 位，记得住又别人猜不到" }) + pw2 + dlgField("inv", "邀请码", { type: "password", ph: "现在注册要邀请码" }), "注册并登录", "注册中…"],
    recover: ["用恢复码重设主密码", em + dlgField("rc", "恢复码", { ph: "XXXX-XXXX-…", mono: true }) + dlgField("pw1", "新主密码", { type: "password", ph: "至少 8 位" }) + pw2, "重设并登录", "重设中…"],
  };
  const links = { login: [["signup", "没有账号？注册"], ["recover", "忘了主密码"]], signup: [["login", "已经有账号？登录"]], recover: [["login", "想起来了？登录"]] }[mode];
  const [title, body, ok, busy] = forms[mode];
  openDialog({
    title, ok, busy,
    body: (mode === "recover" ? `<p class="note">重设后，之前登录着的设备都要用新主密码重新登录。</p>` : "") + body
      + `<div class="dlg-links">${links.map(([k, v]) => `<button class="mx-btn mx-btn--text mx-btn--sm" data-to="${k}">${v}</button>`).join("")}</div>`,
    onOpen: (el) => el.querySelectorAll("[data-to]").forEach((b) => (b.onclick = () => loginDialog(b.dataset.to, dlgVal(el, "em")))),
    submit: async (el) => {
      const email = checkEmail(dlgVal(el, "em"));
      AC.msg = null;
      if (mode === "login") await call("account_login", { email, password: el.querySelector("#pw1").value });
      else if (mode === "signup") { const code = await call("account_signup", { invite: dlgVal(el, "inv"), email, password: checkPw(el) }); setTimeout(() => codeDialog(code, true)); }
      else { await call("account_recover", { email, code: dlgVal(el, "rc"), password: checkPw(el) }); AC.msg = "已重设主密码并登录。其他设备要用新主密码重新登录。"; }
      accountChanged();
    },
  });
}

/** 早期配对码账号设邮箱和主密码 */
function claimDialog() {
  openDialog({
    title: "设邮箱和主密码", ok: "设好账号", busy: "设置中…",
    body: `<p class="note">设好后，别的设备用邮箱和主密码登录。已经同步的数据不用重传。</p>`
      + dlgField("em", "邮箱", { ph: "you@example.com" }) + dlgField("pw1", "主密码", { type: "password", ph: "至少 8 位，记得住又别人猜不到" }) + dlgField("pw2", "再输一次", { type: "password" }),
    submit: async (el) => {
      const email = checkEmail(dlgVal(el, "em")), code = await call("account_claim", { email, password: checkPw(el) });
      AC.msg = null; accountChanged(); setTimeout(() => codeDialog(code, true));
    },
  });
}

function passwordDialog() {
  openDialog({
    title: "改主密码", ok: "改主密码", busy: "改密码中…",
    body: `<p class="note">数据不用重传，别的设备也不用重新登录。下次登录新设备用新主密码。</p>`
      + dlgField("pw1", "新主密码", { type: "password", ph: "至少 8 位" }) + dlgField("pw2", "再输一次", { type: "password" }),
    submit: async (el) => { await call("account_password", { password: checkPw(el) }); AC.msg = "主密码已改。"; renderSettings(); },
  });
}

/** 恢复码。fresh＝刚注册或刚设好账号：必须点「我已存好」才关 */
function codeDialog(code, fresh) {
  openDialog({
    title: fresh ? "存好恢复码" : "恢复码", closable: !fresh, cancel: fresh ? false : "关闭", ok: fresh ? "我已存好" : "复制恢复码",
    body: `<div class="code-box"><code class="mono">${esc(code)}</code>${fresh ? `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="copy-rc" autofocus>复制</button>` : ""}</div>
      <p class="note warn-text">恢复码是忘了主密码时找回数据的唯一办法：存进密码管理器或抄在纸上。主密码和恢复码都丢了，云端的数据就再也解不开，我们也帮不了。</p>`,
    onOpen: (el, d) => {
      const b = el.querySelector("#copy-rc");
      if (b) b.onclick = async () => { try { await navigator.clipboard.writeText(code); b.textContent = "已复制"; } catch (x) { d.setErr("复制不了，手动选中复制。"); } };
    },
    submit: async () => { if (!fresh) { try { await navigator.clipboard.writeText(code); } catch (x) { throw "复制不了，手动选中复制。"; } } },
  });
}

function bindAccount() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ac-login", () => loginDialog("login"));
  on("ac-signup", () => loginDialog("signup"));
  on("ac-claim", claimDialog);
  on("ac-password", passwordDialog);
  on("ac-show-code", async () => { try { codeDialog(await call("account_recovery_code"), false); } catch (x) { AC.msg = `取不到恢复码：${x}`; renderSettings(); } });
  on("ac-logout", () => { AC.confirmLogout = true; renderSettings(); });
  on("logout-keep", () => { AC.confirmLogout = false; renderSettings(); });
  on("logout-go", async () => { await call("account_logout"); AC.confirmLogout = false; AC.msg = null; DS.account = null; renderSettings(); });
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
  if (TAURI) S.update = await call("update_status").catch(() => S.update);
  renderSide();
  const st = S.status, dr = S.draft;
  const theme = document.documentElement.dataset.theme || "";
  const gwBad = dr.gateway && !/^https?:\/\//.test(dr.gateway.trim());
  const keySrc = S.settings.api_key_source;
  const relayBad = dr.relay_server && !/^https?:\/\//.test(dr.relay_server.trim());
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
    ${same(dr, S.settings) ? "" : `<div class="mx-confirm" id="dirty"><div class="mx-confirm-text"><b>设置改了还没保存</b><span>${gwBad ? "网关地址不对，改好才能保存。" : "保存后写进 settings.json，下一轮就按新设置记录和摘要。"}</span></div><button class="mx-btn mx-btn--secondary" id="discard">放弃改动</button><button class="mx-btn mx-btn--primary" id="save" ${gwBad || relayBad ? "disabled" : ""}>保存设置</button></div>`}
    ${sy.shadow ? section("账号", profileRow()) : accountSection(sy)}
    ${projectsSection()}
    ${section("记录", pauseRow
      + `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">开机自动启动</div><div class="mx-setting-desc">登录后自动开始记录，不用每次手动打开。</div></div>
        <button class="mx-switch" role="switch" id="login" aria-checked="${!!st.login_item}" aria-label="开机自动启动"></button></div>
      <div class="block"><div><div class="mx-setting-name">不记录的 app</div><div class="mx-setting-desc">写 app 名或 bundle id。这些 app 在前台时只记「在用它」和时长，窗口标题、输入、点击、界面文字都不记。</div></div>
        ${dr.blocklist.length ? `<div class="mx-chips" id="chips">${dr.blocklist.map((b, i) => `<button class="mx-chip" data-i="${i}" title="移出">${esc(b)}${ICON.close}</button>`).join("")}</div>` : ""}
        <div class="inline"><input class="mx-input mono" id="block-new" placeholder="比如 1Password 或 com.1password.1password" aria-label="不记录的 app"><button class="mx-btn mx-btn--secondary" id="block-add">加入</button></div></div>`)}
    ${section("手表录音与位置", `<p class="note" style="margin:0 0 10px">手表录的对话（转写后的文字）和 iPhone 的停留点存在你自己的录音服务器上，这里每 10 分钟拉一次到本机。音频不经过这台电脑。</p>
      <div class="mx-field"><label for="relay">录音服务器地址</label><input class="mx-input mono${relayBad ? " is-error" : ""}" id="relay" data-k="relay_server" placeholder="https://audio.example.com" value="${esc(dr.relay_server || "")}">${relayBad ? `<div class="mx-field-error">地址要以 https:// 开头</div>` : ""}</div>
      <div class="mx-setting" style="border-top:1px solid var(--line)"><div class="mx-setting-main"><div class="mx-setting-name">口令</div><div class="mx-setting-desc">${S.settings.relay_server && st.relay_sync ? esc(st.relay_sync) : `存进${KEY_STORE}，页面读不到。`}</div></div>
        <span class="mx-status mx-status--${S.settings.has_relay_token ? "ok" : "warn"}">${S.settings.has_relay_token ? "已存" : "还没有"}</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="relay-key">${S.settings.has_relay_token ? "换一个" : "存一个"}</button></div>`)}
    ${section("数据", delRow + `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">数据目录</div><div class="mx-setting-desc mono">~/Library/Application Support/Beayy/</div></div><button class="mx-btn mx-btn--secondary" id="open-dir">在访达中打开</button></div>
      <div class="mx-field" style="padding-top:14px"><label for="repo">人生记录仓库（日数据包和日总结从这里读）</label><input class="mx-input mono" id="repo" data-k="repo_path" value="${esc(dr.repo_path)}"></div>`)}
    ${section("外观", `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">主题</div></div>
      <div class="mx-seg" role="tablist" id="theme">${THEMES.map(([k, v]) => `<button role="tab" aria-selected="${k === theme}" class="${k === theme ? "is-on" : ""}" data-theme="${k}">${v}</button>`).join("")}</div></div>`)}
    ${aboutSection()}
    <details class="adv" ${SS.advanced || gwBad ? "open" : ""} id="adv"><summary>高级：摘要用的网关、模型和密钥</summary><div class="stack">
        <div class="mx-field"><label for="gw">网关地址</label><input class="mx-input mono${gwBad ? " is-error" : ""}" id="gw" data-k="gateway" value="${esc(dr.gateway)}">${gwBad ? `<div class="mx-field-error">网关地址要以 https:// 开头，比如 https://api.openai.com/v1</div>` : ""}</div>
        <div class="mx-field"><label for="m1">10 分钟摘要的模型</label><input class="mx-input mono" id="m1" data-k="model_segment" value="${esc(dr.model_segment)}"></div>
        <div class="mx-setting" style="border-top:1px solid var(--line)"><div class="mx-setting-main"><div class="mx-setting-name">网关密钥</div><div class="mx-setting-desc">先找环境变量，再找${KEY_STORE}。存进${KEY_STORE}的只能写入，页面读不到。</div></div>
          <span class="mx-status mx-status--${keySrc ? "ok" : "warn"}">${KEY_SOURCE[keySrc] || "还没有"}</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="key-edit">${keySrc === "keychain" ? "换一把" : "存一把"}</button></div></div></details>
  </div>`;

  const rerender = () => { const f = document.activeElement && document.activeElement.id; renderSettings().then(() => { const el = f && document.getElementById(f); if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }); };
  $app.querySelectorAll("[data-k]").forEach((el) => {
    el.oninput = () => { const was = same(S.draft, S.settings); S.draft[el.dataset.k] = el.value; if (was !== same(S.draft, S.settings)) rerender(); };
    el.onchange = () => rerender();
  });
  bindAccount();
  bindProfile();
  bindProjects();
  bindAbout();
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
  document.getElementById("key-edit").onclick = () => openDialog({
    title: keySrc === "keychain" ? "换一把网关密钥" : "存一把网关密钥", ok: `存进${KEY_STORE}`,
    body: dlgField("key", "密钥", { type: "password", ph: "sk-…", mono: true, help: IS_WIN ? "存在这台电脑的 Beayy 数据目录里（没有加密），只用来调你在上面填的网关。存好后页面读不到它。" : "存进这台电脑的钥匙串，只用来调你在上面填的网关。存好后页面读不到它。" }),
    submit: async (el) => {
      const k = dlgVal(el, "key");
      if (!k) throw "先把密钥粘进上面的框。";
      try { await call("set_api_key", { key: k }); } catch (x) { throw IS_WIN ? `没存进去：${x}` : `没存进钥匙串：${x}。再点一次；还不行就看钥匙串访问里同名条目是否被锁住。`; }
      S.settings = await call("get_settings"); S.draft = { ...S.draft, has_api_key: true }; renderSettings();
    },
  });
  document.getElementById("relay-key").onclick = () => openDialog({
    title: "录音服务器口令", ok: `存进${KEY_STORE}`,
    body: dlgField("rkey", "口令", { type: "password", mono: true, help: "录音服务器 .env 里的 BEAYY_AUDIO_TOKEN。只用来从上面那个地址读转写和停留点。" }),
    submit: async (el) => {
      const k = dlgVal(el, "rkey");
      if (!k) throw "先把口令粘进上面的框。";
      try { await call("set_relay_token", { token: k }); } catch (x) { throw `没存进去：${x}`; }
      S.settings = { ...S.settings, has_relay_token: true }; renderSettings();
    },
  });
  document.getElementById("open-dir").onclick = () => call("open_data_dir");
  const discard = document.getElementById("discard");
  if (discard) {
    discard.onclick = () => { S.draft = JSON.parse(JSON.stringify(S.settings)); renderSettings(); };
    document.getElementById("save").onclick = async () => {
      const { has_api_key, api_key_source, has_relay_token, ...rest } = S.draft;
      rest.gateway = rest.gateway.trim();
      rest.relay_server = (rest.relay_server || "").trim();
      await call("save_settings", { settings: rest });
      S.settings = { ...rest, has_api_key: S.settings.has_api_key, api_key_source: S.settings.api_key_source, has_relay_token: S.settings.has_relay_token }; S.draft = JSON.parse(JSON.stringify(S.settings));
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
    IS_WIN ? `<h2>授权</h2><p class="ob-lead">Windows 上不用授权，直接下一步。</p><p class="ob-lead">记的内容和 Mac 一样：切换程序和窗口、打字和发出去的内容、点了什么、屏幕上的文字、在不在电脑前。以管理员身份运行的程序读不到；iPhone 记录要在 Mac 上读。杀毒软件可能把键盘监听当成可疑行为，放行 Beayy 即可。</p>`
    : `<h2>授权</h2><p class="ob-lead">macOS 要你亲自打开这三项权限。点「去授权」会打开系统设置，把 Beayy 的开关打开再回来。</p>
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
  const [page = "today", arg, arg2] = location.hash.replace(/^#\/?/, "").split("/");
  // 换页就关掉弹层；刚拿到恢复码那个必须点「我已存好」才关
  if (DLG && DLG.closable) closeDialog();
  S.page = ["today", "summary", "rules", "devices", "settings"].includes(page) ? page : "today";
  markNav(S.page);
  try {
    if (!S.days.length && !S.status) await boot();
    if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
    if (!S.settings.onboarded && TAURI) return renderOnboarding();
    if (S.page !== "devices") { DEV.id = null; stopEventsTimer(); }
    if (S.page === "summary") await renderSummary(arg);
    else if (S.page === "rules") await renderRules();
    else if (S.page === "devices") { if (arg) await renderDevice(decodeURIComponent(arg), arg2); else { DEV.id = null; stopEventsTimer(); await renderDevices(); } }
    else if (S.page === "settings") await renderSettings();
    else await renderToday();
    document.getElementById("main").scrollTop = 0;
  } catch (e) {
    $app.innerHTML = header("出错了") + `<p class="mx-error">${esc(e && e.message ? e.message : e)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  for (const menu of document.querySelectorAll(".pick .mx-menu")) if (!menu.hidden && !menu.parentElement.contains(e.target)) menu.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const menu of document.querySelectorAll(".pick .mx-menu")) menu.hidden = true;
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

// Windows 采集线程：打字与发送、快捷键、点击、滚动、切 app、窗口变化、界面文字调度、在场与心跳、暂停、不记录的 app。
// 结构和 macos/capture.rs 一一对应，事件名和字段一样；判断逻辑（防抖、发送判断、按键统计、黑名单、去重）用 common 里同一份。
//
// 线程：所有状态都在这一条线程上，不用加锁。键鼠和系统通知由消息线程（hooks.rs）收下、经通道送来；
// 按坐标取元素、读界面文字这类慢操作交给 UIA 工作线程，和 macOS 的 AX 工作线程一样。

use super::hooks::{self, HOOK_HITS, MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN};
use super::sys::*;
use super::uia::{self, El, Uia};
use super::{ActorRaw, Ev};
use crate::common::*;
use beayy_core::{fields, EventLog};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

/// settings.json 里还没有 blacklist 时的默认值（按 exe 文件名也能命中）
const DEFAULT_BLOCKLIST: &[&str] = &["1password"];
/// 每秒看一次前台窗口和标题（切换由系统通知即时送来，这里兜底、顺带看标题变化）
const FOREGROUND_POLL: f64 = 1.0;
/// 钩子被系统悄悄摘掉时重装，最多每 5 分钟一次
const REHOOK_MIN_GAP: f64 = 300.0;

/// UIA 工作线程的活
enum Work {
    Click { button: &'static str, x: i32, y: i32, actor: Value },
    Ui { hwnd: Hwnd, app: Map<String, Value>, title: String, trigger: &'static str },
}

/// 规则 win-v0：没有注入标记算「人」，程序注入的（SendInput、自动化工具、部分远程控制软件）算「代理」。
/// Windows 查不到注入方是哪个进程，source_proc 留空；原始标记全部记下，规则不对可以离线重算。
fn actor_info(a: ActorRaw) -> Value {
    json!({
        "kind": if a.injected { "agent" } else { "human" },
        "source_proc": "",
        "injected": a.injected,
        "lower_il_injected": a.lower_il,
        "extra_info": a.extra as u64,
        "rule": "win-v0",
    })
}

struct Capture {
    log: Arc<EventLog>,
    paused: Arc<AtomicBool>,
    paused_seen: bool,
    worker: Sender<Work>,
    sched: Scheduler<Capture>,
    uia: Option<Uia>,

    hooks_failed_logged: bool,
    hits_seen: u64,
    last_rehook: Option<Instant>,

    // 当前这一段打字
    burst_start: Option<Instant>,
    burst_element: Option<El>,
    burst_app: Map<String, Value>,
    burst_window: String,
    burst_stats: KeyStats,
    last_value: String,
    burst_pid: Pid,
    generation: u64,
    typed: String,

    // 滚动
    scroll_ticks: i64,
    scroll_actor: Value,

    // 前台窗口
    fg_pid: Pid,
    fg_hwnd: Hwnd,
    fg_title: String,

    // 界面文字
    observed_pid: Pid,
    last_walk: Option<Instant>,

    blocklist: Blocklist,

    // 在场
    active: Option<bool>,
    last_heartbeat: Option<Instant>,
    locked: bool,
    asleep: bool,
}

/// 启动采集线程和 UIA 工作线程，返回发给采集线程的通道
pub fn spawn(log: Arc<EventLog>, paused: Arc<AtomicBool>) -> Sender<Ev> {
    let (tx, rx) = channel::<Ev>();
    let me = tx.clone();
    std::thread::Builder::new()
        .name("beayy-capture".into())
        .spawn(move || {
            let worker = spawn_worker(log.clone(), me);
            let mut c = Capture::new(log, paused, worker);
            c.run(rx);
        })
        .expect("启动采集线程失败");
    tx
}

fn spawn_worker(log: Arc<EventLog>, me: Sender<Ev>) -> Sender<Work> {
    let (tx, rx) = channel::<Work>();
    std::thread::Builder::new()
        .name("beayy-uia".into())
        .spawn(move || {
            let uia = Uia::new(800);
            let mut dedupe = UiDedupe::default();
            for w in rx {
                match w {
                    Work::Click { button, x, y, actor } => {
                        let mut f = fields! {"button" => button, "x" => x, "y" => y, "actor" => actor};
                        match uia.as_ref().and_then(|u| u.at_point(x, y)) {
                            Some(el) => {
                                f.insert("element".into(), Value::Object(uia::describe(&el)));
                                let pid = uia::pid(&el);
                                merge(&mut f, app_info(pid));
                                if pid > 0 {
                                    f.insert("window_title".into(), json!(window_text(root_window_at(x, y))));
                                }
                            }
                            None => {
                                if let Some((pid, _, _)) = frontmost() {
                                    merge(&mut f, app_info(pid));
                                }
                            }
                        }
                        log.write("mouse.click", f, None);
                        let _ = me.send(Ev::ScheduleUi("click", 0.8));
                    }
                    Work::Ui { hwnd, app, title, trigger } => {
                        if let Some(snap) = uia.as_ref().and_then(|u| u.read_window(hwnd, app, title, trigger)) {
                            dedupe.write(&log, snap);
                        }
                    }
                }
            }
        })
        .expect("启动 UIA 工作线程失败");
    tx
}

impl Capture {
    fn new(log: Arc<EventLog>, paused: Arc<AtomicBool>, worker: Sender<Work>) -> Self {
        let paused_seen = paused.load(Ordering::Relaxed);
        Capture {
            log,
            paused,
            paused_seen,
            worker,
            sched: Scheduler::default(),
            // 读输入框在这条线程上，单次最多等 0.3 秒（同 macOS 的 AXUIElementSetMessagingTimeout）
            uia: Uia::new(300),
            hooks_failed_logged: false,
            hits_seen: 0,
            last_rehook: None,
            burst_start: None,
            burst_element: None,
            burst_app: Map::new(),
            burst_window: String::new(),
            burst_stats: KeyStats::default(),
            last_value: String::new(),
            burst_pid: 0,
            generation: 0,
            typed: String::new(),
            scroll_ticks: 0,
            scroll_actor: Value::Null,
            fg_pid: 0,
            fg_hwnd: 0,
            fg_title: String::new(),
            observed_pid: 0,
            last_walk: None,
            blocklist: Blocklist::new(DEFAULT_BLOCKLIST),
            active: None,
            last_heartbeat: None,
            locked: false,
            asleep: false,
        }
    }

    fn write(&self, ty: &str, f: Map<String, Value>) {
        self.log.write(ty, f, None);
    }

    fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    fn run(&mut self, rx: Receiver<Ev>) {
        // Windows 没有对应的系统授权；和 macOS 一样启动时记一次权限状态
        self.write("permission.changed", fields! {"before" => json!({}), "after" => super::permissions()});
        self.blocklist.reload();
        if let Some((pid, path, h)) = frontmost() {
            // 启动时如果正在锁屏，前台是锁屏界面 LockApp
            self.locked = exe_stem(&path).eq_ignore_ascii_case("LockApp");
            self.fg_pid = pid;
            self.fg_hwnd = h;
            self.fg_title = window_text(h);
            self.ui_app_activated(pid);
        }
        self.presence_tick();
        self.sched.after(PRESENCE_EVERY, Some("presence"), Box::new(|c| c.presence_loop()));
        self.sched.after(PERMISSION_EVERY, Some("permissions"), Box::new(|c| c.settings_loop()));
        self.sched.after(FOREGROUND_POLL, Some("foreground"), Box::new(|c| c.foreground_loop()));

        loop {
            let wait = self.sched.next_in().clamp(0.0, 0.25);
            let first = match rx.recv_timeout(Duration::from_secs_f64(wait)) {
                Ok(e) => Some(e),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            for e in first.into_iter().chain(std::iter::from_fn(|| rx.try_recv().ok())) {
                if let Some(done) = self.handle(e) {
                    let _ = done.send(());
                    // 退出前停住，不再接新事件；进程马上就要结束
                    loop {
                        std::thread::park();
                    }
                }
            }
            self.check_paused();
            for t in self.sched.take_due() {
                t(self);
            }
        }
    }

    fn handle(&mut self, e: Ev) -> Option<Sender<()>> {
        match e {
            Ev::Key { vk, mods, actor } => self.key_down(vk, mods, actor),
            Ev::Mouse { button, x, y, actor } => self.mouse_down(button, x, y, actor),
            Ev::Scroll { actor } => self.scroll(actor),
            Ev::Foreground(h) => self.on_foreground(h),
            Ev::System(ty) => self.system_event(ty),
            Ev::ScheduleUi(trigger, delay) => self.ui_schedule(trigger, delay),
            Ev::Hooks { ok, error, reinstall } => {
                if ok {
                    self.hooks_failed_logged = false;
                    self.write(if reinstall { "tap.reenabled" } else { "tap.started" }, Map::new());
                } else if !self.hooks_failed_logged {
                    // 失败只在状态变化时记一次
                    self.write("tap.failed", fields! {"error" => error, "permissions" => super::permissions()});
                    self.hooks_failed_logged = true;
                }
            }
            Ev::Quit(done) => {
                self.flush_text("quit");
                return Some(done);
            }
        }
        None
    }

    /// 暂停／继续：先把正在打的字落盘再记暂停
    fn check_paused(&mut self) {
        let p = self.paused();
        if p == self.paused_seen {
            return;
        }
        if p {
            self.flush_text("pause");
            self.sched.cancel("ui");
        }
        self.paused_seen = p;
        self.write(if p { "app.paused" } else { "app.resumed" }, Map::new());
    }

    fn settings_loop(&mut self) {
        self.blocklist.reload();
        self.sched.after(PERMISSION_EVERY, Some("permissions"), Box::new(|c| c.settings_loop()));
    }

    /// 这个进程是不是不记录的 app（app 名、程序路径、exe 文件名任一命中）
    fn blocked(&mut self, pid: Pid) -> bool {
        self.blocklist.blocked(pid as i64, || {
            let (name, path) = app_names(pid);
            vec![name, exe_stem(&path), path]
        })
    }

    fn front_blocked(&mut self) -> bool {
        match frontmost() {
            Some((pid, _, _)) => self.blocked(pid),
            None => false,
        }
    }

    // ---------- 切 app、窗口变化 ----------

    fn foreground_loop(&mut self) {
        let h = foreground_hwnd();
        if h != 0 && h != self.fg_hwnd {
            self.on_foreground(h);
        } else if h != 0 {
            let t = window_text(h);
            if t != self.fg_title {
                self.fg_title = t;
                self.window_changed("AXTitleChanged");
            }
        }
        self.sched.after(FOREGROUND_POLL, Some("foreground"), Box::new(|c| c.foreground_loop()));
    }

    /// 前台窗口换了：换了进程＝切 app，同一进程换窗口＝window.changed
    fn on_foreground(&mut self, h: Hwnd) {
        if h == 0 {
            return;
        }
        let pid = window_pid(h);
        if pid != self.fg_pid {
            self.fg_pid = pid;
            self.fg_hwnd = h;
            self.fg_title = window_text(h);
            self.app_activated(pid);
        } else if h != self.fg_hwnd {
            self.fg_hwnd = h;
            self.fg_title = window_text(h);
            self.window_changed("AXFocusedWindowChanged");
        }
    }

    /// 切 app：先把上一段打字落盘，再记新 app 和窗口标题。
    /// Alt+Tab 时前台会先闪到任务切换界面，0.3 秒内连切只记最后一个
    fn app_activated(&mut self, pid: Pid) {
        self.flush_text("app_switch");
        if self.paused() {
            return;
        }
        self.sched.after(
            0.3,
            Some("activate"),
            Box::new(move |c| {
                if c.fg_pid != pid {
                    return;
                }
                let mut f = app_info(pid);
                // 不记录的 app：只记切到了它（时长才算得对），窗口标题和里面的内容都不记
                if c.blocked(pid) {
                    f.insert("blocked".into(), json!(true));
                } else {
                    f.insert("window_title".into(), json!(window_text(c.fg_hwnd)));
                }
                c.write("app.activated", f);
                c.ui_app_activated(pid);
            }),
        );
    }

    fn window_changed(&mut self, change: &str) {
        if self.paused() || self.blocked(self.fg_pid) {
            return;
        }
        let mut f = app_info(self.fg_pid);
        f.insert("window_title".into(), json!(self.fg_title));
        f.insert("change".into(), json!(change));
        self.write("window.changed", f);
        self.ui_schedule("window_changed", 0.6);
    }

    // ---------- 鼠标 ----------

    fn mouse_down(&mut self, button: &'static str, x: i32, y: i32, actor: ActorRaw) {
        if self.paused() || self.front_blocked() {
            return;
        }
        self.flush_text("mouse_click");
        // 按坐标取元素可能慢，放到工作线程
        let _ = self.worker.send(Work::Click { button, x, y, actor: actor_info(actor) });
    }

    /// 一段连续滚动记一条（停 1.5 秒算结束），结束后补读界面文字
    fn scroll(&mut self, actor: ActorRaw) {
        if self.paused() || self.front_blocked() {
            return;
        }
        if self.scroll_ticks == 0 {
            self.scroll_actor = actor_info(actor);
        }
        self.scroll_ticks += 1;
        self.sched.after(
            1.5,
            Some("scroll"),
            Box::new(|c| {
                if c.front_blocked() {
                    c.scroll_ticks = 0;
                    return;
                }
                let mut f = fields! {"ticks" => c.scroll_ticks, "actor" => c.scroll_actor.clone()};
                if let Some((pid, _, h)) = frontmost() {
                    merge(&mut f, app_info(pid));
                    f.insert("window_title".into(), json!(window_text(h)));
                }
                c.write("mouse.scroll", f);
                c.scroll_ticks = 0;
                c.ui_schedule("scroll", 0.2);
            }),
        );
    }

    // ---------- 键盘 ----------

    fn key_down(&mut self, vk: u32, mods: u8, actor: ActorRaw) {
        if self.paused() || is_modifier(vk) || self.front_blocked() {
            return;
        }
        let actor = actor_info(actor);
        let (ctrl, alt, shift, win) = (mods & MOD_CTRL != 0, mods & MOD_ALT != 0, mods & MOD_SHIFT != 0, mods & MOD_WIN != 0);

        // Ctrl / Alt / Win 组合键：记成快捷键，不算打字（对应 macOS 的 ⌘ / ⌃）
        if ctrl || alt || win {
            let mut keys = String::new();
            for (on, name) in [(ctrl, "Ctrl+"), (alt, "Alt+"), (shift, "Shift+"), (win, "Win+")] {
                if on {
                    keys += name;
                }
            }
            keys += &key_name(vk);
            let mut f = fields! {"keys" => keys, "keycode" => vk, "actor" => actor};
            if let Some((pid, _, _)) = frontmost() {
                merge(&mut f, app_info(pid));
            }
            self.write("keyboard.shortcut", f);
            return;
        }

        // 回车 / 小键盘回车（不带 Shift）：可能是「发送」
        if vk == VK_RETURN.0 as u32 && !shift {
            if self.burst_start.is_some() {
                self.burst_stats.note(&actor);
                self.typed += "⏎";
            }
            self.check_submit(actor);
            return;
        }

        // 方向键、功能键等：不算打字
        let Some(chars) = key_char(vk, shift) else { return };

        if self.burst_start.is_none() {
            self.burst_start = Some(Instant::now());
            self.last_value.clear();
            if let Some((pid, _, h)) = frontmost() {
                self.burst_pid = pid;
                self.burst_app = app_info(pid);
                self.burst_window = window_text(h);
                self.burst_element = self.uia.as_ref().and_then(|u| u.focused());
            }
        }
        self.burst_stats.note(&actor);
        if self.typed.chars().count() < TYPED_MAX {
            self.typed += &chars;
        }
        self.schedule_snapshot();

        if self.burst_start.map(|s| s.elapsed().as_secs_f64() >= TEXT_MAX_CONTINUOUS).unwrap_or(false) {
            self.flush_text("max_duration");
        } else {
            self.schedule_flush();
        }
    }

    /// 按键后稍等读一次输入框，留住「回车前」的内容
    fn schedule_snapshot(&mut self) {
        self.sched.after(
            SNAPSHOT_DELAY,
            Some("snapshot"),
            Box::new(|c| {
                c.refocus();
                if let Some(el) = &c.burst_element {
                    let v = clean_text(&uia::element_value(el, VALUE_MAX));
                    if !v.is_empty() {
                        c.last_value = v;
                    }
                }
            }),
        );
    }

    fn schedule_flush(&mut self) {
        self.sched.after(TEXT_DEBOUNCE, Some("flush"), Box::new(|c| c.flush_text("debounce")));
    }

    /// 回车后再读一次：刚打的字从输入框里消失了，就是发送了，记 `keyboard.submit`；
    /// 否则是换行或输入法上屏，继续当作同一段打字。
    fn check_submit(&mut self, actor: Value) {
        self.refocus();
        let before = self.last_value.clone();
        let gen = self.generation;
        let element = self.burst_element.clone().or_else(|| self.uia.as_ref().and_then(|u| u.focused()));
        self.sched.after(
            SUBMIT_CHECK_DELAY,
            None,
            Box::new(move |c| {
                if c.generation != gen {
                    return; // 这一段已经记过发送（连按回车）
                }
                let after = clean_text(&element.as_ref().map(|e| uia::element_value(e, VALUE_MAX)).unwrap_or_default());
                if submit_cleared(&before, &after) {
                    c.emit_text("keyboard.submit", &before, "return_cleared", Some(actor));
                    c.ui_schedule("submit", 0.8);
                    c.reset_burst();
                } else if c.burst_start.is_some() {
                    if !after.is_empty() {
                        c.last_value = after;
                    }
                    c.schedule_flush();
                } else {
                    // 没有打字过程的回车（比如在列表里回车打开），只记一下动作
                    let mut f = fields! {"actor" => actor};
                    if let Some((pid, _, _)) = frontmost() {
                        merge(&mut f, app_info(pid));
                    }
                    c.write("keyboard.return", f);
                }
            }),
        );
    }

    /// 把当前这段打字落成一条 `keyboard.text_input`
    fn flush_text(&mut self, reason: &str) {
        if self.burst_start.is_none() {
            return;
        }
        let current = clean_text(&self.burst_element.as_ref().map(|e| uia::element_value(e, VALUE_MAX)).unwrap_or_default());
        let text = flush_value(current, &self.last_value);
        self.emit_text("keyboard.text_input", &text, reason, None);
        self.ui_schedule("typing", 0.6);
        self.reset_burst();
    }

    fn emit_text(&self, ty: &str, text: &str, reason: &str, actor: Option<Value>) {
        let mut f = self.burst_app.clone();
        f.insert("window_title".into(), json!(self.burst_window));
        f.insert("text".into(), json!(text));
        let secure = self.burst_element.as_ref().map(uia::is_secure).unwrap_or(false);
        f.insert("typed".into(), json!(if secure { "[REDACTED]" } else { self.typed.as_str() }));
        f.insert("reason".into(), json!(reason));
        self.burst_stats.fill(&mut f);
        if let Some(actor) = actor {
            f.insert("submit_actor".into(), actor);
        }
        if let Some(el) = &self.burst_element {
            let mut d = uia::describe(el);
            d.remove("value");
            f.insert("element".into(), Value::Object(d));
        }
        self.write(ty, f);
    }

    fn reset_burst(&mut self) {
        self.sched.cancel("flush");
        self.sched.cancel("snapshot");
        self.burst_start = None;
        self.burst_element = None;
        self.burst_app = Map::new();
        self.burst_window.clear();
        self.burst_stats.clear();
        self.last_value.clear();
        self.typed.clear();
        self.burst_pid = 0;
        self.generation += 1;
    }

    /// 第一个按键那一刻抓到的焦点可能是外层容器，打字过程中重新确认：当前焦点是同一进程里的文字输入框，就换成它。
    fn refocus(&mut self) {
        if self.burst_pid == 0 {
            return;
        }
        let Some(el) = self.uia.as_ref().and_then(|u| u.focused()) else { return };
        if self.burst_element.is_none() || (uia::pid(&el) == self.burst_pid && uia::is_text_control(uia::control_type(&el))) {
            self.burst_element = Some(el);
        }
    }

    // ---------- 界面文字调度 ----------

    /// 安排一次读取；短时间内多次触发只读最后一次
    fn ui_schedule(&mut self, trigger: &'static str, delay: f64) {
        if self.paused() {
            return;
        }
        self.sched.after(delay, Some("ui"), Box::new(move |c| c.ui_capture(trigger)));
    }

    fn ui_capture(&mut self, trigger: &'static str) {
        let Some((pid, _, h)) = frontmost() else { return };
        if pid == std::process::id() || self.blocked(pid) {
            return;
        }
        self.last_walk = Some(Instant::now());
        let _ = self.worker.send(Work::Ui { hwnd: h, app: app_info(pid), title: window_text(h), trigger });
    }

    fn ui_app_activated(&mut self, pid: Pid) {
        if pid == self.observed_pid {
            return;
        }
        self.observed_pid = pid;
        self.ui_schedule("app_activated", 0.5);
    }

    // ---------- 在场 ----------

    fn system_event(&mut self, ty: &'static str) {
        self.write(ty, Map::new());
        match ty {
            "system.sleep" | "screen.sleep" => self.asleep = true,
            "system.wake" | "screen.wake" => self.asleep = false,
            "screen.locked" => self.locked = true,
            "screen.unlocked" => self.locked = false,
            _ => {}
        }
        self.presence_tick();
    }

    fn presence_loop(&mut self) {
        self.presence_tick();
        self.sched.after(PRESENCE_EVERY, Some("presence"), Box::new(|c| c.presence_loop()));
    }

    /// 锁屏、睡眠或熄屏都算离开
    fn presence_tick(&mut self) {
        let idle = idle_seconds();
        let now_active = !self.locked && !self.asleep && idle < IDLE_THRESHOLD;
        let state = if now_active { "active" } else { "idle" };
        if self.active != Some(now_active) {
            self.write("presence", fields! {"state" => state, "idle_seconds" => idle as i64});
            self.active = Some(now_active);
        }
        if self.last_heartbeat.map(|t| t.elapsed().as_secs_f64() >= HEARTBEAT_EVERY).unwrap_or(true) {
            let mut f = fields! {"idle_seconds" => idle as i64, "state" => state};
            if let Some((pid, _, h)) = frontmost() {
                merge(&mut f, app_info(pid));
                if self.blocked(pid) {
                    f.insert("blocked".into(), json!(true));
                } else {
                    f.insert("window_title".into(), json!(window_text(h)));
                }
            }
            self.write("heartbeat", f);
            self.last_heartbeat = Some(Instant::now());
        }
        // 最近 30 秒有人操作，界面文字按间隔补读
        if idle < 30.0 && self.last_walk.map(|t| t.elapsed().as_secs_f64() >= UI_REFRESH).unwrap_or(true) {
            self.ui_schedule("refresh", 0.0);
        }
        self.check_hooks(idle);
    }

    /// 钩子回调超时太多次，系统会不打招呼地把钩子摘掉。系统记到最近有键鼠、钩子这 10 秒却一次没被调，就重装一次。
    /// （以管理员身份运行的窗口在前台时，钩子本来就收不到它的输入，也会走到这里，所以限频）
    fn check_hooks(&mut self, idle: f64) {
        let hits = HOOK_HITS.load(Ordering::Relaxed);
        let quiet = hits == self.hits_seen;
        self.hits_seen = hits;
        if hooks::HOOKS_OK.load(Ordering::Relaxed)
            && quiet
            && !self.locked
            && !self.asleep
            && idle < PRESENCE_EVERY - 1.0
            && self.last_rehook.map(|t| t.elapsed().as_secs_f64() >= REHOOK_MIN_GAP).unwrap_or(true)
        {
            self.last_rehook = Some(Instant::now());
            hooks::rehook();
        }
    }
}

// ---------- 键码 ----------

fn is_modifier(vk: u32) -> bool {
    [
        VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN,
        VK_CAPITAL, VK_NUMLOCK, VK_SCROLL, VK_APPS,
    ]
    .iter()
    .any(|k| k.0 as u32 == vk)
}

/// 前台窗口所在线程的键盘布局（不同窗口可以用不同布局）
fn foreground_layout() -> HKL {
    unsafe { GetKeyboardLayout(GetWindowThreadProcessId(hwnd(foreground_hwnd()), None)) }
}

/// 布局里这个键不按 Shift 时的字符（MapVirtualKeyExW 不碰输入法和死键的状态，可以放心调）
fn base_char(vk: u32) -> Option<char> {
    let c = unsafe { MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR, Some(foreground_layout())) } & 0x7FFF_FFFF;
    char::from_u32(c).filter(|c| *c != '\0' && !c.is_control())
}

/// 打字键的字符（只当按键原文用，正文以输入框的值为准）。和 macOS 一样：空格、Tab、Esc、退格算打字，
/// 方向键、功能键、Delete 不算。Shift 按美式键盘换算，不看大写锁定。
fn key_char(vk: u32, shift: bool) -> Option<String> {
    let k = VIRTUAL_KEY(vk as u16);
    let special = match k {
        VK_SPACE => Some(" "),
        VK_TAB => Some("\t"),
        VK_ESCAPE => Some("\u{1b}"),
        VK_BACK => Some("\u{7f}"),
        VK_RETURN => Some("\r"),
        _ => None,
    };
    if let Some(s) = special {
        return Some(s.into());
    }
    let c = base_char(vk)?;
    if !shift {
        return Some(c.to_lowercase().collect());
    }
    const PLAIN: &str = "1234567890-=[]\\;',./`";
    const SHIFTED: &str = "!@#$%^&*()_+{}|:\"<>?~";
    let c = match PLAIN.find(c) {
        Some(i) if !(VK_NUMPAD0.0..=VK_DIVIDE.0).contains(&k.0) => SHIFTED[i..].chars().next().unwrap_or(c),
        _ => c,
    };
    Some(c.to_uppercase().collect())
}

/// 快捷键里键的名字：字母数字写大写字符，其余用常见叫法
fn key_name(vk: u32) -> String {
    let k = VIRTUAL_KEY(vk as u16);
    let named = match k {
        VK_RETURN => "Enter",
        VK_TAB => "Tab",
        VK_ESCAPE => "Esc",
        VK_SPACE => "Space",
        VK_BACK => "Backspace",
        VK_DELETE => "Delete",
        VK_INSERT => "Insert",
        VK_HOME => "Home",
        VK_END => "End",
        VK_PRIOR => "PageUp",
        VK_NEXT => "PageDown",
        VK_LEFT => "Left",
        VK_RIGHT => "Right",
        VK_UP => "Up",
        VK_DOWN => "Down",
        VK_SNAPSHOT => "PrintScreen",
        _ => "",
    };
    if !named.is_empty() {
        return named.into();
    }
    if (VK_F1.0..=VK_F24.0).contains(&k.0) {
        return format!("F{}", k.0 - VK_F1.0 + 1);
    }
    match base_char(vk) {
        Some(c) => c.to_uppercase().collect(),
        None => format!("VK{vk:02X}"),
    }
}

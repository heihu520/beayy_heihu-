// macOS 采集线程：键鼠监听、打字与发送、滚动、切 app、界面文字调度、在场与心跳、权限检查。
// 从 Swift 版 InteractionTap.swift、UIText.swift、Presence.swift、main.swift 移植，事件和字段一致。
// 键鼠监听的主体结构（被动 CGEventTap、按键只当计时、停顿后读输入框最终值、密码框打码）改编自 OpenChronicle
// （resources/mac-ax-watcher.swift 的 InteractionTapper），Copyright (c) 2026 Einsia，MIT，见 app/THIRD_PARTY_NOTICES.md。
// 本项目新增：操作者标记（人 / AI 代理）、回车发送检测、快捷键记录、暂停开关。
//
// 线程：所有状态都在这一条线程上（它自己的 CFRunLoop 挂着键鼠监听和辅助功能观察者），不用加锁。
// 监听回调只把事件的原始字段塞进队列，跑完一轮 run loop 再处理；按坐标取元素、读界面文字这类慢操作
// 交给 AX 工作线程。别的线程（主线程的系统通知、工作线程）通过 Msg 通道找它，发完唤醒它的 run loop。

#![allow(non_upper_case_globals)]

use super::ax::*;
use super::ffi::*;
use super::uitext::UiReader;
use beayy_core::{fields, EventLog};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 停顿多久算「打完一段」
const TEXT_DEBOUNCE: f64 = 5.0;
/// 连续打字的上限，超过就先落一条
const TEXT_MAX_CONTINUOUS: f64 = 60.0;
/// 每次按键后多久读一次输入框，用来在回车清空输入框之前留住原文
const SNAPSHOT_DELAY: f64 = 0.2;
/// 回车后多久再读一次，判断是「发送」（输入框被清空）还是换行 / 输入法上屏
const SUBMIT_CHECK_DELAY: f64 = 0.35;
/// 在场：超过 3 分钟没有键鼠算离开（和 ActivityWatch 默认一致），每 60 秒一条心跳，每 10 秒看一次
const IDLE_THRESHOLD: f64 = 180.0;
const HEARTBEAT_EVERY: f64 = 60.0;
const PRESENCE_EVERY: f64 = 10.0;
/// 有人在操作时，界面内容没变化也每隔多久补读一次（消息滚动进来、页面自己刷新）
const UI_REFRESH: f64 = 30.0;
const PERMISSION_EVERY: f64 = 5.0;

pub static TAP_RUNNING: AtomicBool = AtomicBool::new(false);

/// settings.json 里还没有 blacklist 时的默认值（和设置页显示的一致）
const DEFAULT_BLOCKLIST: &[&str] = &["com.1password.1password"];

/// 别的线程发给采集线程的消息
pub enum Msg {
    /// 切到了某个 app（主线程收到 NSWorkspace 通知）
    AppActivated(Pid),
    /// 睡眠、唤醒、锁屏、解锁（system.sleep 等事件名）
    System(&'static str),
    /// 安排一次界面文字读取（工作线程记完点击后）
    ScheduleUi(&'static str, f64),
    /// 退出前把正在打的字落盘，完成后回一声
    Quit(Sender<()>),
}

/// 发给采集线程：发完唤醒它的 run loop
#[derive(Clone)]
pub struct Handle {
    tx: Sender<Msg>,
    rl: Arc<RunLoopRef>,
}

struct RunLoopRef(CFRunLoopRef);
unsafe impl Send for RunLoopRef {}
unsafe impl Sync for RunLoopRef {}

impl Handle {
    pub fn send(&self, m: Msg) {
        let _ = self.tx.send(m);
        unsafe { CFRunLoopWakeUp(self.rl.0) };
    }
}

/// AX 工作线程的活
enum Work {
    Click { button: &'static str, x: f64, y: f64, actor: Value },
    Ui { pid: Pid, name: String, bundle: String, trigger: &'static str },
}

// ---------- 操作者标记 ----------

#[derive(Clone, Copy)]
struct ActorRaw {
    pid: i64,
    state_id: i64,
    user_data: i64,
}

/// 事件来源进程名
fn process_name(pid: Pid) -> String {
    if pid <= 0 {
        return String::new();
    }
    let (name, _) = app_names(pid);
    if !name.is_empty() {
        return name;
    }
    let mut buf = vec![0u8; 4 * 1024];
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if len <= 0 {
        return String::new();
    }
    let path = String::from_utf8_lossy(&buf[..len as usize]).into_owned();
    path.rsplit('/').next().unwrap_or("").to_string()
}

/// 规则 v0：来源进程号为 0，或来源是 WindowServer，算「人」；其他进程合成的事件算「代理」。
/// 原始字段全部记下，规则不对可以离线重算。
fn actor_info(a: ActorRaw) -> Value {
    let pid = a.pid as Pid;
    let name = process_name(pid);
    let kind = if pid == 0 || name == "WindowServer" {
        "human"
    } else if pid == std::process::id() as Pid {
        "self"
    } else {
        "agent"
    };
    json!({"kind": kind, "source_pid": pid, "source_proc": name, "state_id": a.state_id, "user_data": a.user_data, "rule": "v0"})
}

/// 去掉零宽字符和首尾空白（飞书等富文本输入框会在段落里塞 \u{200B}）
fn clean_text(s: &str) -> String {
    s.replace(['\u{200B}', '\u{FEFF}'], "").trim().to_string()
}

/// 「刚打的字还在不在输入框里」。中文输入法组字时，回车会把拼音字母原样上屏（`liu'b` → `liub`），
/// 原文比较会误判成发送；所以先去掉 ASCII 字母、拼音分隔符和空白，只比汉字等其余部分。
/// 原文全是英文（去掉后为空）时，退回原样比较。
fn still_contains(after: &str, before: &str) -> bool {
    let core = |s: &str| -> String {
        s.chars().filter(|c| !(c.is_ascii_alphabetic() || *c == '\'' || c.is_ascii_whitespace() || *c == '\u{0B}')).collect()
    };
    let b = core(before);
    if b.is_empty() {
        after.contains(before)
    } else {
        core(after).contains(&b)
    }
}

// ---------- 监听回调：只收原始字段 ----------

enum Raw {
    Mouse { button: &'static str, x: f64, y: f64, actor: ActorRaw },
    Scroll { actor: ActorRaw },
    Key { actor: ActorRaw, flags: u64, keycode: i64, chars: String },
    TapDisabled,
    AxNote { element: CF, name: String },
}

thread_local! {
    static RAW: RefCell<VecDeque<Raw>> = const { RefCell::new(VecDeque::new()) };
}

fn push(r: Raw) {
    RAW.with(|q| q.borrow_mut().push_back(r));
}

fn actor_raw(e: CGEventRef) -> ActorRaw {
    unsafe {
        ActorRaw {
            pid: CGEventGetIntegerValueField(e, kCGEventSourceUnixProcessID),
            state_id: CGEventGetIntegerValueField(e, kCGEventSourceStateID),
            user_data: CGEventGetIntegerValueField(e, kCGEventSourceUserData),
        }
    }
}

extern "C" fn tap_callback(_proxy: *mut c_void, ty: u32, e: CGEventRef, _info: *mut c_void) -> CGEventRef {
    match ty {
        kCGEventLeftMouseDown | kCGEventRightMouseDown | kCGEventOtherMouseDown => {
            let p = unsafe { CGEventGetLocation(e) };
            let button = match ty {
                kCGEventLeftMouseDown => "left",
                kCGEventRightMouseDown => "right",
                _ => "other",
            };
            push(Raw::Mouse { button, x: p.x, y: p.y, actor: actor_raw(e) });
        }
        kCGEventScrollWheel => push(Raw::Scroll { actor: actor_raw(e) }),
        kCGEventKeyDown => {
            let mut buf = [0u16; 8];
            let mut len = 0usize;
            unsafe { CGEventKeyboardGetUnicodeString(e, 8, &mut len, buf.as_mut_ptr()) };
            push(Raw::Key {
                actor: actor_raw(e),
                flags: unsafe { CGEventGetFlags(e) },
                keycode: unsafe { CGEventGetIntegerValueField(e, kCGKeyboardEventKeycode) },
                chars: String::from_utf16_lossy(&buf[..len.min(8)]),
            });
        }
        kCGEventTapDisabledByTimeout | kCGEventTapDisabledByUserInput => push(Raw::TapDisabled),
        _ => {}
    }
    e
}

extern "C" fn ax_callback(_obs: AXObserverRef, el: AXUIElementRef, name: CFStringRef, _refcon: *mut c_void) {
    if let (Some(element), Some(name)) = (CF::retained(el), string_of(name)) {
        push(Raw::AxNote { element, name });
    }
}

extern "C" fn keepalive(_t: CFRunLoopTimerRef, _c: *mut c_void) {}

// ---------- 定时任务 ----------

type Task = Box<dyn FnOnce(&mut Capture)>;

struct Timer {
    at: Instant,
    key: Option<&'static str>,
    task: Task,
}

#[derive(Default)]
struct Scheduler {
    timers: Vec<Timer>,
}

impl Scheduler {
    /// 安排一个任务；带 key 的同名任务只留最新一个（相当于 DispatchWorkItem 先 cancel 再排）
    fn after(&mut self, secs: f64, key: Option<&'static str>, task: Task) {
        if key.is_some() {
            self.cancel(key.unwrap());
        }
        self.timers.push(Timer { at: Instant::now() + Duration::from_secs_f64(secs.max(0.0)), key, task });
    }
    fn cancel(&mut self, key: &str) {
        self.timers.retain(|t| t.key != Some(key));
    }
    fn next_in(&self) -> f64 {
        let now = Instant::now();
        self.timers.iter().map(|t| t.at.saturating_duration_since(now).as_secs_f64()).fold(f64::MAX, f64::min)
    }
    fn take_due(&mut self) -> Vec<Task> {
        let now = Instant::now();
        let mut due: Vec<Timer> = vec![];
        let mut i = 0;
        while i < self.timers.len() {
            if self.timers[i].at <= now {
                due.push(self.timers.remove(i));
            } else {
                i += 1;
            }
        }
        due.sort_by_key(|t| t.at);
        due.into_iter().map(|t| t.task).collect()
    }
}

// ---------- 采集线程的状态 ----------

struct Capture {
    log: Arc<EventLog>,
    paused: Arc<AtomicBool>,
    paused_seen: bool,
    worker: Sender<Work>,
    sched: Scheduler,
    rl: CFRunLoopRef,

    tap: Option<CF>,
    tap_source: Option<CF>,
    tap_failed_logged: bool,
    last_permissions: Option<(bool, bool, bool)>,

    // 当前这一段打字
    burst_start: Option<Instant>,
    burst_element: Option<CF>,
    burst_app: Map<String, Value>,
    burst_window: String,
    burst_keys: BTreeMap<String, i64>,
    burst_agents: BTreeSet<String>,
    last_value: String,
    burst_pid: Pid,
    generation: u64,
    typed: String,

    // 滚动
    scroll_ticks: i64,
    scroll_actor: Value,

    // 界面文字
    observer: Option<CF>,
    observed_pid: Pid,
    last_walk: Option<Instant>,

    // 不记录的 app（settings.json 的 blacklist，app 名或 bundle id，不分大小写）；每 5 秒看一次文件有没有改
    blocklist: Vec<String>,
    blocklist_mtime: Option<std::time::SystemTime>,
    blocked_cache: HashMap<Pid, bool>,

    // 在场
    active: Option<bool>,
    last_heartbeat: Option<Instant>,
    locked: bool,
    asleep: bool,
}

/// 启动采集线程和 AX 工作线程，返回发消息用的句柄
pub fn spawn(log: Arc<EventLog>, paused: Arc<AtomicBool>) -> Handle {
    let (tx, rx) = channel::<Msg>();
    let (htx, hrx) = channel::<Handle>();
    let log2 = log.clone();
    std::thread::Builder::new()
        .name("beayy-capture".into())
        .spawn(move || {
            let rl = unsafe { CFRunLoopGetCurrent() };
            // run loop 里没有任何源时 CFRunLoopRunInMode 会立刻返回；挂一个每小时一次的空计时器撑住
            unsafe {
                let t = CFRunLoopTimerCreate(std::ptr::null(), CFAbsoluteTimeGetCurrent() + 3600.0, 3600.0, 0, 0, keepalive, std::ptr::null_mut());
                CFRunLoopAddTimer(rl, t, kCFRunLoopDefaultMode);
            }
            let me = Handle { tx, rl: Arc::new(RunLoopRef(rl)) };
            let _ = htx.send(me.clone());
            let worker = spawn_worker(log2.clone(), me.clone());
            let mut c = Capture::new(log2, paused, worker, rl);
            c.run(rx);
        })
        .expect("启动采集线程失败");
    hrx.recv().expect("采集线程没起来")
}

fn spawn_worker(log: Arc<EventLog>, me: Handle) -> Sender<Work> {
    let (tx, rx) = channel::<Work>();
    std::thread::Builder::new()
        .name("beayy-ax".into())
        .spawn(move || {
            let mut ui = UiReader::default();
            for w in rx {
                objc2::rc::autoreleasepool(|_| match w {
                    Work::Click { button, x, y, actor } => {
                        let mut f = fields! {"button" => button, "x" => num(x), "y" => num(y), "actor" => actor};
                        let sys = CF::owned(unsafe { AXUIElementCreateSystemWide() });
                        let mut hit: AXUIElementRef = std::ptr::null();
                        let ok = sys.as_ref().map(|s| unsafe { AXUIElementCopyElementAtPosition(s.ptr(), x as f32, y as f32, &mut hit) } == kAXErrorSuccess).unwrap_or(false);
                        match (ok, CF::owned(hit)) {
                            (true, Some(el)) => {
                                f.insert("element".into(), Value::Object(describe(&el)));
                                let pid = element_pid(&el);
                                merge(&mut f, app_info(pid));
                                if pid > 0 {
                                    f.insert("window_title".into(), json!(window_title(pid)));
                                }
                            }
                            _ => {
                                if let Some((pid, _)) = frontmost() {
                                    merge(&mut f, app_info(pid));
                                }
                            }
                        }
                        log.write("mouse.click", f, None);
                        me.send(Msg::ScheduleUi("click", 0.8));
                    }
                    Work::Ui { pid, name, bundle, trigger } => ui.capture(&log, pid, &name, &bundle, trigger),
                });
            }
        })
        .expect("启动 AX 工作线程失败");
    tx
}

impl Capture {
    fn new(log: Arc<EventLog>, paused: Arc<AtomicBool>, worker: Sender<Work>, rl: CFRunLoopRef) -> Self {
        let paused_seen = paused.load(Ordering::Relaxed);
        Capture {
            log,
            paused,
            paused_seen,
            worker,
            sched: Scheduler::default(),
            rl,
            tap: None,
            tap_source: None,
            tap_failed_logged: false,
            last_permissions: None,
            burst_start: None,
            burst_element: None,
            burst_app: Map::new(),
            burst_window: String::new(),
            burst_keys: BTreeMap::new(),
            burst_agents: BTreeSet::new(),
            last_value: String::new(),
            burst_pid: 0,
            generation: 0,
            typed: String::new(),
            scroll_ticks: 0,
            scroll_actor: Value::Null,
            observer: None,
            observed_pid: 0,
            last_walk: None,
            blocklist: DEFAULT_BLOCKLIST.iter().map(|s| s.to_lowercase()).collect(),
            blocklist_mtime: None,
            blocked_cache: HashMap::new(),
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

    fn run(&mut self, rx: Receiver<Msg>) {
        self.request_missing_permissions();
        self.check_permissions();
        self.reload_blocklist();
        // 启动时如果正在锁屏（比如锁屏期间重新安装），前台是 loginwindow
        let front = frontmost();
        self.locked = front.as_ref().map(|(_, b)| b == "com.apple.loginwindow").unwrap_or(false);
        self.presence_tick();
        if let Some((pid, _)) = front {
            self.ui_app_activated(pid);
        }
        self.sched.after(PRESENCE_EVERY, Some("presence"), Box::new(|c| c.presence_loop()));
        self.sched.after(PERMISSION_EVERY, Some("permissions"), Box::new(|c| c.permission_loop()));

        loop {
            let quit = objc2::rc::autoreleasepool(|_| {
                let wait = self.sched.next_in().clamp(0.0, 0.25);
                unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, wait, 1) };
                while let Some(r) = RAW.with(|q| q.borrow_mut().pop_front()) {
                    self.handle_raw(r);
                }
                while let Ok(m) = rx.try_recv() {
                    if let Some(done) = self.handle_msg(m) {
                        return Some(done);
                    }
                }
                self.check_paused();
                for t in self.sched.take_due() {
                    t(self);
                }
                None
            });
            if let Some(done) = quit {
                let _ = done.send(());
                // 退出前停住，不再接新事件；进程马上就要结束
                loop {
                    std::thread::park();
                }
            }
        }
    }

    fn handle_msg(&mut self, m: Msg) -> Option<Sender<()>> {
        match m {
            Msg::AppActivated(pid) => self.app_activated(pid),
            Msg::System(ty) => self.system_event(ty),
            Msg::ScheduleUi(trigger, delay) => self.ui_schedule(trigger, delay),
            Msg::Quit(done) => {
                self.flush_text("quit");
                return Some(done);
            }
        }
        None
    }

    fn handle_raw(&mut self, r: Raw) {
        match r {
            Raw::Mouse { button, x, y, actor } => self.mouse_down(button, x, y, actor),
            Raw::Scroll { actor } => self.scroll(actor),
            Raw::Key { actor, flags, keycode, chars } => self.key_down(actor, flags, keycode, chars),
            Raw::TapDisabled => {
                if let Some(t) = &self.tap {
                    unsafe { CGEventTapEnable(t.ptr(), true) };
                }
                self.write("tap.reenabled", Map::new());
            }
            Raw::AxNote { element, name } => self.ax_note(element, name),
        }
    }

    /// 暂停／继续：先把正在打的字落盘再记暂停（同 Swift 版菜单的 togglePause）
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

    // ---------- 权限与监听 ----------

    /// 启动时缺哪项就向系统发起请求：输入监控会把 app 加进列表并弹窗，辅助功能弹窗并打开对应设置页。
    /// 开关只能由用户自己打开。
    fn request_missing_permissions(&self) {
        let p = super::permissions();
        if !p.input_monitoring {
            unsafe { CGRequestListenEventAccess() };
            self.write("permission.requested", fields! {"service" => "input_monitoring"});
        }
        if !p.accessibility {
            super::request_accessibility();
            self.write("permission.requested", fields! {"service" => "accessibility"});
        }
    }

    fn permission_loop(&mut self) {
        self.check_permissions();
        self.reload_blocklist();
        self.sched.after(PERMISSION_EVERY, Some("permissions"), Box::new(|c| c.permission_loop()));
    }

    /// 设置页改了不记录的 app 就重读（settings.json 和网页界面共用，在正式数据目录）
    fn reload_blocklist(&mut self) {
        // 测试版（--shadow）影子目录里有自己的 settings.json 就用它，测名单时不影响正式版
        let own = beayy_core::data_root().join("settings.json");
        let path = if beayy_core::shadow_mode() && own.exists() { own } else { beayy_core::default_root().join("settings.json") };
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if mtime.is_none() || mtime == self.blocklist_mtime {
            return;
        }
        self.blocklist_mtime = mtime;
        let raw: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.blocklist = match raw.get("blacklist").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect(),
            None => DEFAULT_BLOCKLIST.iter().map(|s| s.to_lowercase()).collect(),
        };
        self.blocked_cache.clear();
    }

    /// 这个进程是不是不记录的 app
    fn blocked(&mut self, pid: Pid) -> bool {
        if self.blocklist.is_empty() {
            return false;
        }
        if let Some(b) = self.blocked_cache.get(&pid) {
            return *b;
        }
        let (name, bundle) = app_names(pid);
        let b = self.blocklist.iter().any(|x| *x == name.to_lowercase() || *x == bundle.to_lowercase());
        self.blocked_cache.insert(pid, b);
        b
    }

    /// 前台是不记录的 app
    fn front_blocked(&mut self) -> bool {
        match frontmost() {
            Some((pid, _)) => self.blocked(pid),
            None => false,
        }
    }

    /// 每 5 秒看一次权限；变化就记一条，有输入监控或辅助功能任一项就试着装监听
    fn check_permissions(&mut self) {
        let p = super::permissions();
        let now = (p.accessibility, p.input_monitoring, p.full_disk_access);
        if self.last_permissions != Some(now) {
            let obj = |t: (bool, bool, bool)| json!({"accessibility": t.0, "input_monitoring": t.1, "full_disk_access": t.2});
            let before = self.last_permissions.map(obj).unwrap_or(json!({}));
            self.write("permission.changed", fields! {"before" => before, "after" => obj(now)});
            self.last_permissions = Some(now);
        }
        // 失败只在状态变化时记一次，免得每 5 秒刷一条
        if (p.input_monitoring || p.accessibility) && self.tap.is_none() && !self.start_tap() && !self.tap_failed_logged {
            self.write("tap.failed", fields! {"permissions" => p});
            self.tap_failed_logged = true;
        }
    }

    /// 装上被动监听。没有「输入监控」权限时会失败。
    fn start_tap(&mut self) -> bool {
        let mask: u64 = [kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown, kCGEventKeyDown, kCGEventScrollWheel]
            .iter()
            .fold(0, |m, t| m | (1u64 << t));
        let Some(tap) = CF::owned(unsafe { CGEventTapCreate(1, 0, 1, mask, tap_callback, std::ptr::null_mut()) }) else {
            return false;
        };
        let Some(src) = CF::owned(unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap.ptr(), 0) }) else {
            return false;
        };
        unsafe {
            CFRunLoopAddSource(self.rl, src.ptr(), kCFRunLoopDefaultMode);
            CGEventTapEnable(tap.ptr(), true);
        }
        self.tap = Some(tap);
        self.tap_source = Some(src);
        TAP_RUNNING.store(true, Ordering::Relaxed);
        self.write("tap.started", Map::new());
        true
    }

    // ---------- 切 app ----------

    /// 切 app：先把上一段打字落盘，再记新 app 和窗口标题
    fn app_activated(&mut self, pid: Pid) {
        self.flush_text("app_switch");
        if self.paused() {
            return;
        }
        self.sched.after(
            0.3,
            None,
            Box::new(move |c| {
                let mut f = app_info(pid);
                // 不记录的 app：只记切到了它（时长才算得对），窗口标题和里面的内容都不记
                if c.blocked(pid) {
                    f.insert("blocked".into(), json!(true));
                } else {
                    f.insert("window_title".into(), json!(window_title(pid)));
                }
                c.write("app.activated", f);
                c.ui_app_activated(pid);
            }),
        );
    }

    // ---------- 鼠标 ----------

    fn mouse_down(&mut self, button: &'static str, x: f64, y: f64, actor: ActorRaw) {
        if self.paused() || self.front_blocked() {
            return;
        }
        self.flush_text("mouse_click");
        // 按坐标取元素可能慢，放到工作线程，别拖住监听
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
                // 滚动收尾时前台已经切到不记录的 app：这一段不记
                if c.front_blocked() {
                    c.scroll_ticks = 0;
                    return;
                }
                let mut f = fields! {"ticks" => c.scroll_ticks, "actor" => c.scroll_actor.clone()};
                if let Some((pid, _)) = frontmost() {
                    merge(&mut f, app_info(pid));
                    f.insert("window_title".into(), json!(window_title(pid)));
                }
                c.write("mouse.scroll", f);
                c.scroll_ticks = 0;
                c.ui_schedule("scroll", 0.2);
            }),
        );
    }

    // ---------- 键盘 ----------

    fn key_down(&mut self, actor: ActorRaw, flags: u64, keycode: i64, chars: String) {
        if self.paused() || self.front_blocked() {
            return;
        }
        let actor = actor_info(actor);
        let has = |m: u64| flags & m != 0;

        // ⌘ / ⌃ 组合键：记成快捷键，不算打字
        if has(kCGEventFlagMaskCommand) || has(kCGEventFlagMaskControl) {
            let mut mods = String::new();
            if has(kCGEventFlagMaskControl) {
                mods += "⌃";
            }
            if has(kCGEventFlagMaskAlternate) {
                mods += "⌥";
            }
            if has(kCGEventFlagMaskShift) {
                mods += "⇧";
            }
            if has(kCGEventFlagMaskCommand) {
                mods += "⌘";
            }
            let mut f = fields! {"keys" => mods + &chars.to_uppercase(), "keycode" => keycode, "actor" => actor};
            if let Some((pid, _)) = frontmost() {
                merge(&mut f, app_info(pid));
            }
            self.write("keyboard.shortcut", f);
            return;
        }

        // 回车 / 小键盘回车（不带 ⇧ ⌥）：可能是「发送」
        if (keycode == 36 || keycode == 76) && !has(kCGEventFlagMaskShift) && !has(kCGEventFlagMaskAlternate) {
            if self.burst_start.is_some() {
                self.note_key(&actor);
                self.typed += "⏎";
            }
            self.check_submit(actor);
            return;
        }

        // 方向键、功能键等：不算打字
        if chars.is_empty() || chars.chars().any(|c| (0xF700..=0xF8FF).contains(&(c as u32))) {
            return;
        }

        if self.burst_start.is_none() {
            self.burst_start = Some(Instant::now());
            self.last_value.clear();
            if let Some((pid, _)) = frontmost() {
                self.burst_pid = pid;
                self.burst_app = app_info(pid);
                self.burst_window = window_title(pid);
                self.burst_element = app_element(pid).and_then(|a| focused_element(&a));
            }
        }
        self.note_key(&actor);
        if self.typed.chars().count() < 2000 {
            self.typed += &chars;
        }
        self.schedule_snapshot();

        if self.burst_start.map(|s| s.elapsed().as_secs_f64() >= TEXT_MAX_CONTINUOUS).unwrap_or(false) {
            self.flush_text("max_duration");
        } else {
            self.schedule_flush();
        }
    }

    fn note_key(&mut self, actor: &Value) {
        let kind = actor["kind"].as_str().unwrap_or("unknown").to_string();
        if kind == "agent" {
            if let Some(p) = actor["source_proc"].as_str() {
                self.burst_agents.insert(p.to_string());
            }
        }
        *self.burst_keys.entry(kind).or_insert(0) += 1;
    }

    /// 按键后稍等读一次输入框，留住「回车前」的内容
    fn schedule_snapshot(&mut self) {
        self.sched.after(
            SNAPSHOT_DELAY,
            Some("snapshot"),
            Box::new(|c| {
                c.refocus();
                if let Some(el) = &c.burst_element {
                    let v = clean_text(&element_value(el, 4000));
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
        let element = self
            .burst_element
            .clone()
            .or_else(|| frontmost().and_then(|(pid, _)| app_element(pid)).and_then(|a| focused_element(&a)));
        self.sched.after(
            SUBMIT_CHECK_DELAY,
            None,
            Box::new(move |c| {
                if c.generation != gen {
                    return; // 这一段已经记过发送（连按回车）
                }
                let after = clean_text(&element.as_ref().map(|e| element_value(e, 4000)).unwrap_or_default());
                // 不能只看「变空、变短」：飞书、ChatGPT 网页这类输入框清空后会显示提示文字，反而比原文长
                let cleared = !before.is_empty() && !still_contains(&after, &before);
                if cleared {
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
                    if let Some((pid, _)) = frontmost() {
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
        let mut text = clean_text(&self.burst_element.as_ref().map(|e| element_value(e, 4000)).unwrap_or_default());
        // 当前值里已经没有最近读到的内容（被发送、清空、换成提示文字），就用最近读到的
        if text.is_empty() || (!self.last_value.is_empty() && !text.contains(&self.last_value)) {
            text = self.last_value.clone();
        }
        self.emit_text("keyboard.text_input", &text, reason, None);
        self.ui_schedule("typing", 0.6);
        self.reset_burst();
    }

    fn emit_text(&self, ty: &str, text: &str, reason: &str, actor: Option<Value>) {
        let mut f = self.burst_app.clone();
        f.insert("window_title".into(), json!(self.burst_window));
        f.insert("text".into(), json!(text));
        let secure = self.burst_element.as_ref().map(is_secure).unwrap_or(false);
        f.insert("typed".into(), json!(if secure { "[REDACTED]" } else { self.typed.as_str() }));
        f.insert("reason".into(), json!(reason));
        f.insert("keys".into(), json!(self.burst_keys));
        f.insert("agent_procs".into(), json!(self.burst_agents));
        // 这一段由谁打的：全是人 / 全是代理 / 混合
        let h = *self.burst_keys.get("human").unwrap_or(&0);
        let a = *self.burst_keys.get("agent").unwrap_or(&0);
        f.insert("actor_kind".into(), json!(if a == 0 { "human" } else if h == 0 { "agent" } else { "mixed" }));
        if let Some(actor) = actor {
            f.insert("submit_actor".into(), actor);
        }
        if let Some(el) = &self.burst_element {
            let mut d = describe(el);
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
        self.burst_keys.clear();
        self.burst_agents.clear();
        self.last_value.clear();
        self.typed.clear();
        self.burst_pid = 0;
        self.generation += 1;
    }

    /// 第一个按键那一刻抓到的焦点可能是外层容器（Claude 里抓到过 AXGroup），
    /// 打字过程中重新确认：当前焦点是文字输入框，就换成它。
    fn refocus(&mut self) {
        if self.burst_pid <= 0 {
            return;
        }
        let Some(el) = app_element(self.burst_pid).and_then(|a| focused_element(&a)) else { return };
        let r = role(&el).unwrap_or_default();
        if ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox"].contains(&r.as_str()) || self.burst_element.is_none() {
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
        let Some((pid, bundle)) = frontmost() else { return };
        if pid == std::process::id() as Pid || self.blocked(pid) {
            return;
        }
        let (name, _) = app_names(pid);
        self.last_walk = Some(Instant::now());
        let _ = self.worker.send(Work::Ui { pid, name, bundle, trigger });
    }

    /// 切到新 app：换一个辅助功能观察者，订阅焦点窗口变化、标题变化
    fn ui_app_activated(&mut self, pid: Pid) {
        if pid == self.observed_pid {
            return;
        }
        if let Some(obs) = self.observer.take() {
            unsafe { CFRunLoopRemoveSource(self.rl, AXObserverGetRunLoopSource(obs.ptr()), kCFRunLoopDefaultMode) };
        }
        self.observed_pid = pid;
        let mut obs: AXObserverRef = std::ptr::null();
        if unsafe { AXObserverCreate(pid, ax_callback, &mut obs) } != kAXErrorSuccess {
            return;
        }
        let Some(obs) = CF::owned(obs) else { return };
        if let Some(app) = app_element(pid) {
            for n in ["AXFocusedWindowChanged", "AXTitleChanged", "AXMainWindowChanged"] {
                let name = cfstr(n);
                unsafe { AXObserverAddNotification(obs.ptr(), app.ptr(), name.ptr(), std::ptr::null_mut()) };
            }
        }
        unsafe { CFRunLoopAddSource(self.rl, AXObserverGetRunLoopSource(obs.ptr()), kCFRunLoopDefaultMode) };
        self.observer = Some(obs);
        self.ui_schedule("app_activated", 0.5);
    }

    fn ax_note(&mut self, element: CF, name: String) {
        if name == "AXTitleChanged" {
            // 标题变化很频繁（网页加载、编辑器光标），只记焦点窗口的
            let pid = element_pid(&element);
            let focused = app_element(pid).and_then(|a| focused_window(&a));
            match focused {
                Some(w) if unsafe { CFEqual(w.ptr(), element.ptr()) } != 0 => {}
                _ => return,
            }
        }
        if let Some((pid, _)) = frontmost() {
            if self.blocked(pid) {
                return;
            }
            let mut f = app_info(pid);
            f.insert("window_title".into(), json!(window_title(pid)));
            f.insert("change".into(), json!(name));
            self.write("window.changed", f);
        }
        self.ui_schedule("window_changed", 0.6);
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

    /// 锁屏、睡眠或熄屏都算离开（锁屏界面里动鼠标也会刷新空闲秒数）
    fn presence_tick(&mut self) {
        let idle = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        let now_active = !self.locked && !self.asleep && idle < IDLE_THRESHOLD;
        let state = if now_active { "active" } else { "idle" };
        if self.active != Some(now_active) {
            self.write("presence", fields! {"state" => state, "idle_seconds" => idle as i64});
            self.active = Some(now_active);
        }
        if self.last_heartbeat.map(|t| t.elapsed().as_secs_f64() >= HEARTBEAT_EVERY).unwrap_or(true) {
            let mut f = fields! {"idle_seconds" => idle as i64, "state" => state};
            if let Some((pid, _)) = frontmost() {
                merge(&mut f, app_info(pid));
                if self.blocked(pid) {
                    f.insert("blocked".into(), json!(true));
                } else {
                    f.insert("window_title".into(), json!(window_title(pid)));
                }
            }
            self.write("heartbeat", f);
            self.last_heartbeat = Some(Instant::now());
        }
        // 最近 30 秒有人操作，界面文字按间隔补读
        if idle < 30.0 && self.last_walk.map(|t| t.elapsed().as_secs_f64() >= UI_REFRESH).unwrap_or(true) {
            self.ui_schedule("refresh", 0.0);
        }
    }
}

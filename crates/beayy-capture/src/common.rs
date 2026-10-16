//! 两个平台共用的采集逻辑：时间常数、打字的防抖与发送判断、按键按操作者统计、定时任务、不记录的 app、
//! 界面文字的拍平与去重。平台模块只管「读」（键鼠、焦点元素、界面树），怎么判断、记成什么字段都在这里，
//! macOS 和 Windows 记出来的事件才一致。

#![allow(dead_code)]

use beayy_core::EventLog;
use serde_json::{json, Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant, SystemTime};

/// 停顿多久算「打完一段」
pub const TEXT_DEBOUNCE: f64 = 5.0;
/// 连续打字的上限，超过就先落一条
pub const TEXT_MAX_CONTINUOUS: f64 = 60.0;
/// 每次按键后多久读一次输入框，用来在回车清空输入框之前留住原文
pub const SNAPSHOT_DELAY: f64 = 0.2;
/// 回车后多久再读一次，判断是「发送」（输入框被清空）还是换行 / 输入法上屏
pub const SUBMIT_CHECK_DELAY: f64 = 0.35;
/// 在场：超过 3 分钟没有键鼠算离开（和 ActivityWatch 默认一致），每 60 秒一条心跳，每 10 秒看一次
pub const IDLE_THRESHOLD: f64 = 180.0;
pub const HEARTBEAT_EVERY: f64 = 60.0;
pub const PRESENCE_EVERY: f64 = 10.0;
/// 有人在操作时，界面内容没变化也每隔多久补读一次（消息滚动进来、页面自己刷新）
pub const UI_REFRESH: f64 = 30.0;
pub const PERMISSION_EVERY: f64 = 5.0;
/// 输入框的值最多读多少字
pub const VALUE_MAX: usize = 4000;
/// 打字的按键原文最多留多少字
pub const TYPED_MAX: usize = 2000;

/// 界面文字单次遍历上限：元素数、字数、耗时、深度
pub const UI_MAX_NODES: usize = 4000;
pub const UI_MAX_CHARS: usize = 12000;
pub const UI_MAX_TIME: Duration = Duration::from_millis(800);
pub const UI_MAX_DEPTH: usize = 60;

// ---------- 文字 ----------

/// 去掉零宽字符和首尾空白（飞书等富文本输入框会在段落里塞 \u{200B}）
pub fn clean_text(s: &str) -> String {
    s.replace(['\u{200B}', '\u{FEFF}'], "").trim().to_string()
}

/// 「刚打的字还在不在输入框里」。中文输入法组字时，回车会把拼音字母原样上屏（`liu'b` → `liub`），
/// 原文比较会误判成发送；所以先去掉 ASCII 字母、拼音分隔符和空白，只比汉字等其余部分。
/// 原文全是英文（去掉后为空）时，退回原样比较。
pub fn still_contains(after: &str, before: &str) -> bool {
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

/// 回车后输入框里已经没有刚打的字＝发送了。
/// 不能只看「变空、变短」：飞书、ChatGPT 网页这类输入框清空后会显示提示文字，反而比原文长
pub fn submit_cleared(before: &str, after: &str) -> bool {
    !before.is_empty() && !still_contains(after, before)
}

/// 一段打字落盘时记哪个值：当前值里已经没有最近读到的内容（被发送、清空、换成提示文字），就用最近读到的
pub fn flush_value(current: String, last_value: &str) -> String {
    if current.is_empty() || (!last_value.is_empty() && !current.contains(last_value)) {
        last_value.to_string()
    } else {
        current
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// 并进一组字段（已有的键不覆盖，同 Swift 的 merge { a, _ in a }）
pub fn merge(into: &mut Map<String, Value>, from: Map<String, Value>) {
    for (k, v) in from {
        into.entry(k).or_insert(v);
    }
}

/// 坐标这类浮点数：整数值写成整数，和 Swift 的 JSONSerialization 一致
pub fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

// ---------- 操作者 ----------

/// 一段打字里的按键，按操作者（human／agent／self）计数，并记下代理的进程名
#[derive(Default)]
pub struct KeyStats {
    keys: BTreeMap<String, i64>,
    agents: BTreeSet<String>,
}

impl KeyStats {
    pub fn note(&mut self, actor: &Value) {
        let kind = actor["kind"].as_str().unwrap_or("unknown").to_string();
        if kind == "agent" {
            if let Some(p) = actor["source_proc"].as_str() {
                if !p.is_empty() {
                    self.agents.insert(p.to_string());
                }
            }
        }
        *self.keys.entry(kind).or_insert(0) += 1;
    }

    /// 这一段由谁打的：全是人 / 全是代理 / 混合
    pub fn actor_kind(&self) -> &'static str {
        let h = *self.keys.get("human").unwrap_or(&0);
        let a = *self.keys.get("agent").unwrap_or(&0);
        if a == 0 {
            "human"
        } else if h == 0 {
            "agent"
        } else {
            "mixed"
        }
    }

    /// 写进 keyboard.text_input／submit 的三个字段：keys、agent_procs、actor_kind
    pub fn fill(&self, f: &mut Map<String, Value>) {
        f.insert("keys".into(), json!(self.keys));
        f.insert("agent_procs".into(), json!(self.agents));
        f.insert("actor_kind".into(), json!(self.actor_kind()));
    }

    pub fn clear(&mut self) {
        self.keys.clear();
        self.agents.clear();
    }
}

// ---------- 定时任务 ----------

pub type Task<C> = Box<dyn FnOnce(&mut C)>;

struct Timer<C> {
    at: Instant,
    key: Option<&'static str>,
    task: Task<C>,
}

/// 采集线程上的定时任务（所有状态都在一条线程上，不用加锁）
pub struct Scheduler<C> {
    timers: Vec<Timer<C>>,
}

impl<C> Default for Scheduler<C> {
    fn default() -> Self {
        Scheduler { timers: vec![] }
    }
}

impl<C> Scheduler<C> {
    /// 安排一个任务；带 key 的同名任务只留最新一个（相当于 DispatchWorkItem 先 cancel 再排）
    pub fn after(&mut self, secs: f64, key: Option<&'static str>, task: Task<C>) {
        if let Some(k) = key {
            self.cancel(k);
        }
        self.timers.push(Timer { at: Instant::now() + Duration::from_secs_f64(secs.max(0.0)), key, task });
    }
    pub fn cancel(&mut self, key: &str) {
        self.timers.retain(|t| t.key != Some(key));
    }
    /// 离最近一个任务还有几秒（没有任务时是 f64::MAX）
    pub fn next_in(&self) -> f64 {
        let now = Instant::now();
        self.timers.iter().map(|t| t.at.saturating_duration_since(now).as_secs_f64()).fold(f64::MAX, f64::min)
    }
    pub fn take_due(&mut self) -> Vec<Task<C>> {
        let now = Instant::now();
        let mut due: Vec<Timer<C>> = vec![];
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

// ---------- 不记录的 app ----------

/// 设置页「不记录的 app」（settings.json 的 blacklist，app 名或 bundle id／程序路径，不分大小写）；
/// 每 5 秒看一次文件有没有改，按进程号缓存判断结果
pub struct Blocklist {
    default: &'static [&'static str],
    list: Vec<String>,
    mtime: Option<SystemTime>,
    cache: HashMap<i64, bool>,
}

impl Blocklist {
    /// `default`：settings.json 里还没有 blacklist 时的默认值（和设置页显示的一致）
    pub fn new(default: &'static [&'static str]) -> Self {
        Blocklist { default, list: default.iter().map(|s| s.to_lowercase()).collect(), mtime: None, cache: HashMap::new() }
    }

    /// 设置页改了就重读（settings.json 和网页界面共用，在正式数据目录）
    pub fn reload(&mut self) {
        // 测试版（--shadow）影子目录里有自己的 settings.json 就用它，测名单时不影响正式版
        let own = beayy_core::data_root().join("settings.json");
        let path = if beayy_core::shadow_mode() && own.exists() { own } else { beayy_core::default_root().join("settings.json") };
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if mtime.is_none() || mtime == self.mtime {
            return;
        }
        self.mtime = mtime;
        let raw: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.list = match raw.get("blacklist").and_then(Value::as_array) {
            Some(a) => a.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect(),
            None => self.default.iter().map(|s| s.to_lowercase()).collect(),
        };
        self.cache.clear();
    }

    /// 这个进程是不是不记录的 app；`names` 给出它的各种叫法（app 名、bundle id、程序路径……），任一命中就算
    pub fn blocked(&mut self, pid: i64, names: impl FnOnce() -> Vec<String>) -> bool {
        if self.list.is_empty() {
            return false;
        }
        if let Some(b) = self.cache.get(&pid) {
            return *b;
        }
        let names: Vec<String> = names().into_iter().map(|s| s.to_lowercase()).filter(|s| !s.is_empty()).collect();
        let b = self.list.iter().any(|x| names.iter().any(|n| n == x));
        self.cache.insert(pid, b);
        b
    }
}

// ---------- 界面文字 ----------

/// 拍平后的一行行文字：同一窗口里重复的整行（侧栏、按钮名）只留第一次
#[derive(Default)]
pub struct UiLines {
    pub lines: Vec<String>,
    pub chars: usize,
    seen: HashSet<String>,
}

impl UiLines {
    pub fn add(&mut self, s: String) {
        let line = truncate(&s, 2000);
        if !self.seen.insert(line.clone()) {
            return;
        }
        self.chars += line.chars().count();
        self.lines.push(line);
    }

    pub fn full(&self) -> bool {
        self.chars >= UI_MAX_CHARS
    }
}

/// 一次界面文字读取的结果
pub struct UiSnapshot {
    pub app: Map<String, Value>,
    pub window_title: String,
    pub trigger: String,
    pub lines: UiLines,
    pub visited: usize,
    pub truncated: bool,
    pub url: String,
    pub secure: bool,
}

/// 按窗口记住上次读到的文字，内容没变不重复写
#[derive(Default)]
pub struct UiDedupe {
    /// "pid|窗口标题" → 上次文字的哈希
    last_hash: HashMap<String, u64>,
}

impl UiDedupe {
    /// 写一条 `ui.text`；和这个窗口上次读到的一样就不写
    pub fn write(&mut self, log: &EventLog, s: UiSnapshot) {
        let text = s.lines.lines.join("\n");
        // 只留 http(s) 网址；Electron app 报出的 file:// 内部地址没有意义
        let url = if s.url.starts_with("http") { s.url.clone() } else { String::new() };
        let pid = s.app.get("pid").cloned().unwrap_or(Value::Null);
        let key = format!("{pid}|{}", s.window_title);
        let mut h = DefaultHasher::new();
        (text.as_str(), url.as_str()).hash(&mut h);
        let h = h.finish();
        if self.last_hash.get(&key) == Some(&h) {
            return;
        }
        self.last_hash.insert(key, h);

        let mut f = s.app;
        f.insert("window_title".into(), json!(s.window_title));
        f.insert("trigger".into(), json!(s.trigger));
        f.insert("text".into(), json!(text));
        f.insert("lines".into(), json!(s.lines.lines.len()));
        f.insert("nodes".into(), json!(s.visited));
        f.insert("truncated".into(), json!(s.truncated));
        if !url.is_empty() {
            f.insert("url".into(), json!(url));
        }
        if s.secure {
            f.insert("has_secure_field".into(), json!(true));
        }
        log.write("ui.text", f, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_detection() {
        // 输入法回车把拼音字母上屏：不算发送
        assert!(!submit_cleared("你好liu'b", "你好liub"));
        // 发出去以后输入框显示提示文字
        assert!(submit_cleared("你好，飞书测试。", "发送给 某群"));
        assert!(submit_cleared("hello", ""));
        assert!(!submit_cleared("hello", "hello world"));
        assert!(!submit_cleared("", "x"));
    }

    #[test]
    fn flush_choice() {
        assert_eq!(flush_value(String::new(), "abc"), "abc");
        assert_eq!(flush_value("请输入".into(), "abc"), "abc");
        assert_eq!(flush_value("abcd".into(), "abc"), "abcd");
        assert_eq!(flush_value("abcd".into(), ""), "abcd");
    }

    #[test]
    fn key_stats() {
        let mut k = KeyStats::default();
        k.note(&json!({"kind": "human"}));
        assert_eq!(k.actor_kind(), "human");
        k.note(&json!({"kind": "agent", "source_proc": "Claude"}));
        assert_eq!(k.actor_kind(), "mixed");
        let mut f = Map::new();
        k.fill(&mut f);
        assert_eq!(f["agent_procs"], json!(["Claude"]));
        assert_eq!(f["keys"], json!({"agent": 1, "human": 1}));
        k.clear();
        k.note(&json!({"kind": "agent", "source_proc": ""}));
        assert_eq!(k.actor_kind(), "agent");
        let mut f = Map::new();
        k.fill(&mut f);
        assert_eq!(f["agent_procs"], json!([]));
    }

    #[test]
    fn lines_dedupe() {
        let mut l = UiLines::default();
        l.add("a".into());
        l.add("a".into());
        l.add("bc".into());
        assert_eq!(l.lines, vec!["a", "bc"]);
        assert_eq!(l.chars, 3);
    }

    #[test]
    fn scheduler_keys() {
        let mut s: Scheduler<Vec<i32>> = Scheduler::default();
        s.after(0.0, Some("x"), Box::new(|v| v.push(1)));
        s.after(0.0, Some("x"), Box::new(|v| v.push(2)));
        s.after(0.0, None, Box::new(|v| v.push(3)));
        let mut v = vec![];
        for t in s.take_due() {
            t(&mut v);
        }
        v.sort();
        assert_eq!(v, vec![2, 3]);
    }
}

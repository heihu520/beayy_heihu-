// 界面文字：读前台 app 焦点窗口的辅助功能树，拍平成一行行文字，写 `ui.text`。从 Swift 版 UIText.swift 移植。
// 遍历时丢弃的视觉角色、保留的带字角色、容器折叠的思路参考 OpenChronicle（resources/mac-ax-helper.swift，
// Copyright (c) 2026 Einsia，MIT，见 app/THIRD_PARTY_NOTICES.md）；拍平成文字行、按窗口去重、浏览器网址为本项目自写。
// 这里是后台线程（AX 工作线程）上的读取部分；什么时候读由 capture.rs 调度。

use super::ax::*;
use super::ffi::*;
use beayy_core::EventLog;
use serde_json::{json, Map};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

/// 单次遍历上限：元素数、字数、耗时
const MAX_NODES: usize = 4000;
const MAX_CHARS: usize = 12000;
const MAX_TIME: Duration = Duration::from_millis(800);

/// 纯视觉元素：连同子树一起跳过
const DROP_ROLES: &[&str] = &[
    "AXImage", "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXColumn",
    "AXMenuBar", "AXGrowArea", "AXRuler", "AXMatte", "AXLayoutArea", "AXLayoutItem",
];

#[derive(Default)]
pub struct UiReader {
    /// "pid|窗口标题" → 上次文字的哈希
    last_hash: HashMap<String, u64>,
}

impl UiReader {
    pub fn capture(&mut self, log: &EventLog, pid: Pid, name: &str, bundle: &str, trigger: &str) {
        let Some(app) = app_element(pid) else { return };
        unsafe { AXUIElementSetMessagingTimeout(app.ptr(), 0.3) };
        let Some(window) = focused_window(&app) else { return };
        let title = ax_string(&window, "AXTitle").unwrap_or_default();

        let mut w = Walker { deadline: Instant::now() + MAX_TIME, ..Default::default() };
        w.walk(&window, 0);
        let text = w.lines.join("\n");
        // 只留 http(s) 网址；Electron app 报出的 file:// 内部地址没有意义
        let url = if w.url.starts_with("http") { w.url.clone() } else { String::new() };

        let key = format!("{pid}|{title}");
        let mut h = DefaultHasher::new();
        (text.as_str(), url.as_str()).hash(&mut h);
        let h = h.finish();
        if self.last_hash.get(&key) == Some(&h) {
            return; // 和这个窗口上次读到的一样，不重复写
        }
        self.last_hash.insert(key, h);

        let mut f = Map::new();
        f.insert("pid".into(), json!(pid));
        f.insert("app_name".into(), json!(name));
        f.insert("bundle_id".into(), json!(bundle));
        f.insert("window_title".into(), json!(title));
        f.insert("trigger".into(), json!(trigger));
        f.insert("text".into(), json!(text));
        f.insert("lines".into(), json!(w.lines.len()));
        f.insert("nodes".into(), json!(w.visited));
        f.insert("truncated".into(), json!(w.truncated));
        if !url.is_empty() {
            f.insert("url".into(), json!(url));
        }
        if w.secure {
            f.insert("has_secure_field".into(), json!(true));
        }
        log.write("ui.text", f, None);
    }
}

/// 深度优先遍历，把带字的元素拍平成一行行文字；同一窗口里重复的行只留一次
struct Walker {
    deadline: Instant,
    lines: Vec<String>,
    chars: usize,
    visited: usize,
    truncated: bool,
    secure: bool,
    url: String,
    seen: HashSet<String>,
}

impl Default for Walker {
    fn default() -> Self {
        Walker {
            deadline: Instant::now(),
            lines: vec![],
            chars: 0,
            visited: 0,
            truncated: false,
            secure: false,
            url: String::new(),
            seen: HashSet::new(),
        }
    }
}

impl Walker {
    fn walk(&mut self, el: &CF, depth: usize) {
        if self.truncated {
            return;
        }
        if self.visited >= MAX_NODES || self.chars >= MAX_CHARS || Instant::now() > self.deadline || depth > 60 {
            self.truncated = true;
            return;
        }
        self.visited += 1;
        let role = role(el).unwrap_or_default();
        if DROP_ROLES.contains(&role.as_str()) {
            return;
        }

        if role == "AXWebArea" && self.url.is_empty() {
            if let Some(v) = attr(el, "AXURL") {
                let p = v.ptr();
                if unsafe { CFGetTypeID(p) == CFURLGetTypeID() } {
                    self.url = string_of(unsafe { CFURLGetString(p) }).unwrap_or_default();
                } else if let Some(s) = string_of(p) {
                    self.url = s;
                }
            }
        }

        if is_secure(el) {
            self.secure = true;
            self.add("[密码框]".into());
        } else {
            // 标题、值、描述里取一个有意义的：AXGroup 的标题多是类名，不要
            let value = ax_string(el, "AXValue").unwrap_or_default();
            let title = if role == "AXGroup" { String::new() } else { ax_string(el, "AXTitle").unwrap_or_default() };
            let desc = ax_string(el, "AXDescription").unwrap_or_default();
            let third = if title.is_empty() && value.is_empty() { desc } else { String::new() };
            for t in [title, value, third] {
                let s = t.trim().replace('\u{200B}', "");
                if !s.is_empty() {
                    let line = match role.as_str() {
                        "AXHeading" => format!("# {s}"),
                        "AXLink" => format!("[{s}]"),
                        _ => s,
                    };
                    self.add(line);
                }
            }
        }

        let Some(children) = attr(el, "AXChildren") else { return };
        let arr = children.ptr();
        if unsafe { CFGetTypeID(arr) != CFArrayGetTypeID() } {
            return;
        }
        let n = unsafe { CFArrayGetCount(arr) };
        for i in 0..n {
            if let Some(c) = CF::retained(unsafe { CFArrayGetValueAtIndex(arr, i) }) {
                self.walk(&c, depth + 1);
            }
        }
    }

    fn add(&mut self, s: String) {
        let line = truncate(&s, 2000);
        // 同一窗口里重复出现的整行（侧栏、按钮名）只留第一次
        if !self.seen.insert(line.clone()) {
            return;
        }
        self.chars += line.chars().count();
        self.lines.push(line);
    }
}

// 界面文字：读前台 app 焦点窗口的辅助功能树，拍平成一行行文字，写 `ui.text`。从 Swift 版 UIText.swift 移植。
// 遍历时丢弃的视觉角色、保留的带字角色、容器折叠的思路参考 OpenChronicle（resources/mac-ax-helper.swift，
// Copyright (c) 2026 Einsia，MIT，见 app/THIRD_PARTY_NOTICES.md）；拍平成文字行、按窗口去重、浏览器网址为本项目自写。
// 这里是后台线程（AX 工作线程）上的读取部分；什么时候读由 capture.rs 调度。

use super::ax::*;
use super::ffi::*;
use crate::common::{UiDedupe, UiLines, UiSnapshot, UI_MAX_CHARS, UI_MAX_DEPTH, UI_MAX_NODES, UI_MAX_TIME};
use beayy_core::EventLog;
use std::time::Instant;

/// 纯视觉元素：连同子树一起跳过
const DROP_ROLES: &[&str] = &[
    "AXImage", "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXColumn",
    "AXMenuBar", "AXGrowArea", "AXRuler", "AXMatte", "AXLayoutArea", "AXLayoutItem",
];

#[derive(Default)]
pub struct UiReader {
    dedupe: UiDedupe,
}

impl UiReader {
    pub fn capture(&mut self, log: &EventLog, pid: Pid, name: &str, bundle: &str, trigger: &str) {
        let Some(app) = app_element(pid) else { return };
        unsafe { AXUIElementSetMessagingTimeout(app.ptr(), 0.3) };
        let Some(window) = focused_window(&app) else { return };
        let title = ax_string(&window, "AXTitle").unwrap_or_default();

        let mut w = Walker { deadline: Instant::now() + UI_MAX_TIME, ..Default::default() };
        w.walk(&window, 0);
        let mut a = serde_json::Map::new();
        a.insert("pid".into(), serde_json::json!(pid));
        a.insert("app_name".into(), serde_json::json!(name));
        a.insert("bundle_id".into(), serde_json::json!(bundle));
        self.dedupe.write(
            log,
            UiSnapshot {
                app: a,
                window_title: title,
                trigger: trigger.to_string(),
                lines: w.out,
                visited: w.visited,
                truncated: w.truncated,
                url: w.url,
                secure: w.secure,
            },
        );
    }
}

/// 深度优先遍历，把带字的元素拍平成一行行文字；同一窗口里重复的行只留一次
struct Walker {
    deadline: Instant,
    out: UiLines,
    visited: usize,
    truncated: bool,
    secure: bool,
    url: String,
}

impl Default for Walker {
    fn default() -> Self {
        Walker { deadline: Instant::now(), out: UiLines::default(), visited: 0, truncated: false, secure: false, url: String::new() }
    }
}

impl Walker {
    fn walk(&mut self, el: &CF, depth: usize) {
        if self.truncated {
            return;
        }
        if self.visited >= UI_MAX_NODES || self.out.chars >= UI_MAX_CHARS || Instant::now() > self.deadline || depth > UI_MAX_DEPTH {
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
        self.out.add(s);
    }
}

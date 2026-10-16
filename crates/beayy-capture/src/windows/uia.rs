// UI Automation：读焦点输入框的值、点中的元素、前台窗口的界面文字。对应 macOS 的 ax.rs 和 uitext.rs。
//
// 每条用到它的线程各建一个 `Uia`（COM 用多线程套间初始化），元素只在建它的线程上用。
// 元素的「角色」写成和 macOS 一样的 AX 名字（Edit→AXTextField、Text→AXStaticText、Hyperlink→AXLink……，
// 其余是 "AX"＋UIA 控件类型名），摘要和界面不用为 Windows 另写一套。

#![allow(non_upper_case_globals)]

use super::sys::{Hwnd, Pid};
use crate::common::{truncate, UiLines, UiSnapshot, UI_MAX_CHARS, UI_MAX_DEPTH, UI_MAX_NODES, UI_MAX_TIME};
use serde_json::{json, Map, Value};
use std::time::Instant;
use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

pub type El = IUIAutomationElement;

const CT_BASE: i32 = 50000;
/// UIA 控件类型 50000～50040 的名字
const CT_NAMES: [&str; 41] = [
    "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu", "MenuBar",
    "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text",
    "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem", "Document",
    "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar",
];

/// 角色名：和 macOS 的 AXRole 对齐
pub fn role_name(ct: i32) -> String {
    match UIA_CONTROLTYPE_ID(ct) {
        UIA_EditControlTypeId => "AXTextField".into(),
        UIA_TextControlTypeId => "AXStaticText".into(),
        UIA_HyperlinkControlTypeId => "AXLink".into(),
        UIA_PaneControlTypeId | UIA_GroupControlTypeId | UIA_CustomControlTypeId => "AXGroup".into(),
        UIA_DocumentControlTypeId => "AXDocument".into(),
        _ => match CT_NAMES.get((ct - CT_BASE) as usize) {
            Some(n) if ct >= CT_BASE => format!("AX{n}"),
            _ => String::new(),
        },
    }
}

/// 纯视觉元素：连同子树一起跳过（对应 macOS 的 DROP_ROLES）
const DROP: &[UIA_CONTROLTYPE_ID] = &[
    UIA_ImageControlTypeId,
    UIA_ScrollBarControlTypeId,
    UIA_ThumbControlTypeId,
    UIA_SeparatorControlTypeId,
    UIA_TitleBarControlTypeId,
    UIA_MenuBarControlTypeId,
    UIA_ProgressBarControlTypeId,
];

/// 名字多半是类名或重复窗口标题的容器：不取名字（对应 macOS 不取 AXGroup 的标题）
const SKIP_NAME: &[UIA_CONTROLTYPE_ID] =
    &[UIA_PaneControlTypeId, UIA_GroupControlTypeId, UIA_CustomControlTypeId, UIA_WindowControlTypeId, UIA_DocumentControlTypeId];

/// 打字时算「文字输入框」的控件
pub fn is_text_control(ct: i32) -> bool {
    [UIA_EditControlTypeId.0, UIA_DocumentControlTypeId.0, UIA_ComboBoxControlTypeId.0].contains(&ct)
}

fn s(b: windows::core::Result<BSTR>) -> String {
    b.map(|b| b.to_string()).unwrap_or_default()
}

fn variant_string(v: &VARIANT) -> String {
    BSTR::try_from(v).map(|b| b.to_string()).unwrap_or_default()
}

pub struct Uia {
    auto: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    walker: IUIAutomationTreeWalker,
}

impl Uia {
    /// 在当前线程初始化 COM（多线程套间）并建 UIA 客户端。`timeout_ms`：单次跨进程调用最多等多久（对方卡死时不拖住采集）
    pub fn new(timeout_ms: u32) -> Option<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let auto: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                .ok()?;
            if let Ok(a2) = auto.cast::<IUIAutomation2>() {
                let _ = a2.SetTransactionTimeout(timeout_ms);
                let _ = a2.SetConnectionTimeout(timeout_ms.max(1000));
            }
            let cache = auto.CreateCacheRequest().ok()?;
            for p in [
                UIA_ControlTypePropertyId,
                UIA_NamePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_ValueValuePropertyId,
                UIA_HeadingLevelPropertyId,
            ] {
                let _ = cache.AddProperty(p);
            }
            let walker = auto.ControlViewWalker().ok()?;
            Some(Uia { auto, cache, walker })
        }
    }

    /// 键盘焦点所在的元素（全局的，不限进程）
    pub fn focused(&self) -> Option<El> {
        unsafe { self.auto.GetFocusedElement().ok() }
    }

    pub fn at_point(&self, x: i32, y: i32) -> Option<El> {
        unsafe { self.auto.ElementFromPoint(POINT { x, y }).ok() }
    }

    /// 前台窗口的界面文字：按控件视图深度优先遍历，上限和 macOS 一样（4000 个元素、1.2 万字、0.8 秒）
    pub fn read_window(&self, h: Hwnd, app: Map<String, Value>, title: String, trigger: &str) -> Option<UiSnapshot> {
        let root = unsafe { self.auto.ElementFromHandleBuildCache(super::sys::hwnd(h), &self.cache) }.ok()?;
        let mut w = Walker { uia: self, deadline: Instant::now() + UI_MAX_TIME, out: UiLines::default(), visited: 0, truncated: false, secure: false, url: String::new() };
        w.walk(&root, 0, "");
        Some(UiSnapshot { app, window_title: title, trigger: trigger.to_string(), lines: w.out, visited: w.visited, truncated: w.truncated, url: w.url, secure: w.secure })
    }
}

pub fn control_type(el: &El) -> i32 {
    unsafe { el.CurrentControlType() }.map(|c| c.0).unwrap_or(0)
}

pub fn pid(el: &El) -> Pid {
    unsafe { el.CurrentProcessId() }.unwrap_or(0) as Pid
}

/// 密码框
pub fn is_secure(el: &El) -> bool {
    unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false)
}

/// 读输入框的值；密码框返回 [REDACTED]。
/// 有可写的 ValuePattern 用它（普通输入框、Chromium 的网页输入框）；没有或读到空，再对 Edit／Document 用 TextPattern（富文本、Word）。
/// 浏览器整页的 Document 是只读的、ValuePattern 里放的是网址，不当成输入内容。
pub fn element_value(el: &El, max: usize) -> String {
    if is_secure(el) {
        return "[REDACTED]".into();
    }
    let ct = UIA_CONTROLTYPE_ID(control_type(el));
    unsafe {
        if let Ok(vp) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            let ro = vp.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false);
            if !ro {
                let v = s(vp.CurrentValue());
                if !v.is_empty() {
                    return truncate(&v, max);
                }
            } else if ct == UIA_DocumentControlTypeId {
                return String::new();
            }
        }
        if ct == UIA_EditControlTypeId || ct == UIA_DocumentControlTypeId {
            if let Ok(tp) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                if let Ok(r) = tp.DocumentRange() {
                    return truncate(&s(r.GetText(max as i32 + 1)), max);
                }
            }
        }
    }
    String::new()
}

/// 元素的描述，字段和 macOS 一样：role、subrole、title、description、identifier、value
pub fn describe(el: &El) -> Map<String, Value> {
    let ct = control_type(el);
    let secure = is_secure(el);
    let cut = |v: String| truncate(&v, 200);
    let mut m = Map::new();
    m.insert("role".into(), json!(role_name(ct)));
    m.insert("subrole".into(), json!(if secure { "AXSecureTextField" } else { "" }));
    unsafe {
        m.insert("title".into(), json!(cut(s(el.CurrentName()))));
        m.insert("description".into(), json!(cut(s(el.CurrentHelpText()))));
        m.insert("identifier".into(), json!(cut(s(el.CurrentAutomationId()))));
    }
    m.insert("value".into(), json!(element_value(el, 500)));
    m
}

/// 深度优先遍历，把带字的元素拍平成一行行文字。对应 macOS 的 uitext.rs Walker：
/// 名字（AXTitle）和值（AXValue）各取一行，标题前加「# 」，链接加方括号；浏览器网页的网址取自 Document 的值。
struct Walker<'a> {
    uia: &'a Uia,
    deadline: Instant,
    out: UiLines,
    visited: usize,
    truncated: bool,
    secure: bool,
    url: String,
}

impl Walker<'_> {
    /// `ctx`：最近一个带名字的祖先的名字。列表项、链接的名字常是子元素文字拼起来的，子元素的文字已经在里面就不再记
    fn walk(&mut self, el: &El, depth: usize, ctx: &str) {
        if self.truncated {
            return;
        }
        if self.visited >= UI_MAX_NODES || self.out.chars >= UI_MAX_CHARS || Instant::now() > self.deadline || depth > UI_MAX_DEPTH {
            self.truncated = true;
            return;
        }
        self.visited += 1;
        let ct = unsafe { el.CachedControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0));
        if DROP.contains(&ct) {
            return;
        }
        let name = unsafe { el.CachedName() }.map(|b| b.to_string()).unwrap_or_default();
        let value = unsafe { el.GetCachedPropertyValue(UIA_ValueValuePropertyId) }.map(|v| variant_string(&v)).unwrap_or_default();
        let password = unsafe { el.CachedIsPassword() }.map(|b| b.as_bool()).unwrap_or(false);
        let heading = unsafe { el.GetCachedPropertyValue(UIA_HeadingLevelPropertyId) }
            .ok()
            .and_then(|v| i32::try_from(&v).ok())
            .map(|h| h != 0 && h != HeadingLevel_None.0)
            .unwrap_or(false);

        if ct == UIA_DocumentControlTypeId && self.url.is_empty() && value.starts_with("http") {
            self.url = value.clone();
        }

        let mut own = String::new();
        if password {
            self.secure = true;
            self.out.add("[密码框]".into());
        } else {
            let title = if SKIP_NAME.contains(&ct) { String::new() } else { name };
            let value = if ct == UIA_DocumentControlTypeId { String::new() } else { value };
            for t in [title, value] {
                let line = t.trim().replace('\u{200B}', "");
                if line.is_empty() || (ct == UIA_TextControlTypeId && !ctx.is_empty() && ctx.contains(&line)) {
                    continue;
                }
                if own.is_empty() {
                    own = line.clone();
                }
                self.out.add(if heading {
                    format!("# {line}")
                } else if ct == UIA_HyperlinkControlTypeId {
                    format!("[{line}]")
                } else {
                    line
                });
            }
        }

        let ctx = if own.is_empty() { ctx.to_string() } else { own };
        let mut child = unsafe { self.uia.walker.GetFirstChildElementBuildCache(el, &self.uia.cache) };
        while let Ok(c) = child {
            self.walk(&c, depth + 1, &ctx);
            if self.truncated {
                break;
            }
            child = unsafe { self.uia.walker.GetNextSiblingElementBuildCache(&c, &self.uia.cache) };
        }
    }
}

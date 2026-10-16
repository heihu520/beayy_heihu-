// 进程和窗口：前台窗口、进程的程序路径和显示名、窗口标题、空闲秒数。
// 字段对应 macOS：app_name＝程序的「文件说明」（如 Microsoft Edge，取不到用 exe 文件名），bundle_id＝程序完整路径。

use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, POINT};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetAncestor, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
};

pub type Pid = u32;

/// 窗口句柄在线程之间传的时候用整数（HWND 是裸指针，不能跨线程）
pub type Hwnd = isize;

pub fn hwnd(h: Hwnd) -> HWND {
    HWND(h as *mut _)
}

/// 距上次键鼠输入的秒数（只取时刻，不读内容）
pub fn idle_seconds() -> f64 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return 0.0;
        }
        GetTickCount().wrapping_sub(info.dwTime) as f64 / 1000.0
    }
}

pub fn foreground_hwnd() -> Hwnd {
    unsafe { GetForegroundWindow() }.0 as Hwnd
}

pub fn window_text(h: Hwnd) -> String {
    if h == 0 {
        return String::new();
    }
    let mut buf = [0u16; 1024];
    let n = unsafe { GetWindowTextW(hwnd(h), &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn thread_pid(h: Hwnd) -> Pid {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
    pid
}

/// 窗口所属的进程。UWP app（设置、计算器……）的顶层窗口属于 ApplicationFrameHost，真正的 app 在它的 CoreWindow 子窗口里
pub fn window_pid(h: Hwnd) -> Pid {
    let pid = thread_pid(h);
    if exe_stem(&exe_path(pid)).eq_ignore_ascii_case("ApplicationFrameHost") {
        if let Ok(core) = unsafe { FindWindowExW(Some(hwnd(h)), None, w!("Windows.UI.Core.CoreWindow"), PCWSTR::null()) } {
            let p = thread_pid(core.0 as Hwnd);
            if p != 0 {
                return p;
            }
        }
    }
    pid
}

/// 坐标下的顶层窗口
pub fn root_window_at(x: i32, y: i32) -> Hwnd {
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.0.is_null() {
            return 0;
        }
        GetAncestor(h, GA_ROOT).0 as Hwnd
    }
}

pub fn exe_path(pid: Pid) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if ok {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

pub fn exe_stem(path: &str) -> String {
    std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

thread_local! {
    /// 程序路径 → 显示名（读版本信息要打开文件，按路径缓存）
    static NAMES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// 程序的显示名：版本信息里的「文件说明」，没有就用「产品名称」，再没有用 exe 文件名
pub fn display_name(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    if let Some(n) = NAMES.with(|m| m.borrow().get(path).cloned()) {
        return n;
    }
    let name = version_string(path, "FileDescription")
        .or_else(|| version_string(path, "ProductName"))
        .unwrap_or_else(|| exe_stem(path));
    NAMES.with(|m| m.borrow_mut().insert(path.to_string(), name.clone()));
    name
}

fn version_string(path: &str, key: &str) -> Option<String> {
    unsafe {
        let file = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&file, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&file, None, size, data.as_mut_ptr() as *mut _).ok()?;
        // 先按文件自己声明的语言查，再试英文、简体中文
        let mut langs: Vec<(u16, u16)> = vec![];
        let mut p: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(data.as_ptr() as *const _, w!("\\VarFileInfo\\Translation"), &mut p, &mut len).as_bool() && len >= 4 {
            let pairs = std::slice::from_raw_parts(p as *const u16, (len / 2) as usize);
            for c in pairs.chunks(2) {
                if c.len() == 2 {
                    langs.push((c[0], c[1]));
                }
            }
        }
        langs.extend([(0x0409, 0x04B0), (0x0804, 0x04B0), (0x0409, 0x04E4)]);
        for (lang, cp) in langs {
            let sub = HSTRING::from(format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\{key}"));
            let mut p: *mut std::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            if VerQueryValueW(data.as_ptr() as *const _, &sub, &mut p, &mut len).as_bool() && len > 0 {
                let s = std::slice::from_raw_parts(p as *const u16, len as usize);
                let end = s.iter().position(|c| *c == 0).unwrap_or(s.len());
                let v = String::from_utf16_lossy(&s[..end]).trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
        None
    }
}

/// 进程的 app 名和程序路径
pub fn app_names(pid: Pid) -> (String, String) {
    let path = exe_path(pid);
    (display_name(&path), path)
}

/// 和 macOS 的 app_info 一样的三个字段：pid、app_name、bundle_id（Windows 上是程序完整路径）
pub fn app_info(pid: Pid) -> Map<String, Value> {
    let (name, path) = app_names(pid);
    let mut m = Map::new();
    m.insert("pid".into(), json!(pid));
    m.insert("app_name".into(), json!(name));
    m.insert("bundle_id".into(), json!(path));
    m
}

/// 前台窗口：进程号、程序路径、窗口句柄
pub fn frontmost() -> Option<(Pid, String, Hwnd)> {
    let h = foreground_hwnd();
    if h == 0 {
        return None;
    }
    let pid = window_pid(h);
    Some((pid, exe_path(pid), h))
}

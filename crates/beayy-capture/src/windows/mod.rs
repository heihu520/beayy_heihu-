//! Windows 实现。范围（10-15 定）：前台 app 与窗口、在不在电脑前；界面文字只有接口和桩、不开启；
//! 不含键盘与输入内容。**未实机验证**：目前只在 Mac 上用 `cargo check --target x86_64-pc-windows-msvc` 检查能编译，
//! 等有 Windows 电脑再测。过渡期 Windows 的时长照旧用 ActivityWatch 的 Windows 版。

use crate::PermissionStatus;
use windows_sys::Win32::Foundation::{CloseHandle, HWND};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

pub fn permissions() -> PermissionStatus {
    // Windows 没有对应的系统授权
    PermissionStatus { accessibility: true, input_monitoring: true, full_disk_access: true }
}

pub fn open_permission(_kind: &str) {}

/// 距上次键鼠输入的秒数（只取时刻，不读内容）
pub fn idle_seconds() -> f64 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if GetLastInputInfo(&mut info) == 0 {
            return 0.0;
        }
        GetTickCount().wrapping_sub(info.dwTime) as f64 / 1000.0
    }
}

/// 前台窗口：进程号、程序名（exe 文件名，不含扩展名）、程序完整路径、窗口标题
pub struct Foreground {
    pub pid: u32,
    pub app_name: String,
    pub exe_path: String,
    pub window_title: String,
}

pub fn foreground() -> Option<Foreground> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let window_title = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut exe_path = String::new();
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !h.is_null() {
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0 {
                exe_path = String::from_utf16_lossy(&buf[..len as usize]);
            }
            CloseHandle(h);
        }
        let app_name = std::path::Path::new(&exe_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        Some(Foreground { pid, app_name, exe_path, window_title })
    }
}

/// 界面文字（UI Automation）：接口先定下来，桩实现返回空，不开启实际采集——
/// 那台电脑是不是公司电脑还没定。
pub fn ui_text(_pid: u32) -> Option<String> {
    None
}

/// 时长与在场：每秒看一次前台窗口，每 10 秒看一次空闲，事件名和字段与 macOS 版一致
/// （app.activated、window.changed、presence、heartbeat；Windows 上 bundle_id 填程序完整路径）。
pub fn start_tracking(log: std::sync::Arc<beayy_core::EventLog>, paused: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use beayy_core::fields;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    const IDLE_THRESHOLD: f64 = 180.0;
    std::thread::spawn(move || {
        let mut last: Option<(u32, String)> = None;
        let mut active: Option<bool> = None;
        let mut last_presence = Instant::now() - Duration::from_secs(60);
        let mut last_heartbeat = Instant::now() - Duration::from_secs(120);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if paused.load(Ordering::Relaxed) {
                continue;
            }
            let fg = foreground();
            if let Some(f) = &fg {
                let info = || fields! {"pid" => f.pid, "app_name" => f.app_name, "bundle_id" => f.exe_path, "window_title" => f.window_title};
                match &last {
                    Some((pid, _)) if *pid != f.pid => log.write("app.activated", info(), None),
                    Some((_, title)) if *title != f.window_title => {
                        let mut m = info();
                        m.insert("change".into(), serde_json::json!("title"));
                        log.write("window.changed", m, None);
                    }
                    None => log.write("app.activated", info(), None),
                    _ => {}
                }
                last = Some((f.pid, f.window_title.clone()));
            }
            if last_presence.elapsed() >= Duration::from_secs(10) {
                last_presence = Instant::now();
                let idle = idle_seconds();
                let now_active = idle < IDLE_THRESHOLD;
                if Some(now_active) != active {
                    log.write("presence", fields! {"state" => if now_active { "active" } else { "idle" }, "idle_seconds" => idle as i64}, None);
                    active = Some(now_active);
                }
                if last_heartbeat.elapsed() >= Duration::from_secs(60) {
                    last_heartbeat = Instant::now();
                    let mut m = fields! {"idle_seconds" => idle as i64, "state" => if now_active { "active" } else { "idle" }};
                    if let Some(f) = &fg {
                        m.extend(fields! {"pid" => f.pid, "app_name" => f.app_name, "bundle_id" => f.exe_path, "window_title" => f.window_title});
                    }
                    log.write("heartbeat", m, None);
                }
            }
        }
    });
}

//! 并跑版专用的自检钩子：用它切页面、点按钮、截主窗口，开发时自查界面。正式版（非影子模式）不启用。
//!
//! 触发方式：往影子目录写 `snapshots/request.json`：`{"name": "今天-浅色", "js": "…"}`。
//! app 每秒看一次：有请求就打开主窗口 → 执行 js → 等 1 秒 → 截主窗口 → 写 `snapshots/<name>.png` → 删掉请求文件。
//! 截图用 CGWindowListCreateImage 截自己的窗口（不需要录屏权限）；新 SDK 把它标成不可用，按名字动态取（同 Swift 版）。

use std::ffi::{c_void, CString};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::os::raw::c_char) -> *mut c_void;
    fn CFRelease(cf: CFTypeRef);
    fn CFURLCreateFromFileSystemRepresentation(alloc: CFTypeRef, buf: *const u8, len: isize, is_dir: bool) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const std::os::raw::c_char, enc: u32) -> CFTypeRef;
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageDestinationCreateWithURL(url: CFTypeRef, ty: CFTypeRef, count: usize, opts: CFTypeRef) -> CFTypeRef;
    fn CGImageDestinationAddImage(dest: CFTypeRef, image: CFTypeRef, props: CFTypeRef);
    fn CGImageDestinationFinalize(dest: CFTypeRef) -> bool;
}

const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
const OPT_INCLUDING_WINDOW: u32 = 1 << 3;
const IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const UTF8: u32 = 0x0800_0100;

/// 截一个窗口写成 PNG
fn snapshot_window(window_number: u32, out: &Path) -> Result<(), String> {
    type CreateImage = unsafe extern "C" fn(CGRect, u32, u32, u32) -> CFTypeRef;
    let sym = CString::new("CGWindowListCreateImage").unwrap();
    let f = unsafe { dlsym(RTLD_DEFAULT, sym.as_ptr()) };
    if f.is_null() {
        return Err("取不到 CGWindowListCreateImage".into());
    }
    let create: CreateImage = unsafe { std::mem::transmute(f) };
    // CGRectNull：按窗口自身边界
    let null_rect = CGRect { x: f64::INFINITY, y: f64::INFINITY, w: 0.0, h: 0.0 };
    let image = unsafe { create(null_rect, OPT_INCLUDING_WINDOW, window_number, IMAGE_BOUNDS_IGNORE_FRAMING) };
    if image.is_null() {
        return Err("截图为空".into());
    }
    let path = out.to_string_lossy().into_owned();
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), path.as_ptr(), path.len() as isize, false);
        let ty_c = CString::new("public.png").unwrap();
        let ty = CFStringCreateWithCString(std::ptr::null(), ty_c.as_ptr(), UTF8);
        let dest = CGImageDestinationCreateWithURL(url, ty, 1, std::ptr::null());
        let ok = !dest.is_null() && {
            CGImageDestinationAddImage(dest, image, std::ptr::null());
            CGImageDestinationFinalize(dest)
        };
        for o in [dest, ty, url, image] {
            if !o.is_null() {
                CFRelease(o);
            }
        }
        if ok { Ok(()) } else { Err("写 PNG 失败".into()) }
    }
}

fn window_number(app: &AppHandle) -> Option<u32> {
    let w = app.get_webview_window("main")?;
    let ns = w.ns_window().ok()? as *mut objc2::runtime::AnyObject;
    let n: isize = unsafe { objc2::msg_send![ns, windowNumber] };
    Some(n as u32)
}

/// 并跑版启动时调用：后台每秒看一次请求文件
pub fn start(app: AppHandle, dir: PathBuf, open_main: fn(&AppHandle)) {
    let _ = std::fs::create_dir_all(&dir);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let req = dir.join("request.json");
        let Ok(text) = std::fs::read_to_string(&req) else { continue };
        let _ = std::fs::remove_file(&req);
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let name: String = v["name"].as_str().unwrap_or("snapshot").chars().filter(|c| !matches!(c, '/' | '\\' | ':')).collect();
        let js = v["js"].as_str().unwrap_or("").to_string();
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            open_main(&a);
            if let (Some(w), false) = (a.get_webview_window("main"), js.is_empty()) {
                let _ = w.eval(&js);
            }
        });
        std::thread::sleep(Duration::from_secs(1));
        let (tx, rx) = std::sync::mpsc::channel();
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(window_number(&a));
        });
        let out = dir.join(format!("{name}.png"));
        let result = match rx.recv_timeout(Duration::from_secs(3)).ok().flatten() {
            Some(n) => snapshot_window(n, &out),
            None => Err("主窗口不存在".into()),
        };
        let _ = std::fs::write(dir.join(format!("{name}.result.txt")), match result {
            Ok(()) => format!("ok {}", out.display()),
            Err(e) => format!("error {e}"),
        });
    });
}

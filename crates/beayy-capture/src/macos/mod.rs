//! macOS 实现。从 Swift 版（app/Sources/Beayy/）移植，事件格式、字段和 Swift 版一致（见 app/README.md）。
//!
//! - `ffi`：CoreFoundation／CoreGraphics／辅助功能的 FFI
//! - `ax`：辅助功能读取的小工具（AXUtil.swift）
//! - `capture`：采集线程——键鼠监听、打字与发送、滚动、切 app、界面文字调度、在场与心跳、权限（InteractionTap、Presence、main）
//! - `uitext`：界面文字的遍历（UIText.swift）
//!
//! `start` 必须在主线程调用：NSWorkspace 和锁屏的系统通知挂在主线程上，收到后转给采集线程。

mod ax;
mod capture;
mod ffi;
mod uitext;

use crate::PermissionStatus;
use beayy_core::EventLog;
use block2::RcBlock;
use capture::{Handle, Msg};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_app_kit::{
    NSRunningApplication, NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
    NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification, NSWorkspaceScreensDidWakeNotification,
    NSWorkspaceWillSleepNotification,
};
use objc2_foundation::{
    ns_string, NSBundle, NSDictionary, NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSNumber,
    NSString,
};
use serde_json::{json, Map, Value};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static HANDLE: OnceLock<Handle> = OnceLock::new();

pub fn permissions() -> PermissionStatus {
    PermissionStatus {
        accessibility: unsafe { ffi::AXIsProcessTrusted() },
        input_monitoring: unsafe { ffi::CGPreflightListenEventAccess() },
        // 完全磁盘访问没有查询接口，直接试读受保护的 Biome 目录
        full_disk_access: std::fs::read_dir(
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join("Library/Biome/streams/restricted/App.InFocus/remote"),
        )
        .is_ok(),
    }
}

/// 弹出辅助功能授权请求（把 app 加进列表），并打开设置页
pub fn request_accessibility() {
    objc2::rc::autoreleasepool(|_| {
        let key = NSString::from_str("AXTrustedCheckOptionPrompt");
        let yes = NSNumber::new_bool(true);
        let opts = NSDictionary::<NSString, NSNumber>::from_slices(&[&*key], &[&*yes]);
        unsafe { ffi::AXIsProcessTrustedWithOptions(Retained::as_ptr(&opts) as ffi::CFTypeRef) };
    });
    open_settings("Privacy_Accessibility");
}

fn open_settings(anchor: &str) {
    let _ = std::process::Command::new("/usr/bin/open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn();
}

pub fn open_permission(kind: &str) {
    match kind {
        "accessibility" => request_accessibility(),
        "input_monitoring" => {
            unsafe { ffi::CGRequestListenEventAccess() };
            open_settings("Privacy_ListenEvent")
        }
        // 完全磁盘访问不能由 app 弹窗申请，只能打开设置页，由用户点「+」加入 Beayy
        "full_disk_access" => open_settings("Privacy_AllFiles"),
        _ => {}
    }
}

/// 键鼠监听装上了没有
pub fn capturing() -> bool {
    capture::TAP_RUNNING.load(Ordering::Relaxed)
}

/// 启动采集。必须在主线程调用（挂系统通知）。`paused` 由界面和菜单改，采集线程自己发现变化、记暂停事件。
pub fn start(log: Arc<EventLog>, paused: Arc<AtomicBool>) {
    let h = capture::spawn(log, paused);
    observe_notifications(h.clone());
    let _ = HANDLE.set(h);
}

/// 退出前调用：把正在打的字落盘（最多等 1 秒）
pub fn shutdown() {
    if let Some(h) = HANDLE.get() {
        let (tx, rx) = std::sync::mpsc::channel();
        h.send(Msg::Quit(tx));
        let _ = rx.recv_timeout(Duration::from_secs(1));
    }
}

fn add_observer(center: &NSNotificationCenter, name: &NSString, f: impl Fn(NonNull<NSNotification>) + 'static) {
    let block = RcBlock::new(f);
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
    // 观察者要活到进程结束
    std::mem::forget(token);
}

fn observe_notifications(h: Handle) {
    let ws = NSWorkspace::sharedWorkspace();
    let center = ws.notificationCenter();
    let hh = h.clone();
    add_observer(&center, unsafe { NSWorkspaceDidActivateApplicationNotification }, move |note| {
        let note = unsafe { note.as_ref() };
        let app: Option<Retained<NSRunningApplication>> = note
            .userInfo()
            .and_then(|info| unsafe { msg_send![&*info, objectForKey: NSWorkspaceApplicationKey] });
        if let Some(app) = app {
            hh.send(Msg::AppActivated(app.processIdentifier()));
        }
    });
    let pairs: [(&NSString, &'static str); 4] = unsafe {
        [
            (NSWorkspaceWillSleepNotification, "system.sleep"),
            (NSWorkspaceDidWakeNotification, "system.wake"),
            (NSWorkspaceScreensDidSleepNotification, "screen.sleep"),
            (NSWorkspaceScreensDidWakeNotification, "screen.wake"),
        ]
    };
    for (name, ty) in pairs {
        let hh = h.clone();
        add_observer(&center, name, move |_| hh.send(Msg::System(ty)));
    }
    let dist = NSDistributedNotificationCenter::defaultCenter();
    for (name, ty) in [(ns_string!("com.apple.screenIsLocked"), "screen.locked"), (ns_string!("com.apple.screenIsUnlocked"), "screen.unlocked")] {
        let hh = h.clone();
        add_observer(&dist, name, move |_| hh.send(Msg::System(ty)));
    }
}

/// 自身的签名：团队、标识、cdhash。授权记在「标识＋团队」上，cdhash 每次编译都会变。
pub fn signing() -> Value {
    let Some(bundle) = bundle_path() else { return json!({}) };
    let out = std::process::Command::new("/usr/bin/codesign").args(["-dv", "--verbose=4"]).arg(&bundle).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stderr).into_owned()).unwrap_or_default();
    let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).unwrap_or("").to_string();
    json!({"identifier": get("Identifier="), "team": get("TeamIdentifier="), "cdhash": get("CDHash=")})
}

/// 所在的 .app 路径（直接跑 target/ 里的二进制时没有）
pub fn bundle_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let app = exe.ancestors().find(|p| p.extension().map(|e| e == "app").unwrap_or(false))?;
    Some(app.display().to_string())
}

/// Info.plist 里的 CFBundleVersion（编译时刻）
pub fn build_number() -> String {
    objc2::rc::autoreleasepool(|_| {
        let v = NSBundle::mainBundle().objectForInfoDictionaryKey(ns_string!("CFBundleVersion"));
        v.and_then(|o| o.downcast::<NSString>().ok()).map(|s| s.to_string()).unwrap_or_default()
    })
}

// ---------- 开机自动启动（SMAppService.mainApp） ----------

#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

fn main_app_service() -> Retained<AnyObject> {
    unsafe { msg_send![class!(SMAppService), mainAppService] }
}

/// 开机自动启动开着没有（SMAppServiceStatusEnabled＝1）
pub fn login_item_enabled() -> bool {
    objc2::rc::autoreleasepool(|_| {
        let status: isize = unsafe { msg_send![&*main_app_service(), status] };
        status == 1
    })
}

/// 打开或关掉开机自动启动；失败返回系统给的错误
pub fn set_login_item(on: bool) -> Result<(), String> {
    objc2::rc::autoreleasepool(|_| {
        let svc = main_app_service();
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = if on {
            unsafe { msg_send![&*svc, registerAndReturnError: &mut err] }
        } else {
            unsafe { msg_send![&*svc, unregisterAndReturnError: &mut err] }
        };
        if ok {
            Ok(())
        } else {
            let desc = if err.is_null() {
                "未知错误".to_string()
            } else {
                let d: Retained<NSString> = unsafe { msg_send![&*err, localizedDescription] };
                d.to_string()
            };
            Err(desc)
        }
    })
}

/// app.launch 里额外带的字段：build、签名
pub fn launch_fields() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("build".into(), json!(build_number()));
    m.insert("signing".into(), signing());
    m
}

// ---------- app 图标 ----------

/// 本机装了的 app 的图标，取最接近 `px`（不小于它）的那一档，转成 PNG。没装返回 None
pub fn app_icon_png(bundle_id: &str, px: isize) -> Option<Vec<u8>> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    objc2::rc::autoreleasepool(|_| {
        let ws = NSWorkspace::sharedWorkspace();
        let url = ws.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
        let path = url.path()?;
        let tiff = ws.iconForFile(&path).TIFFRepresentation()?;
        let reps = NSBitmapImageRep::imageRepsWithData(&tiff);
        let mut best: Option<(isize, Retained<NSBitmapImageRep>)> = None;
        for r in reps.iter() {
            let Ok(r) = r.downcast::<NSBitmapImageRep>() else { continue };
            let w = r.pixelsWide();
            let better = match &best {
                None => true,
                Some((b, _)) => (w >= px && (*b < px || w < *b)) || (*b < px && w > *b),
            };
            if better {
                best = Some((w, r));
            }
        }
        let (_, rep) = best?;
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
        Some(png.to_vec())
    })
}

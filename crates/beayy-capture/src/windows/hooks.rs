// 消息线程：低级键鼠钩子（WH_KEYBOARD_LL／WH_MOUSE_LL）、前台窗口切换（SetWinEventHook）、
// 睡眠唤醒（WM_POWERBROADCAST）、锁屏解锁（WTSRegisterSessionNotification）、屏幕关开（GUID_CONSOLE_DISPLAY_STATE）。
//
// 这条线程只跑消息循环，别的什么都不做：钩子回调超时（默认约 1 秒）系统会跳过它，多次超时会把钩子悄悄摘掉。
// 所以回调里只取时刻、键码、修饰键、坐标和「是不是程序注入的」，塞进通道就返回，读输入框这类慢活在采集线程做。

use super::sys::Hwnd;
use super::Ev;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{RegisterPowerSettingNotification, POWERBROADCAST_SETTING};
use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
use windows::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_RWIN, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 修饰键位：和采集线程约定
pub const MOD_CTRL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_WIN: u8 = 8;

/// 钩子装上了没有（界面上的「采集中」）
pub static HOOKS_OK: AtomicBool = AtomicBool::new(false);
/// 钩子回调被调了多少次（含鼠标移动）：采集线程拿它判断钩子是不是被系统摘掉了
pub static HOOK_HITS: AtomicU64 = AtomicU64::new(0);
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static TX: OnceLock<Mutex<Sender<Ev>>> = OnceLock::new();
static HOOKS: Mutex<(isize, isize)> = Mutex::new((0, 0));
/// 屏幕状态：系统注册时会先发一次当前状态，这次不记
static DISPLAY: AtomicU32 = AtomicU32::new(u32::MAX);

/// 让消息线程重装键鼠钩子
const WM_REHOOK: u32 = WM_APP + 1;

fn send(e: Ev) {
    if let Some(tx) = TX.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(e);
        }
    }
}

pub fn spawn(tx: Sender<Ev>) {
    let _ = TX.set(Mutex::new(tx));
    std::thread::Builder::new()
        .name("beayy-hooks".into())
        .spawn(|| unsafe { run() })
        .expect("启动消息线程失败");
}

/// 让消息线程重装键鼠钩子（采集线程发现钩子收不到输入时调）
pub fn rehook() {
    let id = THREAD_ID.load(Ordering::Relaxed);
    if id != 0 {
        let _ = unsafe { PostThreadMessageW(id, WM_REHOOK, WPARAM(0), LPARAM(0)) };
    }
}

unsafe fn module() -> Option<HINSTANCE> {
    GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0))
}

unsafe fn install_hooks() -> Result<(), String> {
    let mut g = HOOKS.lock().unwrap();
    for h in [g.0, g.1] {
        if h != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(h as *mut _));
        }
    }
    *g = (0, 0);
    let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module(), 0).map_err(|e| format!("键盘钩子：{e}"))?;
    let ms = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module(), 0) {
        Ok(m) => m,
        Err(e) => {
            let _ = UnhookWindowsHookEx(kb);
            return Err(format!("鼠标钩子：{e}"));
        }
    };
    *g = (kb.0 as isize, ms.0 as isize);
    Ok(())
}

unsafe fn run() {
    THREAD_ID.store(GetCurrentThreadId(), Ordering::Relaxed);
    // 先让系统给这条线程建消息队列，PostThreadMessageW 才不会丢
    let mut msg = MSG::default();
    let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);

    match install_hooks() {
        Ok(()) => {
            HOOKS_OK.store(true, Ordering::Relaxed);
            send(Ev::Hooks { ok: true, error: String::new(), reinstall: false });
        }
        Err(e) => send(Ev::Hooks { ok: false, error: e, reinstall: false }),
    }

    // 前台窗口切换：包括切到 Beayy 自己
    let _ = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(win_event), 0, 0, WINEVENT_OUTOFCONTEXT);

    // 收系统通知的隐藏顶层窗口（只收消息的 HWND_MESSAGE 窗口收不到 WM_POWERBROADCAST 这类广播）
    let class = w!("BeayyCaptureWindow");
    let wc = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: module().unwrap_or_default(), lpszClassName: class, ..Default::default() };
    RegisterClassW(&wc);
    if let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("Beayy"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, module(), None) {
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        let _ = RegisterPowerSettingNotification(HANDLE(hwnd.0), &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
    }

    loop {
        let r = GetMessageW(&mut msg, None, 0, 0);
        if r.0 <= 0 {
            break;
        }
        if msg.hwnd.0.is_null() && msg.message == WM_REHOOK {
            let r = install_hooks();
            HOOKS_OK.store(r.is_ok(), Ordering::Relaxed);
            send(Ev::Hooks { ok: r.is_ok(), error: r.err().unwrap_or_default(), reinstall: true });
            continue;
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    HOOKS_OK.store(false, Ordering::Relaxed);
}

/// 键鼠事件是不是程序注入的（SendInput、远程控制、自动化工具），以及注入方留的附加信息
fn injected(flag_injected: bool, flag_lower_il: bool, extra: usize) -> super::ActorRaw {
    super::ActorRaw { injected: flag_injected, lower_il: flag_lower_il, extra }
}

fn down(vk: VIRTUAL_KEY) -> bool {
    (unsafe { GetAsyncKeyState(vk.0 as i32) }) < 0
}

unsafe extern "system" fn keyboard_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        HOOK_HITS.fetch_add(1, Ordering::Relaxed);
        let m = w.0 as u32;
        if m == WM_KEYDOWN || m == WM_SYSKEYDOWN {
            let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
            let mut mods = 0u8;
            if down(VK_CONTROL) {
                mods |= MOD_CTRL;
            }
            if k.flags.0 & LLKHF_ALTDOWN.0 != 0 {
                mods |= MOD_ALT;
            }
            if down(VK_SHIFT) {
                mods |= MOD_SHIFT;
            }
            if down(VK_LWIN) || down(VK_RWIN) {
                mods |= MOD_WIN;
            }
            let actor = injected(k.flags.0 & LLKHF_INJECTED.0 != 0, k.flags.0 & LLKHF_LOWER_IL_INJECTED.0 != 0, k.dwExtraInfo);
            send(Ev::Key { vk: k.vkCode, mods, actor });
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        HOOK_HITS.fetch_add(1, Ordering::Relaxed);
        let m = w.0 as u32;
        let button = match m {
            WM_LBUTTONDOWN => Some("left"),
            WM_RBUTTONDOWN => Some("right"),
            WM_MBUTTONDOWN | WM_XBUTTONDOWN => Some("other"),
            _ => None,
        };
        let is_scroll = m == WM_MOUSEWHEEL || m == WM_MOUSEHWHEEL;
        if button.is_some() || is_scroll {
            let s = &*(l.0 as *const MSLLHOOKSTRUCT);
            let actor = injected(s.flags & LLMHF_INJECTED != 0, s.flags & LLMHF_LOWER_IL_INJECTED != 0, s.dwExtraInfo);
            match button {
                Some(button) => send(Ev::Mouse { button, x: s.pt.x, y: s.pt.y, actor }),
                None => send(Ev::Scroll { actor }),
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn win_event(_h: HWINEVENTHOOK, event: u32, hwnd: HWND, id_object: i32, _id_child: i32, _thread: u32, _time: u32) {
    if event == EVENT_SYSTEM_FOREGROUND && id_object == OBJID_WINDOW.0 && !hwnd.0.is_null() {
        send(Ev::Foreground(hwnd.0 as Hwnd));
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_POWERBROADCAST => {
            match w.0 as u32 {
                PBT_APMSUSPEND => send(Ev::System("system.sleep")),
                // 不管是不是人按的唤醒都会发这一条（PBT_APMRESUMESUSPEND 只在有人操作时补发，不另记）
                PBT_APMRESUMEAUTOMATIC => send(Ev::System("system.wake")),
                PBT_POWERSETTINGCHANGE if l.0 != 0 => {
                    let s = &*(l.0 as *const POWERBROADCAST_SETTING);
                    if s.PowerSetting == GUID_CONSOLE_DISPLAY_STATE && s.DataLength >= 1 {
                        // 0 关、1 开、2 变暗（变暗不记）
                        let v = s.Data[0] as u32;
                        let prev = DISPLAY.swap(v, Ordering::Relaxed);
                        if prev != u32::MAX && prev != v {
                            match v {
                                0 => send(Ev::System("screen.sleep")),
                                1 if prev == 0 => send(Ev::System("screen.wake")),
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            match w.0 as u32 {
                WTS_SESSION_LOCK => send(Ev::System("screen.locked")),
                WTS_SESSION_UNLOCK => send(Ev::System("screen.unlocked")),
                _ => {}
            }
            LRESULT(0)
        }
        // 关机、注销：把正在打的字落盘（最多等 1 秒）
        WM_ENDSESSION if w.0 != 0 => {
            super::shutdown();
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w, l),
    }
}

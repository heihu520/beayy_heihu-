//! 系统里装了哪些字体（设置 → 通用 → 字体）。只列字体家族，不读字体文件。
//! macOS 问 NSFontManager（family 是 CSS 认的英文名，name 是本地化的名字，如「苹方-简」）；
//! Windows 用 GDI 枚举（中文系统上给的就是本地化的名字，WebView2 的 CSS 也认）。

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Family {
    /// 写进 CSS font-family 的名字
    family: String,
    /// 给人看的名字
    name: String,
}

/// 系统字体家族，按显示名去重；去掉系统私有的（. 开头）和竖排用的（@ 开头）
#[tauri::command]
pub fn list_fonts() -> Vec<Family> {
    let mut out: Vec<Family> = families().into_iter().filter(|f| !f.family.starts_with('.') && !f.family.starts_with('@')).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

#[cfg(target_os = "macos")]
fn families() -> Vec<Family> {
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr};
    unsafe fn text(s: *mut AnyObject) -> Option<String> {
        if s.is_null() { return None; }
        let p: *const c_char = objc2::msg_send![s, UTF8String];
        if p.is_null() { None } else { Some(CStr::from_ptr(p).to_string_lossy().into_owned()) }
    }
    objc2::rc::autoreleasepool(|_| unsafe {
        let Some(cls) = AnyClass::get(c"NSFontManager") else { return vec![] };
        let fm: *mut AnyObject = objc2::msg_send![cls, sharedFontManager];
        let arr: *mut AnyObject = objc2::msg_send![fm, availableFontFamilies];
        if arr.is_null() { return vec![]; }
        let n: usize = objc2::msg_send![arr, count];
        (0..n).filter_map(|i| {
            let s: *mut AnyObject = objc2::msg_send![arr, objectAtIndex: i];
            let family = text(s)?;
            let loc: *mut AnyObject = objc2::msg_send![fm, localizedNameForFamily: s, face: std::ptr::null_mut::<AnyObject>()];
            let name = text(loc).unwrap_or_else(|| family.clone());
            Some(Family { family, name })
        }).collect()
    })
}

#[cfg(target_os = "windows")]
fn families() -> Vec<Family> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW};
    unsafe extern "system" fn each(lf: *const LOGFONTW, _tm: *const TEXTMETRICW, _kind: u32, lp: LPARAM) -> i32 {
        let names = &mut *(lp.0 as *mut Vec<String>);
        let face = &(*lf).lfFaceName;
        let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        names.push(String::from_utf16_lossy(&face[..len]));
        1
    }
    let mut names: Vec<String> = Vec::new();
    unsafe {
        let hdc = GetDC(None);
        let lf = LOGFONTW { lfCharSet: DEFAULT_CHARSET, ..Default::default() };
        EnumFontFamiliesExW(hdc, &lf, Some(each), LPARAM(&mut names as *mut Vec<String> as isize), 0);
        ReleaseDC(None, hdc);
    }
    names.into_iter().map(|n| Family { family: n.clone(), name: n }).collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn families() -> Vec<Family> {
    vec![]
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn mac_lists_system_families() {
        let fs = super::list_fonts();
        let pf = fs.iter().find(|f| f.family == "PingFang SC").expect("系统里应该有苹方");
        assert_ne!(pf.name, "", "显示名不能为空");
        assert!(fs.iter().all(|f| !f.family.starts_with('.')));
        eprintln!("{} 个字体家族；苹方显示为「{}」", fs.len(), pf.name);
    }
}

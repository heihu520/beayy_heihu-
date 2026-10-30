//! Android JNI：Kotlin `BeayyCore` → 这里 → `beayy_call` / `beayy_start`。
//! 包名固定为 com.fengli.beayy，和 iOS bundle 前缀一致，改包名时两边一起改。

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use crate::{beayy_call, beayy_free, beayy_start};

/// 设置数据目录并启动后台同步。Kotlin 在 loadLibrary 后、第一次 call 前调一次。
#[no_mangle]
pub extern "system" fn Java_com_fengli_beayy_BeayyCore_nativeInit(
    mut env: JNIEnv,
    _class: JClass,
    data_root: JString,
) {
    let root: String = env
        .get_string(&data_root)
        .map(|s| s.into())
        .unwrap_or_default();
    if !root.is_empty() {
        std::env::set_var("BEAYY_DATA_ROOT", &root);
        // beayy-core 非 Windows 的 default_root 还会读 HOME；给一个合理回落
        std::env::set_var("HOME", &root);
    }
    beayy_start();
}

/// 调一个命令：返回 `{"ok":…}` / `{"err":"…"}` JSON 字符串。
#[no_mangle]
pub extern "system" fn Java_com_fengli_beayy_BeayyCore_nativeCall(
    mut env: JNIEnv,
    _class: JClass,
    cmd: JString,
    args: JString,
) -> jstring {
    let cmd_s: String = env.get_string(&cmd).map(|s| s.into()).unwrap_or_default();
    let args_s: String = env
        .get_string(&args)
        .map(|s| s.into())
        .unwrap_or_else(|_| "{}".into());
    let cmd_c = CString::new(cmd_s).unwrap_or_default();
    let args_c = CString::new(args_s).unwrap_or_default();
    let out = unsafe { beayy_call(cmd_c.as_ptr(), args_c.as_ptr()) };
    let json = if out.is_null() {
        r#"{"err":"Rust 核心没返回"}"#.to_string()
    } else {
        let s = unsafe { CStr::from_ptr(out as *const c_char) }
            .to_string_lossy()
            .into_owned();
        unsafe { beayy_free(out) };
        s
    };
    env.new_string(json)
        .map(|j| j.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

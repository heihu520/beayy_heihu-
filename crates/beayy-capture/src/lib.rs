//! 采集接口。各平台实现同一组能力，按平台分模块编译。
//! 两边记的事件和字段相同：键鼠、打字与发送、界面文字、切 app、窗口变化、在场与心跳、睡眠锁屏
//! （`macos::start`／`windows::start`）。判断逻辑（防抖、发送、操作者统计、黑名单、界面文字去重）在 `common`，两边共用。

mod common;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
use macos as platform_impl;
#[cfg(target_os = "windows")]
use windows as platform_impl;

/// 权限状态。Windows 上没有这些系统授权，一律视为已授权。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub input_monitoring: bool,
    pub full_disk_access: bool,
}

pub fn permissions() -> PermissionStatus {
    platform_impl::permissions()
}

/// 打开系统设置里对应的授权页：accessibility／input_monitoring／full_disk_access
pub fn open_permission(kind: &str) {
    platform_impl::open_permission(kind)
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

//! 采集接口。各平台实现同一组能力，按平台分模块编译。
//! macOS：权限、键鼠监听、打字与发送、界面文字、切 app、在场与心跳（`macos::start`）；Windows：时长与在场。

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

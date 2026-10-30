# Beayy Android MVP

镜像 iOS：`WebView` 加载同一套 `ui/`，JS `invoke` → Kotlin 桥 → JNI → Rust `beayy_call`。

**本阶段范围**：UI 起来 + `get_status`（以及登录／同步若 Rust 侧已有，直接复用）。不做录音、定位、健康。

## 目录

```
android/
  app/src/main/java/com/fengli/beayy/
    MainActivity.kt   # 全屏 WebView
    BeayyBridge.kt    # JS ↔ Kotlin（含 native_* stub）
    BeayyCore.kt      # JNI → libbeayy_mobile.so
  app/src/main/assets/ui/   # 由 scripts/sync-ui.sh 从仓库 ui/ 拷入（勿手改）
  app/src/main/jniLibs/     # 由 scripts/build-rust.sh 生成 .so
  scripts/
    sync-ui.sh
    build-rust.sh
```

## 环境

- Android Studio Ladybug+ 或 SDK 35 + JDK 17
- NDK（推荐 r26+），`ANDROID_NDK_HOME` 或 SDK 自带 NDK
- Rust：`rustup`、`cargo install cargo-ndk`
- 目标：`rustup target add aarch64-linux-android`

## 编译步骤（仓库根）

```bash
# 1. 已合并 APPLY.md 里的 Rust 补丁（mobile cdylib + jni、beayy-core android 路径）

# 2. 同步网页资源
bash android/scripts/sync-ui.sh

# 3. 编 Rust → jniLibs/arm64-v8a/libbeayy_mobile.so
bash android/scripts/build-rust.sh arm64-v8a

# 4. 装到真机／模拟器（模拟器若是 x86_64，改：build-rust.sh x86_64，并在 app/build.gradle.kts abiFilters 加上）
cd android && ./gradlew :app:installDebug
# 若没有 gradle wrapper jar：用 Android Studio Open 本目录，让它生成 wrapper 再跑
```

## 验收 get_status

1. 打开 app，Logcat 过滤 `BeayyUI` 或 `beayy`。
2. 应看到类似：

   ```
   [beayy] get_status {"mobile":true,"capturing":false,...,"device":"android-…","version":"0.2.39",...}
   ```

3. 或在 WebView 远程调试（`chrome://inspect`）里执行：

   ```js
   await window.__TAURI__.core.invoke("get_status")
   ```

4. 登录／同步（可选）：同一套命令已在 `beayy-mobile` dispatch 里——

   ```js
   await window.__TAURI__.core.invoke("account_login", { email: "…", password: "…" })
   await window.__TAURI__.core.invoke("sync_now")
   await window.__TAURI__.core.invoke("sync_status")
   ```

   数据写在 `context.filesDir`（`BEAYY_DATA_ROOT`）。

## 桥接对照（iOS → Android）

| iOS | Android |
|---|---|
| `WKUserScript` 注入 `__TAURI__.core.invoke` | `BeayyBridge.TAURI_SHIM` + `evaluateJavascript` |
| `webkit.messageHandlers.beayy` | `JavascriptInterface` 名 `BeayyBridge` |
| `beayy_call` / `beayy_free`（C） | `BeayyCore.nativeCall`（JNI → 同 ABI） |
| `Bundle` 资源 `ui/` | `assets/ui/` |
| `native_*` 在 Swift | `BeayyBridge.handleNative` stub |

## 已知限制

- 仅 `arm64-v8a` 默认；x86 模拟器需加 ABI。
- `ureq` + `native-tls` 在 Android 上可能还需额外链接；若链接失败，后续可改为 `rustls` feature。
- 旧 `windows.yml`／桌面 Windows 兼容性不在本目录范围。

#!/bin/bash
# 出安卓安装包：编 Rust 核心（arm64 手机＋x86_64 模拟器）→ 把 app/ui 放进 assets 并接上 android.js → Gradle 打 apk。
# 用法：./build.sh            调试包 app/build/outputs/apk/debug/app-debug.apk
#       ./build.sh release    发布包 app/build/outputs/apk/release/app-release.apk
# 要：JDK 17、Android SDK（platforms;android-35、ndk;27.2.12479018）、rustup 的 aarch64/x86_64-linux-android、cargo-ndk
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_HOME="$SDK" ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$SDK/ndk/27.2.12479018}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$JAVA_HOME/bin:$PATH"
KIND="${1:-debug}"

echo "== Rust 核心"
(cd .. && cargo ndk -t arm64-v8a -t x86_64 -P 26 -o android/out/jni build -p beayy-mobile --release)

echo "== 网页"
rm -rf out/web && mkdir -p out/web
cp -R ../ui out/web/ui
rm -rf out/web/ui/mock out/web/ui/tools
cp web/android.js out/web/ui/android.js
# android.js 要在 app.js 之前（app.js 一加载就看 window.__TAURI__）
python3 - out/web/ui/index.html <<'PY'
import sys; p = sys.argv[1]; s = open(p, encoding="utf-8").read()
s = s.replace('<script src="locales/en.js"></script>', '<script src="android.js"></script>\n  <script src="locales/en.js"></script>', 1)
open(p, "w", encoding="utf-8").write(s)
PY

echo "== apk"
echo "sdk.dir=$SDK" > local.properties
if [ "$KIND" = release ]; then ./gradlew -q assembleRelease; ls -la app/build/outputs/apk/release/*.apk; else ./gradlew -q assembleDebug; ls -la app/build/outputs/apk/debug/*.apk; fi

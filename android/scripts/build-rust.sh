#!/usr/bin/env bash
# 编 libbeayy_mobile.so → app/src/main/jniLibs/<abi>/
# 依赖：rustup、Android NDK、cargo-ndk
# 用法（仓库根）：bash android/scripts/build-rust.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ANDROID_DIR/.." && pwd)"
OUT="$ANDROID_DIR/app/src/main/jniLibs"
ABI="${1:-arm64-v8a}"

if ! command -v cargo >/dev/null; then
  echo "需要 cargo / rustup" >&2
  exit 1
fi
if ! command -v cargo-ndk >/dev/null; then
  echo "安装 cargo-ndk：cargo install cargo-ndk" >&2
  exit 1
fi

case "$ABI" in
  arm64-v8a) TARGET=aarch64-linux-android ;;
  armeabi-v7a) TARGET=armv7-linux-androideabi ;;
  x86_64) TARGET=x86_64-linux-android ;;
  *) echo "未知 ABI: $ABI" >&2; exit 1 ;;
esac

rustup target add "$TARGET" >/dev/null
cd "$REPO_ROOT"
cargo ndk -t "$ABI" -o "$OUT" build -p beayy-mobile --release
echo "输出：$OUT/$ABI/libbeayy_mobile.so"
ls -la "$OUT/$ABI/" || true

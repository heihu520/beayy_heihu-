#!/bin/bash
# Beayy：编译 → 组装 .app → 签名 → 安装并启动。
# 用法：app/build.sh            正式版：装成 ~/Applications/Beayy.app，写正式数据目录
#       app/build.sh --shadow   测试版：装成 ~/Applications/Beayy-rs.app，写影子目录（BEAYY_SHADOW=1），不碰正式数据，可与正式版同时跑
#       加 --no-run 只装不启动
# bundle id、签名证书固定（com.fengli.beayy，团队 8R7XUVNM53），系统给的权限按「标识＋团队」认，重新编译不掉。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
# 签名身份：环境变量 BEAYY_SIGN_ID ＞ 本机的 Developer ID Application 证书 ＞ Apple Development 证书 ＞ 临时签名（-，只能本机用）
SIGN_ID="${BEAYY_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"')}"
[ -n "$SIGN_ID" ] || SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Apple Development[^"]*"' | head -1 | tr -d '"')"
[ -n "$SIGN_ID" ] || SIGN_ID="-"
MODE=release; RUN=1
for a in "$@"; do
  case "$a" in
    --shadow) MODE=shadow ;;
    --no-run) RUN=0 ;;
  esac
done
NAME=$([ "$MODE" = release ] && echo Beayy || echo Beayy-rs)
DIST="$HERE/target/dist/$NAME.app"
DEST="$HOME/Applications/$NAME.app"
BUILD_NUMBER="$(date +%Y%m%d%H%M%S)"

cd "$HERE"
cargo build --release -p beayy 2>&1 | grep -E "^error|warning: unused|Finished" || true
BIN="$HERE/target/release/beayy"
[ -x "$BIN" ] || { echo "编译失败"; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"
cp "$BIN" "$DIST/Contents/MacOS/beayy"
cp Resources/AppIcon.icns "$DIST/Contents/Resources/"
ENV_BLOCK=""
[ "$MODE" = shadow ] && ENV_BLOCK="<key>LSEnvironment</key><dict><key>BEAYY_SHADOW</key><string>1</string></dict>"
cat > "$DIST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.fengli.beayy</string>
  <key>CFBundleName</key><string>Be Authentic. Your Yesterdays.</string>
  <key>CFBundleDisplayName</key><string>Be Authentic. Your Yesterdays.</string>
  <key>CFBundleExecutable</key><string>beayy</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Be Authentic. Your Yesterdays. · beayy.com</string>
  $ENV_BLOCK
</dict></plist>
EOF

# Developer ID 签名要带安全时间戳（公证要求）；其他签名不用
TS="--timestamp=none"; case "$SIGN_ID" in "Developer ID"*) TS="--timestamp" ;; esac
codesign --force --options runtime $TS --sign "$SIGN_ID" "$DIST"
codesign --verify --strict "$DIST"

pkill -f "$DEST/Contents/MacOS/beayy" 2>/dev/null && sleep 1 || true
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$DIST" "$DEST"
# 编译目录里那份 .app 装完就删，免得被 Spotlight 找到、和正式版同时跑（10-16 出过一次，两份往正式目录重复写）
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$DIST" 2>/dev/null || true
rm -rf "$DIST"
echo "已安装 ${DEST}（${MODE}，build ${BUILD_NUMBER}）"
codesign -dv "$DEST" 2>&1 | grep -E "Identifier|TeamIdentifier" || true

# -n：测试版和同 bundle id 的正式版并存时，强制起一个新实例
[ "$RUN" = 1 ] && open -n "$DEST"
exit 0

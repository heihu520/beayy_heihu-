#!/bin/bash
# Beayy：编译 → 组装 .app → 签名 → 安装并启动。
# 用法：app/build.sh            测试版：装成 ~/Applications/Beayy-rs.app，写影子目录（BEAYY_SHADOW=1），不碰正式数据，可与正式版同时跑
#       app/build.sh --install  正式版：装成 ~/Applications/Beayy.app，写正式数据目录。会覆盖装着的正式版——
#                               平时用正式版的机器，正式版只装发布的安装包、靠自动更新，别用这个
#       加 --no-run 只装不启动（--shadow 是旧写法，等于不加参数）
#       app/build.sh --dmg      打安装包 target/Beayy-<版本>.dmg（不装到本机）。签名身份是 Developer ID 时，
#                               有公证凭据（BEAYY_NOTARY_KEY＝.p8 路径、BEAYY_NOTARY_KEY_ID、BEAYY_NOTARY_ISSUER）就交苹果公证并钉上票据
# bundle id、签名证书固定（com.fengli.beayy，团队 8R7XUVNM53），本机重新编译不掉权限；换证书种类会掉（见下面签名身份）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
MODE=shadow; RUN=1; DMG=0
for a in "$@"; do
  case "$a" in
    --install) MODE=release ;;
    --shadow) MODE=shadow ;;
    --no-run) RUN=0 ;;
    --dmg) DMG=1 ;;
  esac
done
# 安装包永远是正式版（10-16 发出过带 BEAYY_SHADOW=1 的 0.2.6／0.2.7 Mac 包：装上的人写影子目录、也不检查更新）
[ "$DMG" = 1 ] && MODE=release
# 签名身份：环境变量 BEAYY_SIGN_ID 优先，其次 Developer ID Application，没有再用 Apple Development。
# 系统授权（辅助功能、输入监控、完全磁盘访问）记在签名要求上：测试版和发布的正式版都用 Developer ID，bundle id 也相同，
# 授权一次两边都有；换成别的证书就得重新授权。
pick() { security find-identity -v -p codesigning 2>/dev/null | grep -o "\"$1[^\"]*\"" | head -1 | tr -d '"' || true; }
if [ -n "${BEAYY_SIGN_ID:-}" ]; then SIGN_ID="$BEAYY_SIGN_ID"
else SIGN_ID="$(pick "Developer ID Application")"; [ -n "$SIGN_ID" ] || SIGN_ID="$(pick "Apple Development")"
fi
[ -n "$SIGN_ID" ] || SIGN_ID="-"
NAME=$([ "$MODE" = release ] && echo Beayy || echo Beayy-rs)
DIST="$HERE/target/dist/$NAME.app"
DEST="$HOME/Applications/$NAME.app"
BUILD_NUMBER="$(date +%Y%m%d%H%M%S)"
# 版本号只在 Cargo.toml（workspace.package.version）改一处，Info.plist 跟着它
APP_VERSION=$(grep -m1 '^version' "$HERE/Cargo.toml" | cut -d'"' -f2)

cd "$HERE"
cargo build --release -p beayy 2>&1 | grep -E "^error|warning: unused|Finished" || true
BIN="$HERE/target/release/beayy"
[ -x "$BIN" ] || { echo "编译失败"; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"
cp "$BIN" "$DIST/Contents/MacOS/beayy"
cp Resources/AppIcon.icns "$DIST/Contents/Resources/"
ENV_BLOCK=""
DISPLAY_NAME="Be Authentic. Your Yesterdays."
# 测试版显示名单独起（Dock、⌘Tab、聚焦搜索、系统设置的授权列表里都看得出来），免得和正式版点混
[ "$MODE" = shadow ] && ENV_BLOCK="<key>LSEnvironment</key><dict><key>BEAYY_SHADOW</key><string>1</string></dict>" && DISPLAY_NAME="Beayy 测试版"
cat > "$DIST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.fengli.beayy</string>
  <key>CFBundleName</key><string>$DISPLAY_NAME</string>
  <key>CFBundleDisplayName</key><string>$DISPLAY_NAME</string>
  <key>CFBundleExecutable</key><string>beayy</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
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

if [ "$DMG" = 1 ]; then
  VER=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
  OUT="$HERE/target/Beayy-$VER.dmg"
  STAGE="$HERE/target/dmg"
  rm -rf "$STAGE" "$OUT" && mkdir -p "$STAGE"
  cp -R "$DIST" "$STAGE/Beayy.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Beayy" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
  rm -rf "$STAGE" "$DIST"
  case "$SIGN_ID" in
    "Developer ID"*)
      codesign --force --timestamp --sign "$SIGN_ID" "$OUT"
      if [ -n "${BEAYY_NOTARY_KEY:-}" ]; then
        xcrun notarytool submit "$OUT" --key "$BEAYY_NOTARY_KEY" --key-id "$BEAYY_NOTARY_KEY_ID" --issuer "$BEAYY_NOTARY_ISSUER" --wait
        xcrun stapler staple "$OUT"
        echo "已公证"
      else
        echo "没给公证凭据：这个 DMG 签了名但没公证，别的电脑打开会被拦"
      fi ;;
    *) echo "签名身份不是 Developer ID（${SIGN_ID}）：这个 DMG 只适合自己用，别的电脑打开会被拦" ;;
  esac
  echo "安装包 $OUT"
  exit 0
fi

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

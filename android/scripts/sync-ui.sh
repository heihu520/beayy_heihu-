#!/usr/bin/env bash
# 仓库根 ui/ → android/app/src/main/assets/ui/
# 用法（在仓库根）：bash android/scripts/sync-ui.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ANDROID_DIR/.." && pwd)"
SRC="$REPO_ROOT/ui"
DST="$ANDROID_DIR/app/src/main/assets/ui"
if [[ ! -d "$SRC" ]]; then
  echo "找不到 $SRC（请在合并进仓库后、于仓库根执行）" >&2
  exit 1
fi
rm -rf "$DST"
mkdir -p "$(dirname "$DST")"
cp -a "$SRC" "$DST"
echo "已同步 $SRC → $DST"

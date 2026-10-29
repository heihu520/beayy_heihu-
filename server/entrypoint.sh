#!/bin/sh
# 以 root 起：把挂进来的数据目录交给 beayy 用户（宿主机上新建的目录属主是 root），再降成 beayy 跑
set -e
if [ "$(id -u)" = 0 ]; then
  for d in "$BEAYY_SYNC_DIR" "$BEAYY_JOBS_DIR" "$BEAYY_BACKUP_DIR" "${MODELSCOPE_CACHE:-}"; do
    [ -n "$d" ] || continue
    mkdir -p "$d"
    [ "$(stat -c %u "$d")" = "$(id -u beayy)" ] || chown -R beayy:beayy "$d"
  done
  exec setpriv --reuid=beayy --regid=beayy --init-groups "$@"
fi
exec "$@"

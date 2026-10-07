#!/bin/sh
set -e
DATA_DIR="${HOSTY_APP_CACHE_DIR:-/var/cache/hosty-plans}"
if [ "$(id -u)" -ne 0 ]; then exec "$@"; fi
mkdir -p "$DATA_DIR"
owner="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo '0:0')"
case "$owner" in 0:*) chown node:node "$DATA_DIR" 2>/dev/null || true; owner="node:node";; esac
# Adopt the Core-owned mount's uid so cache writes never change ownership of host app data.
exec gosu "$owner" "$@"

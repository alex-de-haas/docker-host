#!/bin/sh
set -eu
# Only disposable Core-owned cache/data volumes need ownership initialization.
chown -R 1000:1000 /workspace/node_modules /workspace/apps/demo-app/node_modules /workspace/apps/demo-app/.next-experiment /app/data /app/cache
exec setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs "$@"

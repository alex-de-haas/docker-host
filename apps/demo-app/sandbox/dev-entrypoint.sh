#!/bin/sh
set -eu

# Ordinary Docker source runtimes create empty cache volumes as root. Initialize only
# their mount roots, then run setup and Next as the image's non-root application user.
# The offline sandbox already supplies writable caches and overrides the image user.
if [ "$(id -u)" = 0 ]; then
  case "${NEXT_DIST_DIR:-}" in
    .next-sandbox-backend|.next-sandbox-frontend) ;;
    *) echo "Expected a reviewed Demo App development cache" >&2; exit 1 ;;
  esac
  chown 1000:1000 /workspace/node_modules /workspace/apps/demo-app/node_modules \
    "/workspace/apps/demo-app/$NEXT_DIST_DIR"
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs "$@"
fi
exec "$@"

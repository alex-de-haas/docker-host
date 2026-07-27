#!/bin/sh
set -e

# The app runs unprivileged as the `node` user (uid 1000). The persistent data directory is a
# Core-managed mount: Core creates it with a plain Directory.CreateDirectory, so it arrives owned by
# whichever user runs Core (root in an installed setup). We start as root only to fix that ownership,
# then drop privileges with gosu before exec'ing the server.
DATA_DIR="${HOSTY_APP_DATA_DIR:-/var/lib/hosty-marketplace}"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR" 2>/dev/null || true

exec gosu node "$@"

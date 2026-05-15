#!/bin/sh
set -eu

DEFAULT_REPO="alex-de-haas/docker-host"
DEFAULT_TAG="cli-dev"

fail() {
  printf '%s\n' "docker-host install: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  sh scripts/install.sh [--start]

Environment overrides:
  DOCKER_HOST_INSTALL_REPO   GitHub repository, default alex-de-haas/docker-host
  DOCKER_HOST_INSTALL_TAG    GitHub Release tag, default cli-dev
  DOCKER_HOST_INSTALL_DIR    Directory for the docker-host executable, default ~/.docker-host/bin
  DOCKER_HOST_INSTALL_START  Set to 1 to run docker-host start and open after install
USAGE
}

START_AFTER_INSTALL="${DOCKER_HOST_INSTALL_START:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --start)
      START_AFTER_INSTALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument '$1'. Run with --help for usage."
      ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || fail "curl is required to download release assets."
command -v uname >/dev/null 2>&1 || fail "uname is required to detect OS and architecture."

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || fail "HOME is not set."

REPO="${DOCKER_HOST_INSTALL_REPO:-$DEFAULT_REPO}"
TAG="${DOCKER_HOST_INSTALL_TAG:-$DEFAULT_TAG}"
INSTALL_DIR="${DOCKER_HOST_INSTALL_DIR:-$HOME_DIR/.docker-host/bin}"

[ -n "$REPO" ] || fail "DOCKER_HOST_INSTALL_REPO cannot be empty."
[ -n "$TAG" ] || fail "DOCKER_HOST_INSTALL_TAG cannot be empty."
[ -n "$INSTALL_DIR" ] || fail "DOCKER_HOST_INSTALL_DIR cannot be empty."

case "$(uname -s)" in
  Darwin)
    OS_NAME="darwin"
    ;;
  Linux)
    OS_NAME="linux"
    ;;
  *)
    fail "unsupported OS '$(uname -s)'. Unix installer supports macOS and Linux."
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64)
    ARCH_NAME="arm64"
    ;;
  x86_64|amd64)
    ARCH_NAME="x64"
    ;;
  *)
    fail "unsupported architecture '$(uname -m)'."
    ;;
esac

ARTIFACT="docker-host-$OS_NAME-$ARCH_NAME"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t docker-host-install)"
TARGET="$INSTALL_DIR/docker-host"
TARGET_TMP="$TARGET.tmp.$$"

cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$TARGET_TMP"
}
trap cleanup EXIT INT TERM

download() {
  url="$1"
  dest="$2"
  curl -fsSL "$url" -o "$dest"
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
    return 0
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{ print $NF }'
    return 0
  fi

  return 127
}

printf '%s\n' "Downloading $ARTIFACT from $REPO@$TAG..."
download "$BASE_URL/$ARTIFACT" "$TMP_DIR/$ARTIFACT" || fail "failed to download $BASE_URL/$ARTIFACT."

if curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS" 2>/dev/null; then
  EXPECTED_SHA="$(awk -v name="$ARTIFACT" '$NF == name { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
  [ -n "$EXPECTED_SHA" ] || fail "SHA256SUMS does not contain an entry for $ARTIFACT."

  ACTUAL_SHA="$(sha256_file "$TMP_DIR/$ARTIFACT" || true)"
  [ -n "$ACTUAL_SHA" ] || fail "SHA256SUMS is available, but no sha256sum, shasum, or openssl command was found."

  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    fail "checksum mismatch for $ARTIFACT."
  fi

  printf '%s\n' "Verified SHA256 checksum."
else
  printf '%s\n' "SHA256SUMS was not available; continuing without checksum verification." >&2
fi

mkdir -p "$INSTALL_DIR"
cp "$TMP_DIR/$ARTIFACT" "$TARGET_TMP"
chmod 755 "$TARGET_TMP"
mv "$TARGET_TMP" "$TARGET"

printf '%s\n' "Installed docker-host to $TARGET"

"$TARGET" install

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    printf '\n%s\n' "Add docker-host to your PATH:"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

if [ "$START_AFTER_INSTALL" = "1" ]; then
  "$TARGET" start
  "$TARGET" open
else
  printf '\n%s\n' "Next commands:"
  printf '  %s start\n' "$TARGET"
  printf '  %s open\n' "$TARGET"
fi

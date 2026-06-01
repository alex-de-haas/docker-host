#!/bin/sh
set -eu

DEFAULT_REPO="alex-de-haas/docker-host"
DEFAULT_TAG="cli-dev"

fail() {
  printf '%s\n' "hosty install: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  sh scripts/install.sh [--start]

Environment overrides:
  HOSTY_INSTALL_REPO         GitHub repository, default alex-de-haas/docker-host
  HOSTY_INSTALL_TAG          GitHub Release tag, default cli-dev
  HOSTY_INSTALL_DIR          Directory for the hosty executable, default ~/.hosty/bin
  HOSTY_INSTALL_PROFILE      Shell profile to update for PATH, default auto-detect
  HOSTY_INSTALL_SKIP_PATH_UPDATE Set to 1 to skip shell profile updates
  HOSTY_INSTALL_START        Set to 1 to run hosty start and open after install

Legacy DOCKER_HOST_INSTALL_* variables are still accepted during migration.
USAGE
}

START_AFTER_INSTALL="${HOSTY_INSTALL_START:-${DOCKER_HOST_INSTALL_START:-0}}"
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

REPO="${HOSTY_INSTALL_REPO:-${DOCKER_HOST_INSTALL_REPO:-$DEFAULT_REPO}}"
TAG="${HOSTY_INSTALL_TAG:-${DOCKER_HOST_INSTALL_TAG:-$DEFAULT_TAG}}"
INSTALL_DIR="${HOSTY_INSTALL_DIR:-${DOCKER_HOST_INSTALL_DIR:-$HOME_DIR/.hosty/bin}}"

[ -n "$REPO" ] || fail "HOSTY_INSTALL_REPO cannot be empty."
[ -n "$TAG" ] || fail "HOSTY_INSTALL_TAG cannot be empty."
[ -n "$INSTALL_DIR" ] || fail "HOSTY_INSTALL_DIR cannot be empty."
case "$INSTALL_DIR" in
  *'
'*)
    fail "HOSTY_INSTALL_DIR cannot contain a newline."
    ;;
esac

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
TARGET="$INSTALL_DIR/hosty"
LEGACY_TARGET="$INSTALL_DIR/docker-host"
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

shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

detect_shell_profile() {
  if [ -n "${HOSTY_INSTALL_PROFILE:-}" ]; then
    printf '%s\n' "$HOSTY_INSTALL_PROFILE"
    return 0
  fi

  if [ -n "${DOCKER_HOST_INSTALL_PROFILE:-}" ]; then
    printf '%s\n' "$DOCKER_HOST_INSTALL_PROFILE"
    return 0
  fi

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME_DIR/.zshrc"
      ;;
    bash)
      if [ "$OS_NAME" = "darwin" ]; then
        if [ -f "$HOME_DIR/.bash_profile" ] || [ ! -f "$HOME_DIR/.bashrc" ]; then
          printf '%s\n' "$HOME_DIR/.bash_profile"
        else
          printf '%s\n' "$HOME_DIR/.bashrc"
        fi
      else
        printf '%s\n' "$HOME_DIR/.bashrc"
      fi
      ;;
    sh)
      printf '%s\n' "$HOME_DIR/.profile"
      ;;
    *)
      printf '%s\n' ""
      ;;
  esac
}

append_path_block() {
  profile="$1"
  quoted_install_dir="$(shell_single_quote "$INSTALL_DIR")"
  {
    printf '\n%s\n' "# >>> hosty PATH >>>"
    printf '%s\n' "# Added by hosty install.sh"
    printf 'HOSTY_INSTALL_BIN=%s\n' "$quoted_install_dir"
    printf '%s\n' 'case ":$PATH:" in'
    printf '%s\n' '  *":$HOSTY_INSTALL_BIN:"*) ;;'
    printf '%s\n' '  *) export PATH="$HOSTY_INSTALL_BIN:$PATH" ;;'
    printf '%s\n' 'esac'
    printf '%s\n' 'unset HOSTY_INSTALL_BIN'
    printf '%s\n' "# <<< hosty PATH <<<"
  } >> "$profile"
}

ensure_path_profile() {
  if [ "${HOSTY_INSTALL_SKIP_PATH_UPDATE:-${DOCKER_HOST_INSTALL_SKIP_PATH_UPDATE:-0}}" = "1" ]; then
    printf '\n%s\n' "Skipping shell profile PATH update because HOSTY_INSTALL_SKIP_PATH_UPDATE=1."
    print_manual_path_instruction
    return 0
  fi

  profile="$(detect_shell_profile)"
  if [ -z "$profile" ]; then
    printf '\n%s\n' "Could not auto-detect a POSIX shell profile for PATH persistence."
    print_manual_path_instruction
    return 0
  fi

  if [ -f "$profile" ] && grep -F "# >>> hosty PATH >>>" "$profile" >/dev/null 2>&1; then
    printf '\n%s\n' "hosty PATH entry is already managed in $profile"
    return 0
  fi

  if [ -f "$profile" ] && grep -F "$INSTALL_DIR" "$profile" >/dev/null 2>&1; then
    printf '\n%s\n' "$profile already references $INSTALL_DIR"
    return 0
  fi

  if append_path_block "$profile"; then
    printf '\n%s\n' "Added hosty to PATH in $profile"
    case ":$PATH:" in
      *":$INSTALL_DIR:"*)
        ;;
      *)
        printf '%s\n' "Open a new terminal, or run this for the current terminal:"
        printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
        ;;
    esac
  else
    printf '\n%s\n' "Could not update $profile." >&2
    print_manual_path_instruction
  fi
}

print_manual_path_instruction() {
  printf '%s\n' "Add hosty to your PATH:"
  printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
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
cp "$TARGET" "$LEGACY_TARGET"
chmod 755 "$LEGACY_TARGET"

printf '%s\n' "Installed hosty to $TARGET"
printf '%s\n' "Installed deprecated docker-host alias to $LEGACY_TARGET"

"$TARGET" install

ensure_path_profile

if [ "$START_AFTER_INSTALL" = "1" ]; then
  "$TARGET" start
  "$TARGET" open
else
  printf '\n%s\n' "Next commands:"
  printf '  %s start\n' "$TARGET"
  printf '  %s open\n' "$TARGET"
fi

#!/bin/sh
set -eu

DEFAULT_REPO="alex-de-haas/docker-host"

fail() {
  printf '%s\n' "hosty install: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  sh scripts/install.sh [--start] [--feed <id>]

Environment overrides:
  HOSTY_INSTALL_REPO         GitHub repository, default alex-de-haas/docker-host
  HOSTY_INSTALL_FEED         Feed ID; otherwise the publisher's declared default
  HOSTY_INSTALL_INDEX        HTTPS feed index; defaults to the selected repository
  HOSTY_INSTALL_TAG          Explicit legacy GitHub Release pin (incompatible with --feed)
  HOSTY_INSTALL_DIR          Directory for the hosty executable, default ~/.hosty/bin
  HOSTY_INSTALL_PROFILE      Shell profile to update for PATH, default auto-detect
  HOSTY_INSTALL_SKIP_PATH_UPDATE Set to 1 to skip shell profile updates
  HOSTY_INSTALL_START        Set to 1 to run hosty init after install (recommended apps, noninteractive)
USAGE
}

START_AFTER_INSTALL="${HOSTY_INSTALL_START:-0}"
FEED="${HOSTY_INSTALL_FEED:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --start)
      START_AFTER_INSTALL=1
      ;;
    --feed)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "--feed requires an ID."
      FEED="$2"
      shift
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

REPO="${HOSTY_INSTALL_REPO:-$DEFAULT_REPO}"
TAG="${HOSTY_INSTALL_TAG:-}"
INDEX_URL="${HOSTY_INSTALL_INDEX:-https://raw.githubusercontent.com/$REPO/app-releases/platform/feeds.json}"
[ -z "$TAG" ] || [ -z "$FEED" ] || fail "An explicit tag cannot be combined with a feed."
[ -z "$TAG" ] || [ -z "${HOSTY_INSTALL_INDEX:-}" ] || fail "An explicit tag cannot be combined with a feed index."
INSTALL_DIR="${HOSTY_INSTALL_DIR:-$HOME_DIR/.hosty/bin}"

[ -n "$REPO" ] || fail "HOSTY_INSTALL_REPO cannot be empty."
printf '%s' "$REPO" | LC_ALL=C grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail "Invalid repository name."
if [ -n "$TAG" ]; then
  printf '%s' "$TAG" | LC_ALL=C grep -Eq '^[A-Za-z0-9_.-]+$' || fail "Invalid legacy tag."
  case "$REPO/$TAG" in *..*) fail "Repository and tag cannot contain '..'." ;; esac
fi
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

ARTIFACT="hosty-$OS_NAME-$ARCH_NAME"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t hosty-install)"
TARGET="$INSTALL_DIR/hosty"
TARGET_TMP="$TARGET.tmp.$$"

cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$TARGET_TMP"
}
trap cleanup EXIT INT TERM

download() {
  url="$1"
  dest="$2"
  curl --proto '=https' --proto-redir '=https' -fsSL "$url" -o "$dest"
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
  if [ "${HOSTY_INSTALL_SKIP_PATH_UPDATE:-0}" = "1" ]; then
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

if [ -z "$TAG" ]; then
  command -v python3 >/dev/null 2>&1 || fail "Python 3 is required to validate feed metadata during installation."
  RID_OS="$OS_NAME"
  [ "$OS_NAME" != "darwin" ] || RID_OS="osx"
  python3 - "$INDEX_URL" "$FEED" "$RID_OS-$ARCH_NAME" "$TMP_DIR" <<'HOSTY_PLATFORM_BOOTSTRAP'
#!/usr/bin/env python3
"""Resolve one immutable native release before the Unix installer replaces files.

This module is embedded verbatim in install.sh; it requires only Python's standard library.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request
from urllib.parse import urlsplit
import uuid
import unicodedata


def require(condition, message):
    if not condition:
        raise ValueError(message)


def https(reference):
    require(isinstance(reference, str) and not any(ord(c) < 32 for c in reference), "Invalid release URL")
    uri = urlsplit(reference)
    require(uri.scheme == "https" and uri.hostname and not uri.username and not uri.password and not uri.fragment,
            "Release sources must use HTTPS without credentials or fragments")
    return reference


class SecureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        https(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def document(reference):
    with urllib.request.build_opener(SecureRedirect()).open(https(reference), timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
    require(0 < len(data) <= 1024 * 1024, "Release document is empty or too large")
    return json.loads(data), hashlib.sha256(data).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def select(index, requested):
    require(index.get("schemaVersion") == "hosty-platform-feeds.0.1", "Unsupported feed index")
    feeds = index.get("feeds")
    require(isinstance(feeds, list) and feeds, "The index contains no feeds")
    ids = set()
    defaults = []
    for feed in feeds:
        name = feed.get("id")
        require(isinstance(name, str) and 0 < len(name) <= 128 and name == name.strip()
                and not any(unicodedata.category(c) == "Cc" for c in name) and name not in ids, "Invalid or duplicate feed ID")
        ids.add(name)
        https(feed.get("releaseRef"))
        require(valid_hash(feed.get("releaseSha256")), "Missing release descriptor hash")
        require(isinstance(feed.get("default", False), bool), "Invalid default flag")
        if feed.get("default"):
            defaults.append(feed)
    require(len(defaults) <= 1, "Multiple default feeds")
    if requested:
        chosen = next((feed for feed in feeds if feed["id"] == requested), None)
        require(chosen is not None, "The requested feed does not exist; no fallback was selected")
        return chosen
    require(len(feeds) == 1 or defaults, "Choose a feed explicitly; this index has no default")
    return feeds[0] if len(feeds) == 1 else defaults[0]


def validate_release(release, rid):
    require(release.get("schemaVersion") == "hosty-platform-release.0.1"
            and valid_hash(release.get("releaseId")), "Unsupported or invalid platform release")
    require(re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", release.get("sourceCommit", "")), "Missing qualified source revision")
    require(isinstance(release.get("version"), str) and release["version"], "Missing release version")
    assets = release.get("assets")
    require(isinstance(assets, list) and assets, "Empty release assets")
    identities = set()
    targets = set()
    for asset in assets:
        role, target, name = asset.get("role"), asset.get("rid"), asset.get("fileName")
        require(role in ("cli", "core") and isinstance(target, str) and re.fullmatch(r"[a-zA-Z0-9.-]{1,64}", target), "Invalid asset role/target")
        require(isinstance(name, str) and name not in ("", ".", "..") and not re.search(r"[/\\:\x00-\x1f\x7f]", name), "Unsafe asset filename")
        require((role, target) not in identities, "Duplicate asset role/target")
        identities.add((role, target)); targets.add(target)
        require(type(asset.get("size")) is int and asset["size"] > 0
                and valid_hash(asset.get("sha256")) and valid_hash(asset.get("inputFingerprint"))
                and isinstance(asset.get("provenance"), str) and asset["provenance"], "Incomplete asset identity")
        https(asset.get("url"))
    require(all(("cli", target) in identities and ("core", target) in identities for target in targets), "Incomplete CLI/Core pair")
    require(rid in targets, "This release does not support the current platform")
    return next(asset for asset in assets if asset["role"] == "cli" and asset["rid"] == rid)


def main(arguments):
    reference, requested, rid, destination = arguments
    index, index_hash = document(reference)
    feed = select(index, requested)
    release, release_hash = document(feed["releaseRef"])
    require(release_hash == feed["releaseSha256"], "Release descriptor SHA256 mismatch")
    asset = validate_release(release, rid)
    selection = dict(source=dict(schemaVersion="hosty-platform-update-source.0.1", indexRef=reference,
                                 feedId=feed["id"], revision=uuid.uuid4().hex), feed=feed, release=release,
                     indexSha256=index_hash, descriptorSha256=release_hash)
    receipt = dict(schemaVersion="hosty-platform-install.0.1", selection=selection, rid=rid,
                   installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    target = Path(destination)
    (target / "release.json").write_text(json.dumps(receipt, separators=(",", ":")), encoding="utf-8")
    (target / "asset-url").write_text(asset["url"], encoding="utf-8")
    (target / "asset-sha").write_text(asset["sha256"], encoding="ascii")
    (target / "asset-size").write_text(str(asset["size"]), encoding="ascii")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit("hosty install: " + str(error))
HOSTY_PLATFORM_BOOTSTRAP
  ASSET_URL="$(cat "$TMP_DIR/asset-url")"
  EXPECTED_SHA="$(cat "$TMP_DIR/asset-sha")"
  EXPECTED_SIZE="$(cat "$TMP_DIR/asset-size")"
  printf '%s\n' "Downloading the selected feed's CLI release..."
  curl --proto '=https' --proto-redir '=https' -fsSL --max-filesize "$EXPECTED_SIZE" "$ASSET_URL" -o "$TMP_DIR/$ARTIFACT" || fail "failed to download the selected CLI asset."
  ACTUAL_SIZE="$(wc -c < "$TMP_DIR/$ARTIFACT" | tr -d ' ')"
  [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || fail "CLI asset size mismatch."
else
  printf '%s\n' "Downloading $ARTIFACT from explicit pin $REPO@$TAG..."
  download "$BASE_URL/$ARTIFACT" "$TMP_DIR/$ARTIFACT" || fail "failed to download $BASE_URL/$ARTIFACT."
  download "$BASE_URL/SHA256SUMS" "$TMP_DIR/SHA256SUMS" || fail "Release checksums are unavailable."
  EXPECTED_SHA="$(awk -v name="$ARTIFACT" '$NF == name { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
  [ -n "$EXPECTED_SHA" ] || fail "SHA256SUMS does not contain an entry for $ARTIFACT."
  CORE_ARTIFACT="hosty-core-$OS_NAME-$ARCH_NAME"
  CORE_SHA="$(awk -v name="$CORE_ARTIFACT" '$NF == name { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
  printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{64}$' || fail "Invalid CLI checksum."
  printf '%s' "$CORE_SHA" | grep -Eq '^[0-9a-f]{64}$' || fail "Missing or invalid paired Core checksum."
  RID_OS="$OS_NAME"; [ "$OS_NAME" != "darwin" ] || RID_OS="osx"
  printf '{"schemaVersion":"hosty-platform-legacy-pin.0.1","repository":"%s","tag":"%s","rid":"%s-%s","cliSha256":"%s","coreSha256":"%s"}\n' "$REPO" "$TAG" "$RID_OS" "$ARCH_NAME" "$EXPECTED_SHA" "$CORE_SHA" > "$TMP_DIR/legacy-source.json"
fi

ACTUAL_SHA="$(sha256_file "$TMP_DIR/$ARTIFACT" || true)"
[ -n "$ACTUAL_SHA" ] || fail "checksum verification is required, but no sha256sum, shasum, or openssl command was found."

if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  fail "checksum mismatch for $ARTIFACT."
fi

printf '%s\n' "Verified SHA256 checksum."

mkdir -p "$INSTALL_DIR"
cp "$TMP_DIR/$ARTIFACT" "$TARGET_TMP"
chmod 755 "$TARGET_TMP"
mv "$TARGET_TMP" "$TARGET"
if [ -f "$TMP_DIR/release.json" ]; then
  chmod 600 "$TMP_DIR/release.json"
  cp "$TMP_DIR/release.json" "$TARGET.release.json.tmp.$$"
  mv "$TARGET.release.json.tmp.$$" "$TARGET.release.json"
  rm -f "$TARGET.legacy-source.json"
else
  # An explicit pin must not inherit a receipt from an earlier feed installation.
  rm -f "$TARGET.release.json"
  cp "$TMP_DIR/legacy-source.json" "$TARGET.legacy-source.json.tmp.$$"
  mv "$TARGET.legacy-source.json.tmp.$$" "$TARGET.legacy-source.json"
fi

printf '%s\n' "Installed hosty to $TARGET"

"$TARGET" install

ensure_path_profile

if [ "$START_AFTER_INSTALL" = "1" ]; then
  "$TARGET" init --yes
else
  printf '\n%s\n' "Next command:"
  printf '  %s init\n' "$TARGET"
fi

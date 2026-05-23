#!/bin/sh
set -eu

REPO="alex-de-haas/docker-host"
REF="main"
SKILL_PATH="skills/docker-host-module"
SKILL_NAME="docker-host-module"
DEST_ROOT="${CODEX_HOME:-$HOME/.codex}/skills"
SOURCE_DIR=""
DRY_RUN="false"

usage() {
  cat <<'EOF'
Install or update the Docker Host Module Codex skill.

Usage:
  install-docker-host-module-skill.sh [options]

Options:
  --repo OWNER/REPO       GitHub repository to install from. Default: alex-de-haas/docker-host
  --ref REF               Git branch, tag, or commit SHA. Default: main
  --path PATH             Skill path inside the repository. Default: skills/docker-host-module
  --name NAME             Destination skill name. Default: docker-host-module
  --dest DIR              Destination skills root. Default: ${CODEX_HOME:-$HOME/.codex}/skills
  --source-dir DIR        Install from a local skill directory instead of GitHub
  --dry-run               Print what would happen without changing files
  -h, --help              Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-docker-host-module-skill.sh | sh
  curl -fsSL https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install-docker-host-module-skill.sh | sh -s -- --ref main
  scripts/install-docker-host-module-skill.sh --source-dir skills/docker-host-module
EOF
}

die() {
  printf '%s\n' "Error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

safe_rm_dir() {
  target="$1"
  case "$target" in
    ""|"/"|"$HOME"|"$HOME/"|".")
      die "Refusing to remove unsafe path: $target"
      ;;
  esac
  rm -rf "$target"
}

copy_skill() {
  src="$1"
  dest="$2"
  tmp_dest="${dest}.tmp.$$"
  backup_dest="${dest}.backup.$$"

  [ -f "$src/SKILL.md" ] || die "SKILL.md not found in $src"
  [ -f "$src/agents/openai.yaml" ] || die "agents/openai.yaml not found in $src"

  if [ "$DRY_RUN" = "true" ]; then
    if [ -e "$dest" ]; then
      printf '%s\n' "Would update $dest from $src"
    else
      printf '%s\n' "Would install $dest from $src"
    fi
    return 0
  fi

  safe_rm_dir "$tmp_dest"
  cp -R "$src" "$tmp_dest"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$backup_dest"
    if mv "$tmp_dest" "$dest"; then
      safe_rm_dir "$backup_dest"
      printf '%s\n' "Updated $dest"
    else
      mv "$backup_dest" "$dest"
      safe_rm_dir "$tmp_dest"
      die "Failed to update $dest; previous skill restored"
    fi
  else
    mkdir -p "$(dirname "$dest")"
    mv "$tmp_dest" "$dest"
    printf '%s\n' "Installed $dest"
  fi
}

download_skill() {
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/docker-host-skill.XXXXXX")"
  archive="$tmp_root/repo.tar.gz"
  extract_dir="$tmp_root/extract"
  mkdir -p "$extract_dir"

  owner_repo="$REPO"
  url="https://codeload.github.com/$owner_repo/tar.gz/$REF"

  need_cmd curl
  need_cmd tar

  auth_header=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer $GITHUB_TOKEN"
  elif [ -n "${GH_TOKEN:-}" ]; then
    auth_header="Authorization: Bearer $GH_TOKEN"
  fi

  if [ -n "$auth_header" ]; then
    curl -fsSL -H "$auth_header" "$url" -o "$archive"
  else
    curl -fsSL "$url" -o "$archive"
  fi

  tar -xzf "$archive" -C "$extract_dir"
  repo_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$repo_root" ] || die "Downloaded archive was empty"

  skill_src="$repo_root/$SKILL_PATH"
  copy_skill "$skill_src" "$DEST_ROOT/$SKILL_NAME"
  safe_rm_dir "$tmp_root"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires a value"
      REPO="$2"
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires a value"
      REF="$2"
      shift 2
      ;;
    --path)
      [ "$#" -ge 2 ] || die "--path requires a value"
      SKILL_PATH="$2"
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || die "--name requires a value"
      SKILL_NAME="$2"
      shift 2
      ;;
    --dest)
      [ "$#" -ge 2 ] || die "--dest requires a value"
      DEST_ROOT="$2"
      shift 2
      ;;
    --source-dir)
      [ "$#" -ge 2 ] || die "--source-dir requires a value"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

case "$REPO" in
  */*) ;;
  *) die "--repo must be in OWNER/REPO format" ;;
esac

case "$SKILL_NAME" in
  ""|*/*|.*|*..*) die "--name must be a simple skill directory name" ;;
esac

if [ -n "$SOURCE_DIR" ]; then
  copy_skill "$SOURCE_DIR" "$DEST_ROOT/$SKILL_NAME"
else
  download_skill
fi

printf '%s\n' "Restart Codex to pick up the installed or updated skill."

#!/bin/sh
set -eu

REPO="alex-de-haas/docker-host"
REF="main"
SKILL_PATH="skills/hosty-app-skill"
SKILL_NAME="hosty-app-skill"
AGENT="all"
DEST_OVERRIDE=""
SOURCE_DIR=""
DRY_RUN="false"

# Skills directories read by each supported agent. The skill ships both a
# SKILL.md (Claude Code) and agents/openai.yaml (Codex), so the same directory
# works for every agent.
CLAUDE_SKILLS_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
CODEX_SKILLS_ROOT="${CODEX_HOME:-$HOME/.codex}/skills"

usage() {
  cat <<EOF
Install or update the Hosty App agent skill for all installed agents.

Usage:
  install-hosty-app-skill.sh [options]

Options:
  --agent NAME        Target agent: claude, codex, or all. Default: all
  --repo OWNER/REPO   GitHub repository to install from. Default: $REPO
  --ref REF           Git branch, tag, or commit SHA. Default: $REF
  --path PATH         Skill path inside the repository. Default: $SKILL_PATH
  --name NAME         Destination skill name. Default: $SKILL_NAME
  --dest DIR          Install into a single skills root instead of per-agent ones
  --source-dir DIR    Install from a local skill directory instead of GitHub
  --dry-run           Print what would happen without changing files
  -h, --help          Show this help

Default destinations (--agent all installs only into agents already present):
  Claude Code: $CLAUDE_SKILLS_ROOT/$SKILL_NAME
  Codex:       $CODEX_SKILLS_ROOT/$SKILL_NAME

Examples:
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/scripts/install-hosty-app-skill.sh | sh
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/scripts/install-hosty-app-skill.sh | sh -s -- --agent codex
  scripts/install-hosty-app-skill.sh --source-dir skills/hosty-app-skill
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

# Codex cannot load a skill without its agents/openai.yaml metadata, so require
# it before installing into a Codex destination (Claude Code only needs SKILL.md).
require_codex_assets() {
  [ -f "$1/agents/openai.yaml" ] || \
    die "agents/openai.yaml not found in $1; Codex needs it. Use --agent claude to install for Claude Code only."
}

install_to_targets() {
  src="$1"

  if [ -n "$DEST_OVERRIDE" ]; then
    copy_skill "$src" "$DEST_OVERRIDE/$SKILL_NAME"
    return 0
  fi

  # An explicit --agent is a deliberate request, so install (and create the
  # directory) even if that agent is not set up yet.
  if [ "$AGENT" = "claude" ]; then
    copy_skill "$src" "$CLAUDE_SKILLS_ROOT/$SKILL_NAME"
    return 0
  fi
  if [ "$AGENT" = "codex" ]; then
    require_codex_assets "$src"
    copy_skill "$src" "$CODEX_SKILLS_ROOT/$SKILL_NAME"
    return 0
  fi

  # --agent all: only install into agents that are already present, so we never
  # create an unused ~/.claude or ~/.codex on a machine that uses just one.
  installed=0
  if [ -d "$(dirname "$CLAUDE_SKILLS_ROOT")" ]; then
    copy_skill "$src" "$CLAUDE_SKILLS_ROOT/$SKILL_NAME"
    installed=1
  fi
  if [ -d "$(dirname "$CODEX_SKILLS_ROOT")" ]; then
    require_codex_assets "$src"
    copy_skill "$src" "$CODEX_SKILLS_ROOT/$SKILL_NAME"
    installed=1
  fi

  if [ "$installed" -eq 0 ]; then
    die "No supported agent found (looked for $(dirname "$CLAUDE_SKILLS_ROOT") and $(dirname "$CODEX_SKILLS_ROOT")). Re-run with --agent claude or --agent codex to install anyway."
  fi
}

download_skill() {
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/hosty-app-skill.XXXXXX")"
  archive="$tmp_root/repo.tar.gz"
  extract_dir="$tmp_root/extract"
  mkdir -p "$extract_dir"

  url="https://codeload.github.com/$REPO/tar.gz/$REF"

  need_cmd curl
  need_cmd tar

  auth_token=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_token="$GITHUB_TOKEN"
  elif [ -n "${GH_TOKEN:-}" ]; then
    auth_token="$GH_TOKEN"
  fi

  if [ -n "$auth_token" ]; then
    # Pass the Authorization header through a stdin-fed curl config so the
    # token is never visible in the process list.
    curl -fsSL --config - "$url" -o "$archive" <<EOF
header = "Authorization: Bearer $auth_token"
EOF
  else
    curl -fsSL "$url" -o "$archive"
  fi

  tar -xzf "$archive" -C "$extract_dir"
  repo_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$repo_root" ] || die "Downloaded archive was empty"

  install_to_targets "$repo_root/$SKILL_PATH"
  safe_rm_dir "$tmp_root"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      [ "$#" -ge 2 ] || die "--agent requires a value"
      AGENT="$2"
      shift 2
      ;;
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
      DEST_OVERRIDE="$2"
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

case "$AGENT" in
  claude|codex|all) ;;
  *) die "--agent must be one of: claude, codex, all" ;;
esac

case "$REPO" in
  */*) ;;
  *) die "--repo must be in OWNER/REPO format" ;;
esac

case "$SKILL_NAME" in
  ""|*/*|.*|*..*) die "--name must be a simple skill directory name" ;;
esac

if [ -n "$SOURCE_DIR" ]; then
  install_to_targets "$SOURCE_DIR"
else
  download_skill
fi

if [ "$DRY_RUN" != "true" ]; then
  printf '%s\n' "Restart your agent (Claude Code or Codex) to pick up the installed or updated skill."
fi

#!/usr/bin/env bash
#
# Decides which tags a publishing job may write. Invoked by action.yml with IMAGE, VERSION and
# REGISTRY_TOKEN in the environment; writes `fresh` and `push_version` to $GITHUB_OUTPUT.
#
# The two answers are deliberately independent:
#
#   fresh        — may this run MOVE a mutable tag (`latest`, a rolling release tag) that already
#                  points somewhere else?
#   push_version — may this run CREATE a version tag that exists nowhere yet?
#
# Creating an absent tag is not moving one, so it stays allowed even for a stale run. Tying the two
# together strands version tags: an unrelated commit landing on main (docs, core, cardputer — none of
# which match this workflow's paths filter) makes a queued run stale, and then no successor run ever
# publishes the version its manifest already pins.
#
# Lives in its own file rather than inline in action.yml so shellcheck can lint it directly:
# actionlint shellchecks `run:` blocks in workflows, but not the body of a composite action.

set -euo pipefail

# --- Freshness: may we move mutable tags? ---------------------------------------------------------
# The caller's job-level `concurrency` group serializes publishes but does not order them. GitHub
# makes no FIFO promise about which queued run is admitted next, and the gate `test` job sits outside
# the group, so a newer commit can clear testing first, take the publish slot, and finish before an
# older commit's publish job even starts. Whatever runs last wins the mutable tags, which is how
# `:latest` ends up on an older build than main.
#
# Every step of a grouped job runs after the slot is held, so re-reading the tip of main here is a
# check the holder can trust: no other run in this group can publish until we release the slot. That
# also makes the check-then-tag below atomic with respect to sibling runs, so the version-tag probe
# cannot be raced.
tip="$(git ls-remote origin refs/heads/main | cut -f1)"
if [[ -z "$tip" ]]; then
  echo "Could not resolve the tip of refs/heads/main from origin" >&2
  exit 1
fi

if [[ "$tip" == "$GITHUB_SHA" ]]; then
  echo "fresh=true" >> "$GITHUB_OUTPUT"
else
  echo "fresh=false" >> "$GITHUB_OUTPUT"
  # Deliberately generic: callers differ in what they still publish when stale. The image workflows
  # push their immutable `sha-` tag (and may still create an absent version tag); cli-release and
  # cardputer-release publish nothing at all, having no immutable artifact to fall back on.
  echo "::notice title=Stale publish::${GITHUB_SHA} is no longer the tip of main (${tip}). No mutable tag is moved; whatever this workflow publishes immutably is unaffected."
fi

# --- Version tag: may we create it? ---------------------------------------------------------------
# A version tag is immutable: first publish wins. A rebuild that does not change the declared version
# (a Dependabot lockfile bump, which AGENTS.md exempts from version bumps) still publishes `latest`
# and `sha-`, so the dependency fix ships — but it must not overwrite an already-published version tag
# with different bytes. Hosty's docker adapter TOFU-freezes a tag at install time, so a host resolving
# that tag later would otherwise get different artifacts for the same declared app version.
#
# Note this runs even when the run is stale, on purpose (see the header). A stale run creating its own
# declared version tag writes the build that actually declared that version, which is exactly right.
if [[ -z "${VERSION:-}" ]]; then
  echo "push_version=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ -z "${IMAGE:-}" ]]; then
  echo "publish-guard: 'version' was set without 'image'" >&2
  exit 1
fi

repository="${IMAGE#ghcr.io/}"

# A raw registry HEAD, not `docker buildx imagetools inspect`: the buildx probe measured ~7x slower
# against the same registry for the same answer.
token="$(curl -fsSL -u "x-access-token:${REGISTRY_TOKEN:-}" \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull" | jq -r '.token')"
if [[ -z "$token" || "$token" == "null" ]]; then
  echo "Could not obtain a ghcr.io pull token for ${repository}" >&2
  exit 1
fi

# Not named `status`: that identifier is read-only in zsh, which makes this block hostile to
# copy-paste debugging outside the runner's bash.
http_status="$(curl -sS -o /dev/null -w '%{http_code}' --head \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repository}/manifests/${VERSION}")"

case "$http_status" in
  404)
    echo "push_version=true" >> "$GITHUB_OUTPUT"
    echo "${IMAGE}:${VERSION} is unpublished; this run will create it."
    ;;
  200)
    echo "push_version=false" >> "$GITHUB_OUTPUT"
    echo "::notice title=Version tag frozen::${IMAGE}:${VERSION} already exists and is not moved. Bump the app manifest version to publish a new one; this build is still available as latest and sha-${GITHUB_SHA}."
    ;;
  *)
    # Do not guess. Silently skipping would leave a manifest pinning an unpublished tag; silently
    # tagging would move a frozen one. Both are worse than a re-runnable failure.
    echo "Unexpected HTTP ${http_status} from ghcr.io while checking ${IMAGE}:${VERSION}" >&2
    exit 1
    ;;
esac

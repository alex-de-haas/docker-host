import type { AppUpdateAvailability, CoreApp, CoreUpdateStatus } from "./types";

// Kept a leaf module — types only, no runtime imports — so it stays directly testable under
// `node --test`, which cannot resolve the extensionless specifiers app-helpers reaches for. That is
// also why `shortDigest` lives here rather than there: app-helpers re-exports it for its own callers.

// One exact identifier behind a version string. A version alone cannot tell two builds apart — a
// source app re-published from a moved branch tip keeps its version, and so does a re-pushed image
// tag — so the dashboard's version tooltips name the revision the version actually resolves to.
export type AppRevision = { label: string; value: string };

// Revisions of the build that is installed right now: the reviewed source pin, then each compiled
// service's locked image digest. Read from the app record alone, so a row shows them whether or not
// an update has ever been checked for.
export function collectInstalledRevisions(app: CoreApp): AppRevision[] {
  const revisions: AppRevision[] = [];
  const sourceCommit = app.sourceCommit?.trim();
  if (sourceCommit) {
    revisions.push({ label: "Source commit", value: sourceCommit });
  }

  for (const [service, lock] of sortedEntries(app.artifactLocks)) {
    const digest = lock?.imageDigest?.trim();
    if (digest) {
      revisions.push({ label: `${service} image`, value: digest });
    }
  }

  return revisions;
}

// Revisions of the build the pending update resolves to, projected onto the verdict by the same plan
// build. Empty for a Core that predates the projection, and for an update whose inputs are entirely
// manifest-side (a settings or port change carries no artifact of its own).
//
// Order is part of the contract, not incidental: the source commit first, then services by name. The
// inline label below shows the first of these, so a reader hovering it must find that same revision
// at the top of the tooltip.
export function collectTargetRevisions(verdict: AppUpdateAvailability | null | undefined): AppRevision[] {
  if (!verdict) {
    return [];
  }

  const revisions: AppRevision[] = [];
  const sourceCommit = verdict.targetSourceCommit?.trim();
  if (sourceCommit) {
    revisions.push({ label: "Source commit", value: sourceCommit });
  }

  for (const [service, digest] of sortedEntries(verdict.targetArtifactDigests)) {
    const trimmed = digest?.trim();
    if (trimmed) {
      revisions.push({ label: `${service} image`, value: trimmed });
    }
  }

  return revisions;
}

// The revision the inline label falls back to — the first one collectTargetRevisions would list.
// Derived directly rather than by building and sorting that whole list for its head: this runs on
// every row of every render, and the label only ever needs one value.
function firstTargetRevision(verdict: AppUpdateAvailability | null | undefined): string | null {
  const sourceCommit = verdict?.targetSourceCommit?.trim();
  if (sourceCommit) {
    return sourceCommit;
  }

  let firstService: string | null = null;
  let firstDigest: string | null = null;
  for (const [service, digest] of Object.entries(verdict?.targetArtifactDigests ?? {})) {
    const trimmed = digest?.trim();
    if (trimmed && (firstService === null || service.localeCompare(firstService) < 0)) {
      firstService = service;
      firstDigest = trimmed;
    }
  }

  return firstDigest;
}

// Abbreviates a sha256 image digest to `sha256:` + the first 12 hex chars for compact display.
// Only real digests (`sha256:`-prefixed or a bare 64-hex string) are shortened; any other token is
// returned unchanged so non-digest identifiers are never mis-rendered with a fake `sha256:` prefix.
export function shortDigest(digest?: string | null): string | null {
  const trimmed = digest?.trim();
  if (!trimmed) {
    return null;
  }

  const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return trimmed;
  }

  return `sha256:${hex.slice(0, 12)}`;
}

// Abbreviates one revision for inline display: a git commit to its familiar 7-character prefix, an
// image digest to the `sha256:` short form the rest of the UI uses, anything else verbatim.
export function shortRevision(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, 7) : shortDigest(trimmed);
}

// What the row shows under the installed version. Normally the version the update advances to; when
// the update does not move the version — the common case for a source app tracking a branch — the
// short target revision instead, because repeating the installed number in the update's colour reads
// as a rendering bug rather than as "same version, newer build". Null when the verdict names neither,
// which is what an older Core sends: the row then falls back to the installed version alone.
export function resolveAvailableVersionLabel(
  installedVersion: string,
  verdict: AppUpdateAvailability | null | undefined,
): { label: string; isVersion: boolean } | null {
  const targetVersion = verdict?.targetVersion?.trim();
  if (targetVersion && targetVersion !== installedVersion.trim()) {
    return { label: targetVersion, isVersion: true };
  }

  const revision = shortRevision(firstTargetRevision(verdict));
  return revision ? { label: revision, isVersion: false } : null;
}

function sortedEntries<T>(source: Record<string, T> | null | undefined): [string, T][] {
  return Object.entries(source ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

// The platform row's counterpart to resolveAvailableVersionLabel. Core's check is a binary-hash
// comparison, so unlike an app it has no revision to fall back on: when the release publishes no
// version marker (an older release, or a Core that predates the field), or republishes the version
// already installed, there is nothing truthful to put under the installed version and the "Update
// Core" button carries the news alone.
export function resolveAvailableCoreVersion(
  installedVersion: string,
  coreUpdate: CoreUpdateStatus | null | undefined,
): string | null {
  if (coreUpdate?.updateAvailable !== true) {
    return null;
  }

  const available = coreUpdate.availableVersion?.trim();
  return available && available !== installedVersion.trim() ? available : null;
}

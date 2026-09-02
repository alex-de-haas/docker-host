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

// The version the row shows under the installed one: whatever the update resolves to, including when
// that equals the installed version. An update that keeps its version is the normal shape for a source
// app tracking a branch, and the row still has to answer "which version am I getting" — the tooltip
// carries the commit that separates the two builds. Null only when the verdict names no version at
// all, which is what a Core predating the projection sends: the row then shows the installed version
// alone with its update affordance.
export function resolveAvailableVersionLabel(verdict: AppUpdateAvailability | null | undefined): string | null {
  return verdict?.targetVersion?.trim() || null;
}

function sortedEntries<T>(source: Record<string, T> | null | undefined): [string, T][] {
  return Object.entries(source ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

// The platform row's counterpart to resolveAvailableVersionLabel, and it answers the same way: the
// version the channel publishes, including when it matches the installed one — a rolling channel
// republishes the same version routinely, and "0.97.0 is what you would get" is still the answer to
// the question the row asks. Null when no update is offered, or when the release carries no version
// marker (an older release, or a Core that predates the field) and nothing can be named.
export function resolveAvailableCoreVersion(coreUpdate: CoreUpdateStatus | null | undefined): string | null {
  return coreUpdate?.updateAvailable === true ? coreUpdate.availableVersion?.trim() || null : null;
}

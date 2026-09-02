import assert from "node:assert/strict";
import test from "node:test";
import {
  collectInstalledRevisions,
  collectTargetRevisions,
  resolveAvailableCoreVersion,
  resolveAvailableVersionLabel,
} from "../src/app/shell/app-versions.ts";

const commit = "d2ab178826672cd96f0a96fc34dd6e2364ff2979";
const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function app(overrides = {}) {
  return { id: "com.example.app", displayName: "App", version: "1.0.0", ...overrides };
}

function verdict(overrides = {}) {
  return { updateAvailable: true, requiresReview: false, checkedAt: "2026-09-02T00:00:00Z", ...overrides };
}

test("installed revisions cover the source pin and every locked service digest", () => {
  const revisions = collectInstalledRevisions(app({
    sourceCommit: commit,
    artifactLocks: { ui: { imageDigest: digest }, backend: { imageDigest: digest } },
  }));
  assert.deepEqual(revisions, [
    { label: "Source commit", value: commit },
    // Services are sorted, so the tooltip does not reshuffle between renders of the same app.
    { label: "backend image", value: digest },
    { label: "ui image", value: digest },
  ]);
});

test("a lock with no resolved digest contributes nothing", () => {
  assert.deepEqual(collectInstalledRevisions(app({ artifactLocks: { ui: { imageDigest: null } } })), []);
});

test("target revisions read the projection the plan build attached to the verdict", () => {
  assert.deepEqual(
    collectTargetRevisions(verdict({ targetSourceCommit: commit, targetArtifactDigests: { ui: digest } })),
    [
      { label: "Source commit", value: commit },
      { label: "ui image", value: digest },
    ],
  );
});

test("a Core that predates the projection yields no target revisions", () => {
  assert.deepEqual(collectTargetRevisions(verdict()), []);
  assert.deepEqual(collectTargetRevisions(null), []);
});

test("a version-advancing update shows the target version", () => {
  assert.equal(resolveAvailableVersionLabel(verdict({ targetVersion: "1.1.0", targetSourceCommit: commit })), "1.1.0");
});

// An update that keeps its version is the normal shape for a source app tracking a branch: the row
// still names the version it would install, and the tooltip carries the commit that tells the two
// builds apart. Showing a bare hash here instead was rejected on review of the live dashboard.
test("an update that does not move the version still names that version", () => {
  assert.equal(resolveAvailableVersionLabel(verdict({ targetVersion: "0.23.1", targetSourceCommit: commit })), "0.23.1");
});

test("a verdict naming no version shows nothing under the installed one", () => {
  assert.equal(resolveAvailableVersionLabel(verdict()), null);
  assert.equal(resolveAvailableVersionLabel(null), null);
});

function coreUpdate(overrides = {}) {
  return {
    currentVersion: "0.97.0",
    updateAvailable: true,
    releaseTag: "cli-dev",
    checkedAt: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

test("the platform row names the version the release channel publishes", () => {
  assert.equal(resolveAvailableCoreVersion(coreUpdate({ availableVersion: "0.98.0" })), "0.98.0");
});

// The release published before the VERSION marker existed, or a Core build that predates the field:
// the hash comparison still says an update exists, but nothing can name it.
test("a verdict with no version marker names no version", () => {
  assert.equal(resolveAvailableCoreVersion(coreUpdate({ availableVersion: null })), null);
  assert.equal(resolveAvailableCoreVersion(coreUpdate()), null);
});

// A rolling channel republishes the same version routinely; the row names it anyway, the same way an
// app row does, because it is still the answer to "which version would I get".
test("a republished build of the installed version is still named", () => {
  assert.equal(resolveAvailableCoreVersion(coreUpdate({ availableVersion: " 0.97.0 " })), "0.97.0");
});

test("no update means no second line, whatever the marker says", () => {
  assert.equal(resolveAvailableCoreVersion(coreUpdate({ updateAvailable: false, availableVersion: "0.98.0" })), null);
  assert.equal(resolveAvailableCoreVersion(null), null);
});

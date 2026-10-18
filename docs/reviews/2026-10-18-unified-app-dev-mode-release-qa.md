# Unified Ordinary-App Dev Mode — Published-Build Acceptance, 2026-10-18

Baseline: merge commit `baf45dce16fff70f5e54cb1e8a0564f5c3ce30c0` from
[PR #608](https://github.com/alex-de-haas/docker-host/pull/608).
This report supplements the broader
[implementation acceptance](2026-10-18-unified-app-dev-mode-qa.md) with a release-only run.
It does not supersede that report's regression matrix or close the deferred D1 migration assessment
in the [development-controls plan](../features/app-development-controls/plan.md).

## Result And Artifact Provenance

The selected release journey passed: real Codex through Harness, prompted denial and approval,
unprompted exact replay and Return, a live worktree edit against ordinary app data, Core and Harness
restart recovery, and complete disposable-stand cleanup. No product-code fix was needed.

| Artifact | Verified release |
| --- | --- |
| Core and CLI | 0.141.0, downloaded macOS arm64 release binaries; both checksums matched the published SHA-256 files. Core reported `Launch: release`. |
| Shell | 0.105.0; running image revision label matched the baseline merge. Image digest: `sha256:1326ed79e6ce3f1c4a5093afdf5d66177888dd8bcded643803de41b5d91a6961`. |
| Harness | 0.58.0, unchanged files from the published merge archive, installed with its ordinary `local` runtime and normal dependency/web-build setup. No source-watch mode or local patch was used. |
| Shared agent worker | Published `ghcr.io/alex-de-haas/hosty-agent-worker:0.58.0`; digest `sha256:3b7a231cef9133917bc02b0c66b763984b74af4d891e6d2c862d83aaa1d3a947`. |

The official [release-assets job](https://github.com/alex-de-haas/docker-host/actions/runs/39135593737),
[Shell image job](https://github.com/alex-de-haas/docker-host/actions/runs/39135593676),
[worker image job](https://github.com/alex-de-haas/docker-host/actions/runs/39135593617) and
[merge CI](https://github.com/alex-de-haas/docker-host/actions/runs/39135593556) all completed successfully.

The isolated data root was `/private/tmp/hosty-dev-release-20261018/parent`; instance
`0b70f6be02ba42d78e27510ea33fb416`. Normal Core bootstrap and password login were used.
Only this stand received the approved temporary Codex authorization and Harness authority
`apps.lifecycle` / `apps.sources.full`. No primary credentials, app permissions or Docker resource
limits were changed.

## Fixture And Journey

`local.dev-release-notes` was a synthetic single-service notes app, built into a local ordinary
Docker image and paired with a Docker development profile. The platform artifacts above were
published builds; the notes fixture was not a published Demo App release. Its source was a local
Git repository without a remote. The agent prepared its registered worktree through Harness.
No fixture changes were committed or published after the initial fixture repository was prepared.

| Check | Observed result |
| --- | --- |
| Ask — deny | Denying the real agent's `app_dev_apply` request left ordinary Docker running, created no Core apply receipt and preserved managed-data hashes. |
| Ask — allow | Retrying the same reviewed request with approval entered `active / dev / running / healthy`, retaining a verified pre-entry backup. |
| Live edit | The agent changed only `client.tsx`'s visible heading to `Published dev-mode live edit`. Browser reload displayed it without container replacement or restart. Git HEAD and original source remained unchanged. |
| Ordinary data | A note written before entry and another written during dev were visible throughout recovery and after Return. The same Core login/signing domain was retained. |
| Core recovery | Released `core restart --keep-apps --port 28240 --foreground` changed Core PID 18790 → 39233 and its process-start identity. Active dev retained the exact container ID and StartedAt despite app autostart being false. Data and all source hashes were unchanged. |
| Entry replay | After Core restart, the real agent replayed the original request under Run unprompted. The single enter receipt, operation, backup and app container were retained; no second transition occurred. |
| Return | The agent planned/applied Return under Run unprompted with explicit `acceptDataChanges: true` for the unchanged note schema. Core restored the exact original Docker image and original source override. Newer data and the uncommitted worktree edit remained intact. |
| Harness recovery | A normal Core-managed Harness restart retained the session, its history, workspace and Run unprompted rule. The browser recovered the existing conversation and workspace panel. |
| Return replay | The agent replayed the original completed Return after Harness restart. Receipts, container ID/StartedAt, source hashes, Git HEAD and data hashes were identical before/after replay. |
| Browser final state | Harness showed `returned / docker / running / healthy` and one changed file. The app showed its original heading and both saved notes. |
| Audit | Return audit included request/operation, installation, worktree, source HEAD, manifest/review references and successful outcome through `assistant:hosty.harness`. |

Entry request: `cce90b31-ce87-41e6-b3d9-60a1776895bc`.
Return request: `173c305e-d052-4b07-916f-126b3facd399`.
Only the two successful action receipts remained after both exact replays.

The fixture recompiles its browser bundle on request: this verifies live source plus browser reload,
not push-HMR. Its notes do not contain user foreign keys. The test verifies ordinary-data retention
and unchanged Core identity, not an application-specific user-ID migration.

## Checks, Resources And Limits

- `node --test notes.test.mjs`: one test passed, both during fixture preparation and when run by
  the real agent in its worktree. The test covers persistence and concurrent note saves.
- The agent's `git diff --check` passed; only the intended one-line heading changed.
- SHA-256 comparisons covered every managed-data file, every tracked fixture source file, the
  original source directory and Git HEAD across live edits, restart, Return and replay.
- Release QA used immutable released Core/CLI binaries and published runtime artifacts. The full
  repository build/test suite was not rerun; the linked successful CI and implementation report
  cover it. The fixture's ordinary image and Harness's normal packaged setup were built successfully.

| Resource | Observed memory | CPU at sample | cgroup peak |
| --- | --- | --- | --- |
| Shared worker during entry replay | 597.8 MiB / 4 GiB limit | 2.12% | 643.5 MiB |
| Shared worker during Return | 551.8 MiB / 4 GiB limit | 6.14% | Not captured for that worker generation |
| Development app | 155.2 MiB | 0.20% | 217.0 MiB |
| Restored ordinary app | 55.79 MiB | 0.16% | Not captured |

These are individual samples and per-generation peaks, not a continuous benchmark or a sizing
recommendation. No unrelated resource limits were adjusted. The application had no explicit Docker
memory cap, so Docker displayed the engine's available memory as its denominator.

The app's automatic update checker reported that its synthetic local-only image tag could not be
resolved in a registry. Runtime health stayed healthy and Return restored the recorded local image
exactly; the fixture image was intentionally never published. One read-only guide approval expired
while the operator was handling QA; the agent stopped without editing and resumed after explicit
retry and approval. The initial missing app-context preparation refusal likewise made no changes.

This run covers macOS arm64 with Linux Docker containers and Codex. It does not claim a Claude or
native Windows/Linux run, a child-Core sandbox, multi-service acceptance, or forced interruption in
the middle of Return. Recovery here is process restart plus durable exact replay. Those wider
regression cases remain described in the implementation report; D1 remains deferred.

## Cleanup And Documentation Outcome

The temporary provider connection was removed and Harness returned an empty connection list.
The test app, Harness, Shell and bootstrap Marketplace were removed through their owning Core.
The isolated Core was stopped. The labeled development-cache volume and synthetic QA image were
removed. No fixture-owned container, network or volume remained; no fixture process remained; all
five listeners (28240, 28241, 27701, 20113, 32471) were closed.

The entire disposable root was deleted, including both temporary authorization copies, fixture
source/worktree, app data/backups, caches, downloaded binaries, raw evidence and logs. Preservation
was verified before this explicitly requested test teardown. Published shared Docker images and
unrelated engine caches were left alone. Primary Shell and Workspaces retained their container IDs,
image IDs, StartedAt values and memory limits, and remained running.

Only browser proof screenshots were retained outside the repository. The repository receives this
report and documentation links, with no raw evidence JSON, log archive or experimental patch.
No version change: documentation only.

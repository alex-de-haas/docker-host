# External Workspace Lease Recovery Acceptance

Baseline: `a7f215dd279a199f2f452853ac5b726534fd6921`, 2026-10-18. Verification uses the
uncommitted recovery changes based on that revision. Version outcome: Core/CLI 0.141.3 → 0.141.4;
Harness (including worker) 0.58.1 → 0.58.2. Lifecycle deliverables D4–D5 are verified.

## Behavior And Cause

A durable activity lease has no TTL. It protects a source worktree after an external client exits
without release; a different OAuth principal cannot release the former owner's lease. A pending
Close correctly preserves those files, but the previous Harness UI offered no operator recovery.
Lease age alone cannot distinguish an abandoned marker from an active native writer.

The recovery action requires closed admission, explicit consumer-exit attestation, current HEAD,
same-user administrator/source authority and fresh known-consumer checks. Release and its replay
receipt are saved together. It preserves other leases, unfinished files and the original Close.

## Automated Verification

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --filter 'FullyQualifiedName~LeaseRecovery|FullyQualifiedName~WorkspaceInspection|FullyQualifiedName~WorkspaceWorkflow|FullyQualifiedName~ExternalWorkspaces|FullyQualifiedName~Workspace_Close'`: 37 passed, no failures or skips.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests --filter FullyQualifiedName~WorkspaceInspectionHttpTests --no-restore`: 6 passed after strengthening the member and mixed-authentication checks with the management grant present.
- `npm run harness:test -- web/src/components/workspace-lease-recovery.test.tsx web/src/components/workspace-details.test.tsx src/sessions/development.test.ts`: 28 passed.
- `npm run harness:lint` and `npm run harness:build-web`: passed. The exact source Core project also built successfully through the supported CLI launch; existing warnings remain.
- `node scripts/check-versions.mjs` and `node scripts/docs-index.mjs --check`: passed.

Coverage includes same-request replay across service reconstruction, conflicting replay, selected
lease only, dirty bytes, original Close replay, wrong user/assistant owner, missing confirmation,
open admission, stale HEAD, outstanding operations, sandbox/source-selection/registered-native
consumers, unknown native ownership, missing authority, mixed cookies, and non-administrator users.
UI coverage keeps recovery and Close journals separate, retries uncertain responses, requires fresh
review after a stale-head refusal and prevents duplicate recovery panels after inventory refresh.

## Browser Acceptance

A separate Core data root and Core-managed native Harness run use normal setup/password login,
a test-only external MCP credential and two local Git fixtures. No model-provider credential is
copied. No Docker application or ordinary application data is needed by this supported native UI test.

- Unfinished fixture: Close blocks on its lease; confirmed Recover releases it; retrying the original
  Close succeeds. Complete refuses its untracked file, Delete stays disabled, and Resume reopens it.
  The file remains byte-identical (SHA-256 `b7956ef5fd21383308cee021bfb6f5e84fc7a0f7eaf7b42be6a7f926a2500a36`).
- Merged fixture: its pending Close survives Core/Harness restart and browser reopening. Recover,
  original Close retry, Complete and Delete succeed through Harness. The worktree directory is absent
  and the workflow has successful Close/Complete/Delete receipts. Its local target already contains
  its HEAD; this fixture does not claim a new GitHub PR or real-agent run.
- An initial restart invocation omitted the custom Core port and attempted occupied port 7070.
  The test process refused the bind; the primary Core continued running. Explicit port 38018 and the
  exact project restored the test instance. This invocation mistake is not a product regression claim.
- Browser testing found duplicate React keys between recovery and preview panels. A distinct key
  fixes duplicate recovery sections on refresh, with regression coverage.

The test Harness and Core were stopped through their scoped lifecycle. Their ports 31877 and 38018
have no listeners and no test-root native consumers remain. The disposable root and its credentials
are removed after exporting the human-readable result and the unfinished test sentinel.

## Existing Workspace Audit And Authorized Deployment

PR [#563](https://github.com/alex-de-haas/docker-host/pull/563) is merged. Its worktree was clean and
HEAD `dbe1c3b0d2a61e4cfe301d5e40f8cde750f3c342` was included in the baseline main. Native process,
working-directory and open-file checks found no remaining consumers. The current external principal
did not own its original lease, and the initially installed Core/Harness lacked operator recovery.

After isolated verification the operator explicitly authorized applying the checked Core/Harness
builds with restart while preserving other apps. Core runs the exact registered worktree project via
an isolated Debug generation. System Harness is excluded from ordinary-app unified dev mode, so its
existing reviewed manual update/source workflow points to the same registered worktree; it remains
on the `local` runtime. A pre-update data backup was created. Its shared managed checkout was not edited.

The source guard initially refused the switch while our own activity lease protected the source Core.
The source consumer was stopped, our own lease was released normally, source selection was changed,
and a new lease was acquired before source execution resumed. No foreign lease or ownership metadata
was edited to bypass these checks. A detached CLI launcher session was used to keep the background
Core alive independently of the command tool. The final Core identity is
`79494:639279551976045510`; readiness and exact project/generation were rechecked after browser cleanup.

The normal authenticated Harness browser then recovered only lease
`32378988-23ef-49cc-a30e-c1542887ab6a`. Retry completed the original Close request
`7153a112-cadb-4306-96eb-d046c9d863ad`. Core verified completion; after action-time operator confirmation,
Delete succeeded. The workflow is `deleted`, the worktree is `released`, its directory and working
branch are absent, and successful recovery/cleanup receipts remain. GitHub PR and main are preserved.

The [seven-file audit and preserved draft](2026-10-18-recovered-workspaces-draft.md) records the other
legacy workspace. Six files are represented by merged text/history or stale generated index content;
the missing historical Workspaces draft is preserved in full in that report. All seven original files
remain unchanged and the source workspace is retained until preservation and cleanup are reviewed.
The second remaining active entry is this implementation's worktree, intentionally protected by lease
`4796241a-2f49-4907-a906-f4cda4fa9673` while Core and Harness consume it. Release it only after those
consumers have moved back to published builds or another explicitly approved source.

Shell and Workspaces container IDs remain unchanged. Plans runtime activity changed independently
during the run; no lifecycle request was sent to it. Movie Studio, unrelated app settings and original
source checkouts are untouched. The test environment and its temporary credentials are gone.
Raw evidence, credentials, logs, experimental scripts and build output are excluded from repository changes.

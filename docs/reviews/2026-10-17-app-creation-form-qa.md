# Harness App Creation Form QA — 2026-10-17

## Baseline And Scope

D11 of [Local App Creation From Harness](../features/app-prototype-workspaces/feature.md), on feature
base `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` plus the accumulated uncommitted implementation.
This phase completes the creation form, bounded icon transfer, Git-author/bootstrap consent and
recoverable draft/handoff. The feature still reserves Core/CLI 0.140.0 and Harness 0.57.0; D17/D18
retain final feature-wide verification and documentation closure. No feature commit or PR was made.

## Changes And Findings

- PNG icons are optional, at most 128 KiB and 1024×1024 pixels. Browser decoding previews the file;
  Core validates byte/dimension bounds, signature, complete chunks and checksums before allocation.
  `icon.png` and its `catalogMetadata.icon` reference join the fixed bootstrap and its sole commit.
  Exact bytes reach the worktree. Pending recovery refuses an edited icon; null icon serialization
  preserves fingerprints of earlier icon-free requests.
- Harness's 64 KiB HTTP body cap was too small for icons and for the maximum Unicode prompt.
  Workspace actions now accept 256 KiB and creation dispatch 128 KiB, retaining default limits on
  other routes. The manager's fixed input allowlist and MCP schema carry the bounded icon input.
- The form suggests a valid id while respecting a manually chosen id, fills Git defaults from the
  operator profile without overwriting edits, and explicitly requires one initial-commit consent.
  It explains local-only source and does not change the Git profile or connect/publish a remote.
- Draft parsing validates types and bounds. Drafts include fields, icon, consent and replay id and
  survive closing/reloading. Storage failures are visible and prevent submission before an identity
  can be saved. The current in-memory draft remains editable. Late profile responses cannot change
  an already submitted request. Confirmed refusal unlocks fields; uncertain outcomes retain them.
- Recover is available for an app already created locally when generation has not started. Server
  creation arguments/prompt remain authoritative after storage loss or restart. A provider failure
  preserves the app and workspace; acknowledged dispatch is not undone by browser-storage cleanup.

## Automated Verification

Commands ran in the registered feature worktree:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore
  --filter FullyQualifiedName~AppCreation` — **31 passed**. Includes the Core HTTP authorization
  matrix, actual local Git/worktree creation, selected author, icon byte persistence, replay,
  edited partial bootstrap preservation, invalid/oversized/corrupt/truncated uploads and unchanged
  icon-free fingerprints.
- `npm test --workspace @haas/hosty-harness -- web/src/components/create-app.test.tsx
  src/sessions/development-manager.test.ts src/sessions/development.test.ts` — **48 passed**.
  Covers seven DOM form tests plus durable manager/MCP coordination: complete draft remount and maximum escaped-JSON inputs, explicit
  consent, id validation, delayed Git defaults, failed browser persistence, uncertain-result replay,
  confirmed refusal, server-side recovery and one-time generation dispatch.
- `npm run lint --workspace @haas/hosty-harness-web` and
  `npm run lint --workspace @haas/hosty-harness` — passed.
- `npm run build:web --workspace @haas/hosty-harness` — passed. The final UI-only draft-length adjustment was rechecked by tests, lint and build. Core built with its tests and again
  in a separate managed Debug generation for explicit source launch before live verification.
- `node scripts/docs-index.mjs --fix`, `node scripts/docs-index.mjs --check`,
  `node scripts/check-versions.mjs` and `git diff --check` — passed.

The complete repository suite and release/AOT publication were not repeated for D11; D17 owns
final feature-wide validation. No real model account was copied or invoked. Successful agent
handoff/replay is covered by the deterministic manager tests; prior real Codex/Claude creation
and Docker-preview acceptance remains the separate D16 evidence.

## Live Harness And Browser Verification

A disposable Core used `/private/tmp/hosty-creation-d11-20261017/parent` on port 29370; Harness
was installed/started through its runtime lifecycle on port 30481. Normal bootstrap and password
login were used, followed by normal Core app authentication. Only the operator-approved
`apps.install` optional permission was added to this test Harness.

1. The form suggested `local.d11-notebook`, retained a manually entered Git author/email and
   displayed the selected icon. Create stayed disabled until explicit initial-commit consent.
2. A valid 70,102-byte PNG (93,472 base64 characters, above the former 64 KiB HTTP limit) was selected through
   the browser file chooser. Closing/reloading restored all fields, icon, prompt and consent.
3. Browser Create produced a stopped app and a registered worktree in the same session, visible in
   the existing navigation and workspace detail panel. The canonical source and worktree shared
   bootstrap HEAD `3dc70770`; `icon.png` matched the uploaded bytes, and the commit author was
   `D11 Test Author <d11-author@example.test>`. There was one commit and no remote.
4. With no provider connection in this disposable Harness, generation reported the actionable
   provider-selection error while retaining the created app/workspace and queued prompt. After
   a normal Harness restart, Recover restored the original arguments and icon. Browser retry left
   exactly one creation operation, the same single commit and unchanged icon bytes.
5. A second conversation began with an empty independent draft. Creating with the occupied id
   returned `App or source already exists. Nothing was overwritten.` and unlocked the fields.
   Correcting only the id to `local.d11-corrected` created an icon-free app with the second explicit
   author and one commit. The first app's bytes/HEAD stayed unchanged; neither app had a remote.

The first temporary manifest lacked its monorepo manifest subpath; permission review correctly
refused that fixture. Reinstalling a fixture with the proper source-root/subpath resolved it.
A reload during the deliberate Harness restart briefly reached a disconnected browser page;
reopening after HTTP readiness verified recovery. Neither was treated as successful live evidence
until the normal authenticated page and retained state were visible.

## Cleanup

Harness and Core were stopped through the explicit disposable data root. Both listeners were
closed and no test Core/Harness process remained before the exact root was deleted. Its temporary
operator/password, grants, sessions, app sources, worktrees, runtime cache and logs were removed.
No Docker sandbox was needed for the form check, no model authorization was copied and no primary
Core/app/container settings or caches changed. Screenshots and temporary raw test output stay
outside the repository; no evidence JSON, log archive or experimental patch was added.

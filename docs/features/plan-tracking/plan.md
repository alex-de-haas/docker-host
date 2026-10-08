---
status: Blocked
created: 2026-10-08
updated: 2026-10-08
summary: Open a discussion of a source document with its exact Markdown attached to an assistant draft.
components: [apps/plans, apps/core, packages/app-sdk]
---

# Discuss A Plan With The Assistant

## Goal

The owner requested an action in the document toolbar that opens the assistant and attaches the current file as context. This request authorizes implementation of the following scope.

## Target Behavior

Add **Discuss with Assistant** beside Refresh sources. Use the tracked document by default, the explicitly selected workspace document when selected, or the visible workspace document when no tracked copy exists. Show the chosen version in the action's description. Deleted or unavailable versions cannot be attached.

Use the existing user-attributed provider handoff, including a real Markdown attachment and an editable discussion prompt identifying the repository, branch, path and content fingerprint. Open the returned conversation in a new tab from both standalone Plans and Shell. Do not submit a model turn. Multiple eligible assistants require a selection; missing optional permission offers Core's ordinary app permission review.

Add declared browser UI surfaces to assistant provider discovery so consumers validate destinations without assuming a Harness hostname or API/UI port. Keep ordinary app/source authorization, enforce same-origin mutations, re-read the document through Core, check it matches the displayed content, and preserve handoff identities across retries. Plans declares optional assistant consumption; source reading remains usable without it.

## Deliverables

- [x] D1. Project declared assistant UI destinations in Core provider discovery and the TypeScript SDK, with coverage for separate API/UI endpoints and undeclared providers.
- [x] D2. Implement the authorized Plans handoff route and toolbar action with a full Markdown attachment, explicit version/provider selection, retry identity, loading state and recoverable errors.
- [x] D3. Verify affected tests, builds, lint, versions and documentation; record browser verification and any live-host limitation and update feature documentation.
- [ ] D4. Apply the reviewed Core update and Plans assistant permission, verify an actual attached draft from standalone Plans and Shell, then remove this completed plan and regenerate the index.

## Live Acceptance Blocker

The operator Core at `/Users/haas/.hosty` runs the installed release. The checked-out provider UI
projection is built but not applied to that process. The live Core-managed Plans UI loads this
checkout and exposes the action, but discovery returns `app_permission_required` because Plans
does not yet hold `providers.assistant`. Source reading works. Applying the local Core changes
requires a source restart with the explicit project; the app permission review grants new optional
access. These live changes await operator confirmation. No model turn has been sent.

## Verification Evidence — 2026-10-08

- `npm run plans:test`: 95 passing, including exact Markdown bytes, stale/deleted versions,
  same-origin requests under named localhost and TLS proxies, finalized retries and browser recovery.
- `npm run sdk:test`: 398 passing; `npm run build --workspace @hosty-sdk/app`: passed.
- Core `ProviderHttpTests`: 6 passing; exact Core project build with isolated repository artifacts:
  passed, zero warnings/errors. The test build reports one existing nullable warning in
  `AppUiSurfaceContractTests`.
- Plans lint and `npm run build --workspace @haas/hosty-plans -- --webpack`: passed.
- Live Plans toolbar inspected at desktop width and 375 px: back, discuss and refresh have the same
  top coordinate and 36 px height, with no horizontal overflow. Missing optional permission exposes
  a review link; permission changes, Core restart and live attachment acceptance remain under D4.
- Documentation index, version consistency and whitespace checks pass.

## Verification

- Core provider HTTP tests and Core build; SDK tests and build.
- Plans route tests for authorization, request origin, stale documents, exact attachment bytes, replay and destination constraints; component tests for pending/retry/open behavior.
- Plans lint and production build, responsive browser toolbar inspection when the live source serves this checkout, documentation index and version checks.

---
status: In Progress
created: 2026-10-19
updated: 2026-10-19
summary: Replace recurring workspace Git scans and inspection polling with recoverable filesystem observation and scoped SSE updates.
components: [apps/core, apps/harness, apps/workspaces]
---

# Workspace Event Observation

## Goal

The operator approved this implementation in chat on 2026-10-19 after the active-workspace CPU investigation. A quiet active workspace performs no timer-driven Git scan after initial synchronization. Real changes update Core, Harness and Workspaces promptly, with explicit uncertain state and recovery.

## Target Behavior

Replace the 20-second local observer described in [assistant session workspaces](../assistant-session-workspaces/feature.md) with Core mutation signals, filesystem/Git metadata watchers, coalesced work and cached inspection. Replace Harness and Workspaces inventory/detail polling with authorized SSE hints, shared browser subscriptions and reconnect/visibility resynchronization. Keep remote PR observation independent and propagate its changes through the same inspection stream.

Watch linked-worktree metadata and common repository refs as well as source files. Preserve invalidations during scans and lock contention. Ignore generated-file noise only when it cannot conceal tracked changes. Startup, explicit refresh, watcher faults and root replacement reconcile state. Paused/completed workspaces retain no source watcher; Resume rechecks before reactivation. Delete removes observers and pending work.

Reads revalidate authority before exposing cached data. Resume, Complete, Delete, diff and source mutations retain fresh ownership/path/Git checks. Watcher health replaces timestamp-only local staleness. Stream authorization, buffering, shutdown and missed-event recovery retain current app/user/source boundaries. No repository reset, unrelated workspace edits or unrelated app restart is allowed.

## Deliverables

- [x] D1. Core observation state, event-driven work queue, filesystem/Git watchers and cached inspection replace periodic Git scans, with fresh action checks and recovery tests.
- [x] D2. Scoped inspection SSE and bounded app proxies deliver changes and resynchronize after reconnect, missed events and authority changes.
- [x] D3. Harness and Workspaces consume shared streams, remove healthy polling and show accurate observation health, with frontend coverage.
- [x] D4. Affected builds, tests, AOT and isolated Core-managed integration checks pass; feature documentation, versions and index reflect verified behavior.
- [ ] D5. Apply the verified changes through supported lifecycle controls, preserve other work and apps, compare CPU under matching conditions, export evidence and finish disposable test resources.

## Verification

Exercise quiet worktrees, external edits, atomic replace/rename/delete, staging/commit, shared target refs, burst coalescing, dirty events during scanning, owner-lock contention, watcher failure/root replacement and Core restart. Verify cached detail invalidation, unchanged-write avoidance, fresh action checks, pause/resume/delete and permission revocation. Exercise SSE shutdown, disconnect/reconnect, visibility restoration and queue overflow with multiple UI subscribers. Verify authenticated Shell embedding and both client views in an isolated sandbox. Compare Core CPU and actual observation activity with an unchanged workload and matching launch mode; disclose any remaining comparison limits.

## Version Outcome

Platform 0.143.0 → 0.144.0; Harness 0.59.0 → 0.60.0; Workspaces 0.4.0 → 0.5.0. Final versions are checked against the repository before publication.

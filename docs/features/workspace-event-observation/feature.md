---
created: 2026-10-19
updated: 2026-10-19
summary: Core observes workspace changes through filesystem and mutation events, while Harness and Workspaces share authorized SSE updates.
components: [apps/core, apps/harness, apps/workspaces]
---

# Workspace Event Observation

## Local Observation

Core watches active worktree files, linked-worktree Git metadata and common repository refs.
Core record/workflow mutations reconcile registrations. Startup performs an initial observation;
quiet healthy worktrees have no timer-driven Git scan. Paused and completed workspaces have no
source watcher. Resume performs fresh checks and restores observation; successful Delete removes
registrations, pending work and retained metadata.

Filesystem hints coalesce for 200 ms. A bounded path set collapses large bursts to their common
subtree. Git ignore rules suppress generated-file noise only after checking that an ignored
directory contains no tracked files. Index/ref and ignore-rule changes invalidate that filter.
Objects, reflogs and transient lock-file writes do not themselves invalidate source. Git inspection
disables optional index writes, preventing an observation from triggering its own next scan.

Generations retain changes arriving during a scan or owner-lock contention. Watcher errors and
missing/replaced roots expose `recovering`; reattachment triggers fresh reconciliation. A 15-second
health check reads directory metadata and retries failed registrations, without walking healthy Git
worktrees. Restart starts a new observation generation and discovers changes made while Core was
stopped. Inaccessible source remains unavailable, never a fabricated clean snapshot.
Linux health checks compare device/inode identity rather than synthesized creation timestamps,
so ordinary directory writes do not trigger recovery scans.

## Inspection And Authority

Inventory reads retained observations. Worktree detail reads reuse cached commits, original-base
file changes and line statistics until the observed source/generation changes. Identical observations
preserve timestamps and do not rewrite records. Consumer and recorded PR facts remain independently
refreshed. Cache reads revalidate current source authority before and after inspection; cached data
does not grant access. Manual detail refresh accepts `refresh=true`.

Resume, Complete, Delete, source mutations and file diff requests keep their fresh ownership,
path and Git checks. Local observation never fetches remote Git. The separate provider PR observer
continues its existing schedule and signals changes to the same UI stream.

## Delivery And Recovery

`GET /api/internal/apps/{appId}/workspace-inspection/events` requires the calling installation's
service token, current administrator app identity and `apps.workspaces.read` grant. It subscribes
before the initial authorized snapshot. Events are `stream.ready`, `workspace.changed`,
`stream.ping` and `stream.revoked`; hints contain no source or workspace IDs. Only authorized
worktree changes, authority/inventory changes or a dropped-event resync reach the client.
Each snapshot request independently checks authorization. Stream batches and 20-second keep-alives
revalidate authority, and Core shutdown cancels streams. Keep-alives do not request a UI snapshot.

Harness and Workspaces proxy the bounded inspection route with server-held service credentials.
Within each app/tab, consumers share one authenticated fetch stream. Hints debounce into
single-flight reads; another hint during a read retains a follow-up. Failed snapshot reads retry
with bounded backoff even when the stream stays healthy and no new workspace event arrives. Disconnect clears source data,
retries with bounded backoff and resynchronizes on `stream.ready`. Visibility restoration and
page restoration reopen the stream; a silent connection times out after 45 seconds. Unmounting the
last consumer releases the connection and listeners. PR-only hints do not reread an unchanged diff.
Clients connected to an older Core without the stream use entry/manual/visibility reads. A 30-second
capability probe upgrades the connection to SSE when available; it does not reload Git snapshots.
Resource samples and app-update checks do not invalidate workspace inspection.
The local freshness label reports watcher health instead of declaring a quiet worktree stale merely
because its observation timestamp is old. Remote PR freshness remains separately timestamped.

## Native Harness Verification

`HOSTY_HARNESS_WEB_OUTPUT` selects the static export directory relative to `apps/harness/web`
for both build and runtime. Its default is `out-build`. A native test instance can use, for example,
`build/event-observation`, without replacing the export served by a running ordinary Harness.
This does not change app identity, source selection or runtime authority.

## Testing Expectations

- Quiet observation and repeated detail reads perform no scan or record rewrite.
- External writes, atomic replacement, rename/delete, staging, commits and target refs invalidate
  the correct worktree; ignored bursts cannot conceal tracked changes.
- Busy owner locks, events during scans, missing roots, watcher failure and restart retain recovery.
- Pause stops observation, Resume is fresh, and Complete/Delete retain safety checks.
- Streams enforce app/user/source authority, recover dropped events and close on shutdown/revocation.
- Multiple UI consumers share a stream and handle reconnect, hidden pages, silent transport and
  in-flight invalidations without retaining unauthorized source.
- Native/Docker builds and isolated Core-managed previews verify the actual app paths; CPU comparisons
  record launch mode, workload and observation activity alongside the numeric result.

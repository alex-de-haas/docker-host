---
created: 2026-10-19
updated: 2026-10-27
summary: Core observes workspace changes through filesystem and mutation events, while Harness consumes authorized SSE updates.
components: [apps/core, apps/harness]
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

Inventory reads retained observations. Parsed workspace, name, workflow and participation records
share a bounded cache (512 entries, 16 MiB weighted budget). On Linux and macOS each read checks
native device/inode identity, size and nanosecond mtime/ctime; atomic replacement, deletion and
same-size edits with restored mtime invalidate the parsed value. Unsupported platforms and files
retain uncached reads. Errors and missing records never become cached authorization. Inventory
operations resolve the development root once within that read, without retaining resolved paths
across requests. Source grants, membership and lifecycle admission remain current checks.

Documents workspace inventories reuse document-change summaries only for a healthy, settled
observation generation and the same tracked target commit. Concurrent readers share the scan;
source/target changes invalidate it. Documentation filesystem hints also invalidate summaries for
ignored Markdown without forcing a Git scan for an ignored file. Paused, recovering and unobserved
worktrees retain fresh checks, and direct content reads and mutations keep their path/Git validation. Each authorized
repository resolves its current target once per response rather than once per worktree. Summary
reuse does not skip current source authorization before and after inspection. Publication writes
advance a separate UI revision, so Harness refreshes PR check, review and merge facts without
invalidating the retained Git inspection or scheduling another source scan.

Worktree detail reads reuse cached commits, original-base
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

Harness proxies the bounded inspection route with server-held service credentials.
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

## Verified Rollout

The 2026-10-19 live trial verifies platform 0.144.0, native Harness 0.60.0 and Docker Workspaces
0.5.0. Core restarts preserve the four running apps; the Harness update creates a pre-update
backup, and its published worker image remains available through the normal install control.
Workspaces has no app-owned persistent data. Unrelated worktrees remain available throughout.

The isolated Core-managed sandbox verifies normal password login, Shell embedding, both SSE
proxies, file updates without Refresh, quiet observation and recovery of edits made while Core is
stopped. Its owner finishes the sandbox and resource removal is verified. After the live rollout,
both clients also reflect a temporary file's creation and removal without Refresh.

A 90-second macOS comparison uses the same Debug launch mode, six active worktrees and Core's
own process CPU counters (100% is one logical CPU). Mean CPU is 17.83% before and 6.49% after;
the peak over one-second intervals is 85.72% before and 30.62% after. Workspace record writes
fall from 41 (39 without HEAD/source changes) to one real source change. This is an observation
of an active host with concurrent work, not an isolated benchmark or a CPU guarantee.

Local verification passes 180 Core workspace tests, 850 Harness tests and 38 Workspaces tests.
Native AOT passes on macOS ARM64. CI also runs the full Core suite and Linux x64 Native AOT;
real Docker network checks use `npm run test:integration -- transport` locally; four opt-in integrations are excluded from its default suite.
The published clients have regression coverage for legacy-Core compatibility, failed snapshot
retries and rejected-stream cleanup.
Harness 0.60.1 and Workspaces 0.5.1 include the subsequent browser response cleanup.
Core 0.144.2 retains failed scans for a delayed retry and treats failed ignore filtering as a
source invalidation. Collapsed batches use a marker that cannot collide with literal filenames.\nHealthy idle sources remain unscanned; fresh actions bypass the retry delay.
Both browser clients and server proxies cancel rejected response bodies before retrying; a
cancellation failure does not suppress stream recovery or older-Core compatibility.

## Testing Expectations

- Quiet observation and repeated detail reads perform no scan or record rewrite.
- Workspace record reuse remains bounded and detects rename, replacement, deletion, corruption,
  ownership/membership changes and same-size edits with restored mtime.
- Repeated settled Documents inventories share their Git/document scan; local edits, target advances
  and unavailable observation invalidate it, while current access checks remain in force.
- External writes, atomic replacement, rename/delete, staging, commits and target refs invalidate
  the correct worktree; ignored bursts cannot conceal tracked changes.
- Busy owner locks, events during scans, missing roots, watcher failure and restart retain recovery.
- A relevance-filter failure retains a single file hint. Readiness assertions observe both the persisted
  change and completed observation health; a saved snapshot alone does not acknowledge its generation.
- Pause stops observation, Resume is fresh, and Complete/Delete retain safety checks.
- Streams enforce app/user/source authority, recover dropped events and close on shutdown/revocation.
- Multiple UI consumers share a stream and handle reconnect, hidden pages, silent transport and
  in-flight invalidations without retaining unauthorized source.
- Native/Docker builds and isolated Core-managed previews verify the actual app paths; CPU comparisons
  record launch mode, workload and observation activity alongside the numeric result.

---
created: 2026-09-25
updated: 2026-10-16
summary: One Core resource sampler for containers, local process trees and Core itself, shared by Dashboard and Telemetry.
components: [apps/core, apps/shell, apps/telemetry-ui]
---

# Unified runtime resource usage

Core owns one resource sampler for Docker containers, Local Command service process trees, and
Core itself. Dashboard and Telemetry consume the same observations. Dashboard needs no Telemetry
installation, no application instrumentation, and no database. Telemetry's existing SQLite
retention remains unchanged; no new persistence is introduced in Core or Shell.

## Acquisition and ownership

`RuntimeResourceSampler` samples local processes approximately every three seconds while a visible
Dashboard holds an authorized `resources` subscription on the shared Core event stream. Generic
admin/notification subscriptions create no resource demand. Disconnect, topic removal, revoked
access and shutdown release demand; closing one of several viewers leaves the others active.
Legacy HTTP clients retain a 20-second renewable lease. Stream-mode history reads do not renew it.
Without a viewer, a running Telemetry app keeps the sampler active at ten seconds. With neither
consumer, acquisition stops. Multiple browser clients share the producer. Docker acquisition stays
at ten seconds, with an eight-second deadline; a slow Docker probe can delay a local tick within that bound.

A failed Docker acquisition preserves the last successful snapshot and its original observation
timestamps. Only observations at most 20 seconds old are included in subsequent frames or exported
to Telemetry; repeated failures cannot refresh their age. A successful empty snapshot clears the
cache immediately. Removed and confirmed stopped apps still follow normal reconciliation.
Timeouts, unavailable Docker commands, and nonzero CLI exits are logged at Warning with elapsed
time and bounded command diagnostics. Repeated failures produce at most one warning per minute;
the next successful acquisition logs recovery at Information.

`LocalResourceReader` uses the runtime adapter's registered service roots, including roots adopted
after a Core restart with `--keep-apps`. It enumerates PID/parent/group ownership once per tick using
numeric `ps` output on macOS/Linux and Toolhelp on Windows, then reads cumulative CPU time and
working set from each owned process. Descendants and POSIX process-group members are included;
shared PIDs are never charged twice. Root start identities and per-process start times protect
against PID reuse. Core's own process is reported separately as `hosty.core` / `core`.

CPU is the delta of cumulative processor time divided by monotonic elapsed time: 100% means one
logical core, so parallel work can exceed 100%. New/reused processes need a warm-up interval.
RAM sums working sets and can count shared pages more than once; it is not unique physical memory.
Processes that both start and exit between samples are not measured. Windows ancestry tracking
cannot retain detached children after their parent relationship disappears. These are sampled
indicators, not CPU accounting or resource enforcement.

Docker ownership still uses Hosty instance/app/service labels and the existing bounded owner-map
cache. The existing Docker CPU and memory semantics are preserved. During runtime switches the
freshest observation wins per app/service. Removed apps disappear; confirmed stopped apps have
zero readings for each service declared by the selected reviewed manifest, even after health
state is cleared by Stop. Starting, stopping and partially unavailable apps retain measured services, with
unknown placeholders for expected services without samples. Unknown data is never presented as
zero or silently omitted from a total.

## History and delivery

Core retains at most 110 frames and five minutes of history in RAM. `GET /api/core/resources`
requires an administrator session and returns `runId`, `now`, `logicalProcessors`, `sequence` and
`history`. Each history frame has its own `sequence`. Sequence numbers count resource frames only;
they reset with a new sampler run. `after` plus `runId` requests newer frames for legacy clients;
a different run returns the retained snapshot. `stream=true` reads history without renewing the
legacy sampling lease.

Dashboard requests `GET /api/events?topics=resources` through Shell's existing authenticated BFF.
Core acknowledges the topic with `event: stream.ready` and `data: {"resources":1}` before delivering
`resources.sample` events. Each sample contains `runId`, `sequence`, `timestamp`,
`logicalProcessors` and `frame` (timestamp, sequence and service measurements). Resources require
administrator authority. The delegated event route requires `core.read`, `apps.read` and
`apps.notifications`, covering the resource HTTP route's read permissions. Current session/grant
and role checks precede delivery; a role change or lost authority ends the stream. Revalidating an
open stream does not renew its Core session idle window.

Shell subscribes before reading history once, then applies each sample directly without a GET.
The shared connection recomputes topics when consumers mount, unmount or change visibility.
Hidden Dashboards cancel pending synchronization and release resource interest while unrelated
subscribers retain their state. Returning to Dashboard, reconnecting, or restoring a page from the
back/forward cache subscribes and reconciles the retained history once.

The resource consumer buffers up to 128 samples during HTTP synchronization, merges by run and
sequence, and ignores duplicate frames. Sequence gaps, buffer overflow and changed run identity
coalesce into recovery reads of the full bounded window. Late responses from cancelled requests or
an older observed run cannot replace newer state. History reads have a 15-second deadline. Failed
recovery stays stale and retries with 1/3/10/30-second delays capped at 30 seconds; incoming samples
cannot bypass that backoff. Stream errors cancel resource work until reconnect. A stream left closed by a proxy HTTP error is reopened
with the same capped backoff; browser-native reconnect handles transient interruptions. Domain-event
silence only expires a local freshness deadline; it never starts polling. Missing or over-20-second-old data is unavailable, while retained
charts remain historical.

For independent Core/Shell upgrades, Core retains `resources.changed` hints and legacy GET leases.
A new Shell waits for the capability acknowledgement before selecting direct delivery. An open
stream with no acknowledgement after two seconds uses the older hint/GET path and its ten-second
lease renewal; network errors do not select this fallback. A later acknowledgement or reconnect to
supported Core cancels compatibility polling. The server's 20-second SSE heartbeat remains separate
from resource acquisition and HTTP synchronization.

The existing service-token-protected `/api/internal/telemetry/metrics` endpoint exposes the shared
snapshot as Prometheus text: `container.cpu.percent`, `container.memory.bytes`,
`container.memory.percent`, `process.cpu.percent`, and `process.memory.bytes`. The Telemetry backend
scrapes Core directly alongside its collector target. No duplicate process sampling or OTLP push is
added. Telemetry pins both infrastructure families and offers Core in the Metrics resource filter.

## Dashboard

App rows show a CPU value and sparkline plus a RAM value beside status unless the app is confirmed
stopped. Stopped apps leave the resource cell empty, preserving column alignment without a resource
button or historical popover. Expanded services also hide resources when the app is stopped or the
service is stopped or exited. Starting, stopping and unknown app states retain the resource display;
running services in partially unavailable apps keep their readings. Core and the all-app total remain
visible, and resource sampling and history retention are independent of these display rules.

Expanded service headers keep the service name and runtime badges on the left, with the stacked CPU/RAM block
beside the health and runtime statuses on the right. A thin horizontal separator divides adjacent
service sections. These per-service totals include all owned
child processes. The apps Frame header shows the
all-app total, excluding Core, aligned above the per-app resource column, while Core has its own resource cell. Clicking any cell opens
CPU/RAM history and recent average CPU in a popover using ReUI Frame and the shadcn Chart/Popover
primitives recommended by the ReUI registry. Frame owns the single outer border; the popover
wrapper has no border and matches Frame's corner radius, retaining an opaque backdrop.

CPU graphs share a scale of at least 100%, rounded up to the next 100% from retained fleet/Core
peaks. RAM is numeric in rows and charted in the popover. A subtle activity dot requires at least
ten baseline points and three consecutive readings above twice that baseline, at least ten percent
CPU, and at least five percentage points above baseline. The resource button includes this hint
in its accessible name; the visual dot is decorative. It is an activity hint, not an error.
Responsive rows retain values and actions without horizontal scrolling.

## Testing Expectations

- Docker acquisition covers success, deadline cancellation, preservation of fresh observations,
  expiry without timestamp renewal, recovery, successful empty results, command failures, host
  shutdown cancellation, and warning throttling. Telemetry also excludes expired cached readings
  while the next acquisition is in progress.
- Process-tree ownership includes descendants/reparented POSIX group members and excludes unrelated
  trees; CPU deltas cover multi-core usage, first samples, PID reuse and counter resets.
- History expires and stays bounded, incremental reads work, and a changed run ID resynchronizes.
- API/topic access rejects anonymous and non-admin sessions; delegated grants require both read
  permissions and are rechecked before payload delivery. Revocation, role change, session expiry,
  disconnect and shutdown release demand. Open streams do not renew the Core session idle window.
  Telemetry retains its service-token checks.
- Resource sequences survive unrelated events and expose bounded-queue drops. Generic streams do
  not activate sampling; multiple viewers share demand; stream reads do not extend legacy leases.
- Shell transport tests cover two minutes without polling, initial HTTP/SSE overlap, duplicates,
  gaps, bounded-buffer overflow, Core restart, cancellation, recovery backoff, visibility/page
  restoration, shared viewers, stale deadlines and both Core/Shell upgrade orders.
- Transitional and partial app states preserve observed load and mark missing services unknown;
  confirmed stopped apps have zero load.
- Shell tests cover per-service/app/fleet sums, Core exclusion, unavailable/stale values, history
  merging, common CPU scaling and sustained-activity thresholds.
- Dashboard verification covers empty resource cells for stopped apps and hidden resource controls
  for stopped/exited services, including retained samples; active and transitional apps, Core and
  fleet totals retain their displays.
- Build Core, Shell and Telemetry; run their affected tests. Live macOS verification covers source
  Core restart/adoption, local and Docker values, SSE changes, service totals, chart popovers,
  narrow Dashboard containers, and arrival of the same metrics in Telemetry. Windows/Linux native
  acquisition requires platform-specific CI/live verification; it is not exercised by macOS UI QA.

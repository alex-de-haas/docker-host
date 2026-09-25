Created: 2026-09-25
Updated: 2026-09-25

# Unified runtime resource usage

Core owns one resource sampler for Docker containers, Local Command service process trees, and
Core itself. Dashboard and Telemetry consume the same observations. Dashboard needs no Telemetry
installation, no application instrumentation, and no database. Telemetry's existing SQLite
retention remains unchanged; no new persistence is introduced in Core or Shell.

## Acquisition and ownership

`RuntimeResourceSampler` samples local processes approximately every three seconds while a visible
Dashboard holds a 20-second renewable lease. Without a viewer, a running Telemetry app keeps the
sampler active at ten seconds. With neither consumer, acquisition stops. Multiple browser clients
share the producer. Docker acquisition stays at ten seconds, with a four-second deadline; a slow
Docker probe can delay a local tick within that bound.

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
requires an administrator session and returns run identity, current time, logical CPU count, and
timestamped service frames. `after` plus `runId` requests only newer frames; a different Core run
returns the retained snapshot so the client drops its previous history.

The existing authenticated event stream publishes `resources.changed` hints while viewed. Shell
subscribes through the shared EventSource, resyncs on reconnect/visibility, and uses a ten-second
fallback request to renew the lease and recover from missed hints. Hidden Dashboards skip requests;
closing the last one expires the active cadence. Responses and browser history are bounded alike.
Missing or over-20-second-old data is shown as unavailable, with historical charts distinguished
from current readings.

The existing service-token-protected `/api/internal/telemetry/metrics` endpoint exposes the shared
snapshot as Prometheus text: `container.cpu.percent`, `container.memory.bytes`,
`container.memory.percent`, `process.cpu.percent`, and `process.memory.bytes`. The Telemetry backend
scrapes Core directly alongside its collector target. No duplicate process sampling or OTLP push is
added. Telemetry pins both infrastructure families and offers Core in the Metrics resource filter.

## Dashboard

App rows show a CPU value and sparkline plus a RAM value beside status. Expanded service headers
keep the service name and runtime badges on the left, with the unchanged stacked CPU/RAM block
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

- Process-tree ownership includes descendants/reparented POSIX group members and excludes unrelated
  trees; CPU deltas cover multi-core usage, first samples, PID reuse and counter resets.
- History expires and stays bounded, incremental reads work, and a changed run ID resynchronizes.
- API access rejects anonymous and non-admin sessions; telemetry retains its service-token checks.
- Transitional and partial app states preserve observed load and mark missing services unknown;
  confirmed stopped apps have zero load.
- Shell tests cover per-service/app/fleet sums, Core exclusion, unavailable/stale values, history
  merging, common CPU scaling and sustained-activity thresholds.
- Build Core, Shell and Telemetry; run their affected tests. Live macOS verification covers source
  Core restart/adoption, local and Docker values, SSE changes, service totals, chart popovers,
  narrow Dashboard containers, and arrival of the same metrics in Telemetry. Windows/Linux native
  acquisition requires platform-specific CI/live verification; it is not exercised by macOS UI QA.

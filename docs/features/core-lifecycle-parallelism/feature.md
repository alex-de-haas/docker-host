# Core Lifecycle Parallelism

Created: 2026-08-26
Updated: 2026-09-21

Core does its per-app lifecycle work concurrently and asks docker in batches, so boot latency and
steady-state process churn stop scaling with the number of installed apps. Implements findings H4 and
M1 of the 2026-08-25 Core performance review, since superseded; see
[the consolidated review](../../reviews/2026-09-06-consolidated-review.md#superseded-reviews).

## Autostart runs a priority tier at a time, concurrently within it

`CoreLifecycleService.StartAutostartAppsAsync` groups autostart apps by
`PlatformCapabilities.StartPriority` and runs the capability tiers **strictly in sequence**.
Within each tier, apps start **concurrently**, at most `MaxConcurrentAutostarts` (4) at a time.
The queue places system apps first, then ordinary apps, with each category sorted by ordinal
app id. System priority follows the installed role, independent of app id or install origin,
and does not override a disabled autostart setting. Already-adopted live local processes are
excluded from autostart.

System role is a queue preference, not a completion barrier. Shell gets an early start opportunity,
but ordinary apps do not wait for every system app to become ready. In particular, AI Gateway's
local-command setup (`npm install` and web build) occupies one slot while unrelated Docker apps
use the others. Each completed or failed start immediately frees a slot for the next queued app;
there is no wait for a fixed batch to finish. Docker and local-command starts share the same limit.

The capability-tier boundary remains a completion barrier: the telemetry collector is the OTLP
sink other apps point at, so its endpoint URL must be resolved and persisted before a lower tier's
start-time environment injection reads it ([observability](../observability/feature.md)).
The collector therefore finishes starting before Shell and ordinary apps. Within a tier, each
start holds only its own app's operation lock, the port allocator serializes on its own gate, and
expected failures are captured per app by `RunBackgroundLifecycleActionAsync` without blocking
other starts. Concurrency is bounded because simultaneous image pulls compete for bandwidth.

Reported results follow capability priority, system preference, then app id, regardless of
completion order. `Task.WhenAll` waits for every submitted task even when one faults. Cancellation
prevents queued starts from proceeding and waits for active lifecycle operations to settle, so
no detached start outlives boot cancellation. Stops also run concurrently (`StopRuntimeAppsAsync`).

The limit covers each complete lifecycle start, including preparation and readiness. Four stalled
starts can still fill every slot, and a stalled capability provider holds its tier barrier. The
supervisor begins periodic health observation only after all autostarts finish. The readiness
budget does not limit setup commands or image pulls.

**Cross-app dependency order is still not honoured.** Declared dependencies do not gate this
queue, and system queue preference does not guarantee that a system provider is ready before an
ordinary consumer. Dependency URL injection reads the provider's persisted record, not its
running state. Dependency-aware scheduling and the `waiting` state are tracked in
[dependency-ordered-autostart](../dependency-ordered-autostart/plan.md).

## Supervision observes apps concurrently and inspects containers in batches

`ObserveRuntimeHealthAsync` fans its per-app observations out with a bounded `Task.WhenAll`
(`MaxConcurrentObservations`, 8). Each observation is an independent probe writing only its own record
under its own lock; serially the tick's duration was the sum of them, so one app with a slow
healthcheck pushed every other app's observation past the next tick. `Task.WhenAll` preserves
submission order, so observations stay in record order for the supervisor's transition bookkeeping.

`DockerRuntimeAdapter.GetHealthAsync` inspects **all** of an app's service containers in one
`docker inspect` call instead of one call per service, and resolves image repo digests in one more
call for the ids it has not already seen. Two details make the batch safe:

- The container format leads with `{{.Name}}` and the image format with `{{.Id}}`, so every line
  identifies itself. docker prints a line only for the objects that exist and reports the rest on
  stderr, so position could not be trusted to map a line back to the name that produced it.
- The batch's **exit code is ignored**. A call naming one absent container exits non-zero while still
  printing good lines for the containers that do exist, and absence *is* the "stopped" answer — so
  what matters is which names came back, not the status of the call as a whole.

Image ids are cached for the process lifetime (`imageRepoDigests`). An image id is the digest of that
image's own config, so the content it names never changes; only re-tagging identical content under
another repository could add an entry, which does not change what the container is running. Failures
are deliberately **not** cached — an image built locally has no repo digest at all, and re-asking
costs nothing now that the lookup is batched.

Together this takes a believed-running app from `2 × services` docker spawns per 15-second tick to one
(two the first time an image is seen), which is what made steady-state process churn scale with
container count for a reading that is usually unchanged.

## Testing Expectations

- `CoreLifecycleServiceTests`: two apps in one tier are in flight at the same time; a capability
  provider finishes before lower-priority system or ordinary apps start. A held system local-command
  start does not prevent more than four ordinary Docker apps from finishing, demonstrating queue
  refill. System apps take queued slots before ordinary apps regardless of id, and no more than four
  starts are active. Disabled apps remain stopped, adopted local processes are skipped, and a failed
  system start is reported independently. Results follow capability priority, system preference,
  then app id. Cancellation awaits active cleanup and does not launch queued apps.
- `DockerRuntimeAdapterTests`: a multi-service app's health costs exactly one container inspect; a
  container missing from the batch reads `stopped` while its siblings' lines still parse (the
  non-zero exit must not discard them); an image's repo digest is resolved once and served from cache
  on the next call.
- The fake runtime adapter's start/stop counters are `Interlocked`, since autostart now increments
  them from several threads at once.

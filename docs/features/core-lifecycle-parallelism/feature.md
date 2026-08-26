# Core Lifecycle Parallelism

Created: 2026-08-26
Updated: 2026-08-26

Core does its per-app lifecycle work concurrently and asks docker in batches, so boot latency and
steady-state process churn stop scaling with the number of installed apps. Implements findings H4 and
M1 of the [2026-08-25 Core performance review](../../reviews/2026-08-25-core-performance-review.md).

## Autostart runs a priority tier at a time, concurrently within it

`CoreLifecycleService.StartAutostartAppsAsync` groups autostart apps by
`PlatformCapabilities.StartPriority` and runs the tiers **strictly in sequence**, with the apps inside
one tier running **concurrently**, at most `MaxConcurrentAutostarts` (4) at a time.

The tier boundary is a barrier, not a sort key, and that is the load-bearing part: the telemetry
collector is the OTLP sink other apps point at, so its endpoint URL must be resolved and persisted
before a lower tier's start-time env injection reads it
([observability](../observability/feature.md)). Nothing inside a tier needs that treatment — each
start holds only its own app's operation lock, the port allocator serializes on its own gate, and
every failure is captured per app by `RunBackgroundLifecycleActionAsync` — so serializing them only
made boot cost the *sum* of every app's start, where one slow image pull delayed every app behind it.
Concurrency is bounded rather than unlimited because a start can pull: twenty simultaneous
`docker pull`s starve each other of bandwidth and finish later than a smaller batch would.

Submission order inside a tier stays alphabetical by app id, and `Task.WhenAll` preserves it, so the
reported result order — what the boot log prints — is unchanged. `Task.WhenAll` also waits for every
task even when one faults, so a boot cancelled midway never leaves a start running detached against a
Core that is already tearing down. Stops were parallelized earlier for the same reasons
(`StopRuntimeAppsAsync`).

**Cross-app dependency order is still not honoured**, and this changes how that shows up. Autostart
has never consulted the dependency graph: a consumer whose id sorted before its provider already
started first and came up against an address nothing was listening on yet. What is gone is the
alphabetical accident that ordered *some* pairs correctly by luck — within a tier both now start
together. Nothing regresses for a pair that was already unlucky, and dependency URL injection itself
is unaffected (it reads the provider's persisted record, not its running state). The real fix is
[dependency-ordered-autostart](../dependency-ordered-autostart/plan.md)'s `waiting` state.

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

- `CoreLifecycleServiceTests`: two apps in one tier are in flight at the same time (a rendezvous both
  starts must reach before either finishes — unsatisfiable if they run serially); a capability
  provider's start *finishes* before the next tier's app starts; autostart still reports its results
  in alphabetical submission order.
- `DockerRuntimeAdapterTests`: a multi-service app's health costs exactly one container inspect; a
  container missing from the batch reads `stopped` while its siblings' lines still parse (the
  non-zero exit must not discard them); an image's repo digest is resolved once and served from cache
  on the next call.
- The fake runtime adapter's start/stop counters are `Interlocked`, since autostart now increments
  them from several threads at once.

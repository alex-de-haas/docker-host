# App Lifecycle States — Intermediate `starting` And `stopping`

Created: 2026-07-28
Updated: 2026-07-28

An installed app's `runtimeState` reports whether a lifecycle verb is in flight, not only where it
ended up. A start that pulls an image, resolves a source checkout, or waits out a lingering host port
reads `starting` for its whole duration, and every client sees it — not just the tab that clicked.

## Vocabulary

| State | Meaning |
| --- | --- |
| `running` | Up and serving traffic. |
| `starting` | A start is in flight. Nothing is listening yet. |
| `stopping` | A stop is in flight. The runtime may still hold its ports. |
| `stopped` | Down, with nothing operating on it. |
| `unknown` | Observed but not classifiable — a partial multi-service outage, a failed stop, or a state left behind by a Core that died mid-verb. |

`starting` and `stopping` are **non-terminal**: they mean an operation is running right now, inside
this Core process, holding that app's operation lock. Nothing else may be inferred from them.

A restart reports its two halves — `stopping`, then `starting` — rather than a single `restarting`.
Both are `IsBusy`, so clients behave identically either way, and the operator gets to see which half
is slow.

## Three predicates, not one boolean

Every call site used to ask its question as `== "running"` or `!= "running"`. Those are three
different questions that only coincided while the vocabulary was binary, so `AppRuntimeStates`
(`apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs`) names them, and
`apps/shell/src/app/shell/runtime-states.ts` mirrors them:

| Predicate | Question | Members |
| --- | --- | --- |
| `IsUp` | may traffic reach it? | `running` |
| `IsBusy` | is a verb mid-flight, so keep hands off? | `starting`, `stopping` |
| `IsIdle` | is it safe to do something destructive? | `stopped` |

**`IsIdle` is not `!IsUp`.** That is the whole reason the type exists. A gate meaning "only when
nothing is happening" — restoring a backup over the app's data directory, say — silently widens to
admit an app that is still shutting down if it is written as the negation of `IsUp`. Backup restore
uses `IsIdle` on both sides (Core answers `app_must_be_stopped`; the Shell disables the button).

One site deliberately keeps `IsUp` where `IsBusy` looks like it belongs:
`FindUnavailableLoopbackAssignments` exempts a running app from the port-conflict preflight so its own
bound ports are not reported as stolen. An app mid-`starting` has bound nothing yet — that preflight
runs *before* the adapter starts — so exempting it would only blind genuine cold-start conflict
detection and turn the structured `runtime_port_unavailable` error back into a generic bind failure.

That exemption is passed to the preflight as an explicit argument, captured **before** the verb stamps
`starting`, rather than re-read from the record. Stamping destroys the evidence: an app whose runtime
is already up — a Core restart that kept its containers, or a repeated start — would otherwise have its
own reserved ports flagged as conflicts and fail its own autostart.

## Where the state is written

Stamped at the **head** of the verb, before the slow preamble, not just before the adapter call: the
port-release wait (up to 15s after this app's own stop), the source checkout, mount preparation,
capability provisioning and the image pull are all part of what the operator is waiting through.

The registry write choke point already publishes `app.changed`
([core-event-bus](../core-event-bus/feature.md)), so every transition reaches connected clients with
no new transport. The Shell has no app-state polling at all; it re-reads on the event.

A stop that throws records `unknown`, never `stopping`. Stop needed no failure path before these
states existed — a throw simply left the record on its previous value — but a stranded `stopping`
would be permanent, because no reconciler observes a non-`IsUp` record.

**Cancellation settles too.** A client disconnect or host shutdown after the stamp abandons the verb
and releases the lock, which would leave the same permanent stamp. All three verbs catch
`OperationCanceledException` and settle the record to `unknown` on a token of their own — the
request's is already cancelled — before rethrowing. A record that is no longer transitional (the verb
committed just before cancellation landed) is left untouched.

## Recovery

A Core process that dies mid-verb leaves a non-terminal state that nothing downstream would ever
correct: the summary reconcile, the supervisor's observation filter and the health mapper all only
look at `IsUp` records, so a stranded app would sit `starting` forever *and* fall out of supervision.

`RecoverStrandedLifecycleStatesAsync` runs at boot, before autostart reconciliation, and resets every
`IsBusy` record to `unknown` — honest, because what the dead process left behind is exactly what is
not known. From there the normal machinery settles it: the docker sweep raises it to `running` when it
finds a live labelled container, and autostart starts what should be up. The sweep takes each app's
operation lock non-blockingly and skips anything a live verb is holding, so it can never stamp over an
operation that is legitimately in flight.

## The `starting` name is overloaded, deliberately

Container health has its own `starting` (`SummarizeHealthStatus`), meaning "container up, HEALTHCHECK
not passed yet" — close to the opposite of the app-level `starting` ("no container yet"). They were
left sharing the name because they never reach the same cell: container health seeds a per-**service**
row and wins there (`health?.status || app.runtimeState`), while the app-level value renders in the
**app** row badge. Each appears exactly where its own meaning is the true one, and docker itself
carries the same pair as `State.Status` vs `State.Health.Status`.

`ResolveRuntimeStateFromHealth` maps health onto the persisted state and can only ever return a
terminal value — health `starting` becomes `running`, since the container is already up. If it could
emit a transitional value, the supervisor and a lifecycle verb would fight over the record.

## Clients

- **Shell** — a transitional badge (sky, pulsing dot), and a lifecycle toggle that shows progress
  instead of an action while `IsBusy`. That toggle was binary before, so a starting app offered a
  **Start** button that would have raced its own start. Restart is disabled for the same window. The
  dashboard counts in-progress apps in their own tile rather than silently as "not running", and the
  missing-required-settings warning is suppressed mid-verb so it does not blink on every start.
- **CLI** — `ConsoleUi.State` already coloured `starting` and `stopping`, so `hosty apps list` needed
  no change. `hosty apps start|stop` are synchronous and print the settled state.

## Testing Expectations

- `CoreLifecycleServiceTests`: the record reads `starting` / `stopping` while the adapter is inside the
  verb, and terminal afterwards; a failing stop lands on `unknown` and never on `stopping`; a cancelled
  start and a cancelled stop both settle instead of stranding; the boot sweep resets a stranded state,
  leaves terminal states alone, and skips an app whose verb is still in flight; restore is refused
  while `stopping`; `ResolveRuntimeStateFromHealth` never returns an `IsBusy` value for any input.
- `CoreLifecycleServiceTests`: starting an app whose record already says `running` while it holds its
  own reserved port must not raise `runtime_port_unavailable` — the guard for the exemption being
  captured before the stamp rather than re-read after it.
- Port-preflight coverage stays as the regression guard for the one site that keeps `IsUp`.
- `apps/shell/test/runtime-states.test.mjs`: each predicate's membership, their mutual exclusivity, and
  explicitly that `isAppIdle` is narrower than the negation of `isAppUp`.
- `apps/shell/test/app-problems.test.mjs`: the settings warning is silent for both transitional states.

## Related

- [dependency-ordered-autostart](../dependency-ordered-autostart/plan.md) — adds `waiting` to this
  vocabulary once dependency-ordered autostart exists.
- [core-event-bus](../core-event-bus/feature.md) — how transitions reach clients without polling.

# Dependency-Ordered Autostart — Start Providers First, And Say So With `waiting`

Status: Draft
Created: 2026-07-28
Updated: 2026-08-26

## Goal

Start apps in an order their declared dependencies justify, and give an app that is held back a state
of its own — `waiting` — instead of leaving it indistinguishable from `stopped`.

## Why it does not exist today

Autostart groups by capability start-priority and runs those tiers in sequence, starting the apps
*within* a tier concurrently
([CoreLifecycleService.StartAutostartAppsAsync](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs));
the dependency graph is never consulted. A consumer and its provider in the same tier simply start
together, and the consumer comes up with a dead `HOSTY_DEPENDENCY_{ALIAS}_URL`. Nothing is broken
enough to notice reliably, which is exactly why it has survived.

Until [core-lifecycle-parallelism](../core-lifecycle-parallelism/feature.md) (2026-08-26) a tier ran
serially in alphabetical id order, so a pair whose ids happened to sort provider-first was ordered
correctly by accident. That accident is gone; the underlying gap is unchanged, but it no longer hides
behind alphabetical luck, which raises the value of building this.

The two prerequisites are now in place: dependency state is resolved and projected
([cross-app-dependencies](../cross-app-dependencies/feature.md)), and the runtime-state vocabulary can
carry a non-terminal value without every `!= "running"` gate misreading it
([app-lifecycle-states](../app-lifecycle-states/feature.md)).

## Target behavior

- Autostart visits apps in dependency order. Capability start-priority stays the outer key (the OTLP
  collector must precede its exporters regardless of who declares what); the dependency graph orders
  within it. Since a tier now starts concurrently, "orders within it" means dependency *waves* —
  parallel inside a wave, barriered between them — rather than a return to one-at-a-time.
- An app whose required dependency is not yet running is not started and is not left looking stopped:
  its `RuntimeState` becomes `waiting`, which the Shell renders distinctly from both `stopped` and
  `starting`.
- `waiting` resolves without operator action once the dependency comes up.
- A cycle is reported, not deadlocked.

## Open questions

1. What wakes a `waiting` app — polling the reconcile tick, or reacting to the dependency's own
   `app.changed`? The latter is cheaper and already fans out; the former is simpler to reason about.
2. Does `waiting` have a timeout, and what does it become on expiry — `stopped` with a `LastError`, or
   an indefinite wait only the operator resolves?
3. Should `waiting` be honoured by `StopRuntimeAppsAsync` at shutdown (nothing to stop), or is a
   no-op stop harmless?
4. Do **optional** dependencies gate anything at all? Treating them like required ones would stall a
   boot on an app the operator deliberately left stopped; ignoring them entirely means an optional
   provider that *is* installed and coming up gets raced anyway.
5. Does a manual `hosty apps start` on a `waiting` app force it, or join the wait? Forcing matches
   "the operator asked"; joining is more consistent.
6. `SystemAppBootstrapService.ensure-installed` force-starts anything not running
   ([:200](../../../apps/core/src/Haas.Hosty.Core/SystemAppBootstrapService.cs)) and would override a
   deliberate `waiting`. Which wins?

## Deliverables

- [ ] Answer questions 1–6; 1, 4 and 5 change the shape of the implementation, not just its details.
- [ ] Topological ordering inside `StartAutostartAppsAsync`, with cycle detection that reports rather
      than hangs.
- [ ] `waiting` added to the runtime-state vocabulary, its predicate classification, the boot recovery
      sweep, and the supervisor's observation filter.
- [ ] Wake path so a `waiting` app starts when its dependency does.
- [ ] Shell rendering for `waiting`, distinct from `stopped` and from the transitional states.
- [ ] `waiting` added to `ConsoleUi.State` ([ConsoleUi.cs:65](../../../apps/cli/src/Haas.Hosty.Cli/Commands/ConsoleUi.cs)),
      which already colours the other intermediate values.

## Verification

- Unit: a consumer declared before its provider alphabetically still starts after it; a cycle is
  reported and boot continues.
- Unit: a `waiting` app is not swept into `stopped` by the boot recovery, and is not force-started by
  system-app bootstrap.
- Live: stop `torrent-engine`, restart Core, and watch `media-server` sit in `waiting` and then start
  on its own once `torrent-engine` is up.

## Related

- [app-lifecycle-states](../app-lifecycle-states/feature.md) — establishes the vocabulary and the
  three predicates this feature extends.
- [cross-app-dependencies](../cross-app-dependencies/feature.md) — supplies the resolved dependency
  state this gates on.

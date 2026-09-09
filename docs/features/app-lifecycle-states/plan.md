# Plan — `running` Means Reachable

Status: Draft
Created: 2026-09-09
Updated: 2026-09-09

## Goal

Make `running` mean what [feature.md](feature.md) already says it means — "up and serving traffic" —
so a client that embeds or links to an app the moment Core reports `running` does not land on a
connection error.

## Why

`feature.md` defines `running` as *up and serving traffic*, and `IsUp` answers *may traffic reach
it?* with `running`. For a `localCommand` app the implementation reports `running` when the **process
starts**, not when it **accepts connections**, so for as long as the app takes to bind its port the
two disagree.

Observed on 2026-09-09 on a live host: starting `com.haas.demo-app` from its Shell panel, the panel
embedded the app's origin the instant the state flipped and rendered Chrome's own
`127.0.0.1 refused to connect` page for roughly a second before the app answered.

Shell cannot close this itself. The frame is cross-origin, so a failed load is unobservable —
`onLoad` fires for the browser's error page too — and there is no signal to wait on: Core's active
probe covers a `localCommand` service only when its manifest declares an http/tcp `healthcheck`, and
most do not. The gap is recorded in
[App UI Surfaces](../app-ui-surfaces/feature.md) as a known one, and this plan is where it is fixed.

The same race is not specific to panels. Any surface that opens on a state transition has it — the
embedded workspace and `hosty apps open` included — which is why the fix belongs to the state, not to
one of its consumers.

## Target behavior

Written as a diff against `feature.md`:

- `running` is reached only once the app's declared UI endpoint accepts a connection, or once a
  bounded readiness deadline passes. Until then the state stays `starting`, which every client
  already renders as progress.
- A readiness deadline that expires is **not** silently promoted to `running`: it is a start that did
  not become reachable, and it should surface the way a failed start does rather than handing clients
  an address that answers nothing.
- Apps with no reachable endpoint at all (no UI, no declared ports) are unaffected: there is nothing
  to probe, and their `running` keeps today's meaning.

## Open questions

- **Where the probe belongs.** Folding it into the runtime adapters' start path delays `running` for
  every client at once, which is the point; a separate readiness field instead would leave every
  consumer to remember to ask. The first is preferred, but it changes how long a start takes to
  report success and needs a look at the autostart fan-out in
  [Core Lifecycle Parallelism](../core-lifecycle-parallelism/feature.md).
- **The deadline.** Long enough for a cold `next dev` boot, short enough that a genuinely broken app
  fails visibly rather than hanging in `starting`.
- **Docker services.** A container with a declared HEALTHCHECK already has a readiness signal; decide
  whether the new probe defers to it or runs alongside.

## Deliverables

- [ ] Core probes the app's UI endpoint before reporting `running`, on a bounded deadline, for every
      runtime that exposes one.
- [ ] A start whose readiness deadline expires reports a failed start rather than `running`.
- [ ] `CoreLifecycleServiceTests` cover both outcomes: an endpoint that binds late still reaches
      `running`, and one that never binds does not.
- [ ] `feature.md` states the reachability guarantee; the known-gap paragraph in
      [App UI Surfaces](../app-ui-surfaces/feature.md) is removed in the same PR.
- [ ] Live verification on a host: start `com.haas.demo-app` from its Shell panel and confirm the
      panel goes from `starting` straight to the loaded page, with no connection-error frame.

## Verification

- `dotnet test` for Core.
- `npm run shell:build`, `npm run shell:test`.
- The live check above, which is the one that matters: the defect is a timing window, and no unit
  test observes what the browser renders inside a cross-origin frame.

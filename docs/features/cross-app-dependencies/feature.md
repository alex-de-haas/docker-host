# Cross-App Dependencies — Declared Providers, Injected URLs, And A Start-Time Advisory

Created: 2026-06-22
Updated: 2026-07-28

## Goal

Let one runtime app declare a dependency on **another installed app** and have Core wire up
**discovery** (inject the dependency's endpoint URLs) and surface a **start-time advisory** when the
dependency is missing or not running. The driving use case is a shared utility app — e.g. a
VPN-isolated `torrent-engine` — that a consumer app (Media Server) drives over an HTTP/SSE control
API.

A cross-app dependency is **not** an access barrier. In a single-tenant homelab all installed apps
are trusted; the dependency exists to tell the consumer *where* the provider is and to orchestrate
discovery — not to authorize the call. Any app that can reach the provider's port may call it; doing
so without declaring the dependency just means Core makes no guarantees. There is **no app-to-app
authentication** in this model.

## Non-goals

- **Auto-install / auto-start.** Core does not install a missing dependency or start a stopped one.
  It only reports the state (see Dependency State). Auto-orchestration may come later.
- **App-to-app authorization.** Declaring (or not declaring) a dependency does not grant or deny
  access at the network layer; it only drives discovery + the reported state.
- **Dependency-ordered startup across apps.** Autostart order is unchanged; the reported state covers
  the "provider not up yet" case.

## Manifest

```jsonc
"dependencies": [
  {
    "id": "com.haas.torrent-engine",   // required: the dependency app's id
    "version": "^0.1.0",                // optional: advisory only (shown in the notification)
    "required": true,                   // optional, default true: advisory level when missing
    "endpoints": [                      // which of the dependency's endpoints to wire
      { "key": "control", "as": "torrent" }
    ]
  }
]
```

- `endpoints[].key` — the endpoint key as declared in the **dependency app's** manifest.
- `endpoints[].as` — the env alias for the injected URL; defaults to `key`. Each wired endpoint is
  injected into the consumer as `HOSTY_DEPENDENCY_{ALIAS}_URL` (alias normalized to env style).

**Validation:** `id` is required; each endpoint `key` is required; the resulting
`HOSTY_DEPENDENCY_{ALIAS}_URL` names must be unique across the whole app. The dependency app's
existence and the endpoint's existence are **not** checked at manifest-validation time (the
dependency may not be installed yet) — that surfaces as the start-time advisory. Error codes:
`app_manifest_dependency_id_required`, `app_manifest_dependency_duplicate_id`,
`app_manifest_dependency_endpoint_key_required`, `app_manifest_dependency_alias_collision`.

## Discovery (URL injection)

At start, for each wired endpoint Core resolves the dependency app's endpoint by `key` and injects
its URL as `HOSTY_DEPENDENCY_{ALIAS}_URL`. For a **docker** consumer the URL's loopback host is
rewritten to `host.docker.internal` (the same rewrite used for `HOSTY_CORE_ORIGIN`), so the value is
reachable from inside the container; **localCommand** consumers get the URL as-is.

> **Connectivity caveat (current).** Reachability via `host.docker.internal:{hostPort}` requires the
> dependency to publish that endpoint host-reachable (`expose: "host"`). A loopback-only endpoint is
> not reachable across containers. Keeping a non-public utility endpoint **off the host/LAN** while
> still reachable by consumers (a shared cross-app docker network) is a planned hardening; today the
> minimal, lifecycle-decoupled `host.docker.internal` rewrite is used.

If the dependency app is not installed, or the named endpoint has no URL, no variable is injected for
it (and the advisory fires).

## Dependency State (no auto-install/start)

Every declared dependency is resolved against the installed set and carried on the app summary
(`GET /api/apps`), so a missing or stopped provider is **app state** rather than an event:

```jsonc
"dependencies": [
  { "appId": "com.haas.torrent-engine", "version": "^0.1.0", "required": true,
    "installed": true, "running": false,
    "endpoints": [ { "endpointKey": "control", "alias": "torrent", "resolved": false } ] }
]
```

Core reports **state, never a verdict** — `running` is only meaningful when `installed`, and every
endpoint reads `resolved: false` while the provider is absent. Deciding what deserves attention
belongs to the client, which is what lets one projection serve both the required and optional cases.
The Shell derives its Installed Apps problem icons from it:

| Dependency state | Surfaced as |
| --- | --- |
| required, not installed | error icon |
| required, installed, not running | error icon |
| optional, installed, not running | warning icon |
| optional, not installed | nothing — an uninstalled optional dependency is a choice, not a problem |
| running, wired endpoint has no URL | warning icon naming the missing `HOSTY_DEPENDENCY_{ALIAS}_URL` |

A stopped dependency reports the stop only, not also its (necessarily) unresolved endpoints — two
icons for one cause. The start is **not** blocked; this replaces auto-install/auto-start.

This state supersedes the start-time notifications Core used to publish. Those re-fired on every
start (the notification dedupe only matches *unread* records) and nothing ever retracted them once
the operator started the dependency, so a Core restart reliably produced a burst of advisories
describing a world that no longer existed. Unread `dependency-*` notifications left by an older Core
are purged once, at boot.

## Technical Design

- **Manifest model** (`RuntimeAppDependencyManifest`): `Id`, `Version?`, `Required?` (absent →
  `RequiredOrDefault == true`; a plain-bool initializer does not survive source-gen deserialization),
  and `Endpoints` (`RuntimeAppDependencyEndpoint { Key, As }`, `Alias = As ?? Key`).
- **Contract** (`AppDependencyContract`): `AppId`, `Version?`, `Required`, and
  `Endpoints` (`AppDependencyEndpointContract { EndpointKey, Alias }`), persisted on the app record.
- **Validation** (`AppManifestService.ValidateDependencies`).
- **Resolution** (`CoreLifecycleService.ResolveDependencyUrlsAsync`): per wired endpoint, keyed by
  alias.
- **Injection** (`DockerRuntimeAdapter` / `LocalCommandRuntimeAdapter`):
  `HOSTY_DEPENDENCY_{ALIAS}_URL`; docker applies the `host.docker.internal` rewrite.
- **State projection** (`CoreLifecycleService.ResolveDependencySummariesAsync` → `AppSummary.Dependencies`,
  as `AppDependencySummary` / `AppDependencyEndpointSummary`). `ListAppsAsync` hands it the record set
  it already holds, so listing stays one pass over `state.json` instead of re-reading every provider
  once per consumer.
- **Client derivation** (`collectAppProblems` in `apps/shell/src/app/shell/app-problems.ts`): the sole
  place the state becomes a severity, shared by the collapsed row's icons and the expanded panel's alerts.
- **Retired-advisory cleanup** (`NotificationService.PurgeByDedupePrefixAsync`, called once from the
  supervisor's boot sequence): drops leftover `dependency-*` notifications, read or unread, since the
  store has dedupe and `ReadAt` but no revoke.
- **Change detection** (`AddDependencyChanges` / `DependencySignature`): app id + version + required
  + sorted `endpointKey=alias`, so any dependency change drives a restart.

## Testing Expectations

- `AppManifestServiceTests`: accepts a dependency with endpoints (and `required` defaults true);
  rejects empty id, a duplicate dependency id, an endpoint with no key, and an alias collision.
- `CoreLifecycleServiceTests`: dependency URLs resolve per alias into the runtime context; the
  injected env for a localCommand consumer uses the alias (`HOSTY_DEPENDENCY_CACHE_URL`).
- `CoreLifecycleServiceTests`: the summary projection reports installed/running/version and per-endpoint
  resolution for a provider that is running, one that is stopped, and one that is absent; a running
  provider with an unmatched endpoint key reads unresolved; an app with no dependencies projects null.
- `apps/shell/test/app-problems.test.mjs`: every row of the state table above, including the silent
  one, the severity split on `required`, the env-var name in the unresolved-endpoint detail, the
  stopped-provider case raising exactly one problem, and an older Core sending no `dependencies` at all.

## Decision

The dependency is discovery + lifecycle-awareness only, with **no** app-to-app auth, because the
threat model is a trusted single-tenant host. Connectivity uses the minimal `host.docker.internal`
rewrite rather than a shared cross-app network: it is lifecycle-decoupled, fully unit-testable, and
cannot break app startup — at the cost of the dependency endpoint being host-reachable. The
shared-network variant (endpoint off the LAN) is left as a future hardening. Auto-install/start is
deferred in favor of reporting dependency state.

Dependency status is state, not a notification, because it is a **condition** rather than an event: it
becomes true and false on its own as the operator starts and stops apps, and a notification store with
dedupe and `ReadAt` but no revoke can only ever accumulate stale copies of it. The corollary is that
Core sends resolved state and the client decides severity — moving the verdict into Core would fix the
required/optional policy on the server and split problem derivation across two codebases.

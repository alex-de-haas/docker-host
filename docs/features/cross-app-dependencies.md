# Feature: Cross-App Dependencies

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
  It only notifies (see Advisory). Auto-orchestration may come later.
- **App-to-app authorization.** Declaring (or not declaring) a dependency does not grant or deny
  access at the network layer; it only drives discovery + the advisory.
- **Dependency-ordered startup across apps.** Autostart order is unchanged; the advisory covers the
  "provider not up yet" case.

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
`app_manifest_dependency_id_required`, `app_manifest_dependency_endpoint_key_required`,
`app_manifest_dependency_alias_collision`.

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

## Advisory (no auto-install/start)

When an app with declared dependencies starts, Core publishes a one-time notification (deduped per
app + dependency) to host admins for each dependency that is **not installed** or **not running**:

- not installed + `required: true` → **error**
- otherwise (optional, or installed-but-stopped) → **warning**

The start is **not** blocked — this is purely advisory, replacing auto-install/auto-start.

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
- **Advisory** (`CoreLifecycleService.NotifyMissingDependenciesAsync`) via `NotificationService`
  (CoreScope → host-admin broadcast).
- **Change detection** (`AddDependencyChanges` / `DependencySignature`): app id + version + required
  + sorted `endpointKey=alias`, so any dependency change drives a restart.

## Testing

- `AppManifestServiceTests`: accepts a dependency with endpoints (and `required` defaults true);
  rejects empty id, an endpoint with no key, and an alias collision.
- `CoreLifecycleServiceTests`: dependency URLs resolve per alias into the runtime context; the
  injected env for a localCommand consumer uses the alias (`HOSTY_DEPENDENCY_CACHE_URL`).

## Decision

The dependency is discovery + lifecycle-awareness only, with **no** app-to-app auth, because the
threat model is a trusted single-tenant host. Connectivity uses the minimal `host.docker.internal`
rewrite rather than a shared cross-app network: it is lifecycle-decoupled, fully unit-testable, and
cannot break app startup — at the cost of the dependency endpoint being host-reachable. The
shared-network variant (endpoint off the LAN) is left as a future hardening. Auto-install/start is
deferred in favor of a start-time advisory.

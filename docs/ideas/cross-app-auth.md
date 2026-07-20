# Cross-App Auth — Identifying the Caller on App-to-App Control APIs

Status: Idea (proposed 2026-07-20 — awaiting owner ratification)
Created: 2026-07-20
Updated: 2026-07-20

## Motivation — This Reopens a Settled Decision, Deliberately

[cross-app-dependencies.md](../features/cross-app-dependencies.md) ratified the opposite of
what this note proposes: "A cross-app dependency is **not** an access barrier … There is
**no app-to-app authentication** in this model", because "the threat model is a trusted
single-tenant homelab". That decision was coherent when it was made. Three things have
changed or surfaced since:

1. **A provider already voted with its feet.** torrent-engine shipped (through 0.4.x) an
   interim shared-secret guard on its own initiative: when `CONTROL_API_TOKEN` was set,
   every control request except `/healthz` had to carry it in `X-Api-Token`, compared in
   fixed time. The code comment stated the motive — "This removes the 'anything on the
   docker bridge can drive the engine' exposure **until the platform's app-identity tokens
   land**" — i.e. the app author considered the trusted-host assumption insufficient for
   *this* app and was explicitly waiting for a platform mechanism. When apps start
   hand-rolling a security contract the platform declined to provide, the pre-SDK auth
   story is restarting: independent copies, drift, then an incident.

2. **The interim guard proved the pairing problem, then was removed.** The setting was
   operator-visible (manifest `secret: true`, README, store listing), but media-server —
   the only consumer — sends no token of any kind (`RemoteTorrentEngine` /
   `RemoteTranscodeEngine` attach no auth header; verified 2026-07-20 — zero `X-Api-Token`
   references in the media-server repo, and `MediaServerSettings` has no field to hold
   one), and Core injects `HOSTY_DEPENDENCY_{ALIAS}_URL` and nothing else, so there was no
   channel to distribute the secret. Enabling the documented setting could only silently
   401 the one integration that exists. **Owner call 2026-07-20: removed outright, unused,
   in torrent-engine 0.5.0
   ([torrent-engine#22](https://github.com/alex-de-haas/torrent-engine/pull/22))** rather
   than carrying a legacy transition for deployments that cannot exist. The episode stands
   as evidence for this note: a per-edge operator secret dies on distribution and pairing
   even with a single edge. transcode-engine never had a guard at all.

3. **The trusted-host assumption has a shelf life.** The marketplace and third-party app
   feeds are the platform's stated direction; "every installed app is trusted" weakens
   with every app the operator installs from a feed they did not write. The engines are
   the worst place for that erosion to land: torrent-engine runs with `NET_ADMIN` +
   `/dev/net/tun` and writes into the catalog filesystems (`HOSTY_MOUNT_DOWNLOADS`);
   transcode-engine writes media mounts and burns GPU. Their control ports publish on the
   host's loopback, which is reachable by **every process on the machine**, not just the
   declared consumer — and the connectivity caveat in cross-app-dependencies.md points
   toward `expose: host` (LAN-reachable) for cross-container reachability. Reachability
   is topology-dependent (Docker Desktop and WSL2 forward host loopback into containers;
   bare Linux does not) — an implicit, topology-shaped boundary should not double as the
   security boundary.

Scope note: this is only about **cross-app** edges (`HOSTY_DEPENDENCY_{ALIAS}_URL`).
Intra-app service-to-service calls (`HOSTY_SERVICE_{KEY}_URL`, e.g. telemetry-ui → its
backend) stay inside one app's network boundary and are explicitly out of scope, per the
SDK trust model. App→Core calls are already authenticated by `HOSTY_APP_SERVICE_TOKEN`.

## Current State (verified 2026-07-20)

| Edge | Dependency | Consumer sends | Provider checks |
| --- | --- | --- | --- |
| media-server → torrent-engine | required | nothing | nothing (the interim `X-Api-Token` guard was removed unused in 0.5.0, [torrent-engine#22](https://github.com/alex-de-haas/torrent-engine/pull/22)) |
| media-server → transcode-engine | optional | nothing | nothing |

These two edges are the entire cross-app surface today: one consumer, two providers, all
three .NET.

## Existing Primitives — Most of the Design Already Exists

- **`HOSTY_APP_SERVICE_TOKEN`** is minted per app as
  `hosty_app_service.1.{base64url(appId)}.{HMAC}` over the durable
  `auth/app-service-signing.key` (#220), injected by **both** runtime adapters, and
  already authenticates every app→Core call. Critically,
  `AppServiceTokenService.ResolveAppId(token)` already introspects an arbitrary token to
  its app id — the validation core of this proposal is one existing method call.
- **The dependency graph is persisted** (`AppDependencyContract` on the app record), so
  Core can answer "does app X declare an edge to app Y" without new state.
- **The SDK has a decided validation pattern** to copy verbatim: online against Core,
  never local; 30s positive cache clamped, negatives never cached; classify by HTTP
  status ([hosty-app-sdk.md](hosty-app-sdk.md), decisions 1 and 9–10).
- **Known limits of the token, stated openly:** no expiry, no per-install nonce — a
  leaked token is valid until the signing key rotates (which recreates every app; the
  #220 adopt-vs-recreate machinery already handles that), and a token for an
  *uninstalled* app still verifies cryptographically. Both limits are why validation
  must be online (Core checks installed-ness), and both are acceptable at this trust
  level — the goal is caller identity on a LAN-adjacent port, not a bearer-token IAM.

## Proposed Design: Peer Introspection Against Core

One sentence: **the consumer authenticates to a provider with the service token it
already holds; the provider introspects it online against Core and learns the caller's
app id; authorization stays coarse (any installed app) with an optional strict mode.**

No new credential is minted, no new env is injected, no lifecycle changes:
`HOSTY_DEPENDENCY_{ALIAS}_URL` remains the only dependency wiring.

- **Core: one new endpoint** (name open), e.g.
  `POST /api/auth/apps/introspect-peer` — authenticated by the caller's own service
  token, body `{ "token": "…" }`, response `{ appId, installed, running }` and optionally
  `dependsOnCaller: bool`. Resolution is `ResolveAppId` + an app-record lookup. Rate
  limiting mirrors whatever `/launch-code` gets.
- **Provider middleware** (SDK, see below): reads `Authorization: Bearer`, exempts
  `/healthz` (Core probes it unauthenticated — the retired torrent-engine guard carved out
  the same exemption), introspects with the 30s positive-cache/no-negative-cache numbers,
  and disables itself entirely when the app is not Core-managed (no
  `HOSTY_APP_SERVICE_TOKEN` in env — the same `IsCoreManaged` gate media-server's
  `HostyOptions` already uses for standalone dev runs).
- **Consumer side** (SDK): a `DelegatingHandler` that attaches the app's own service
  token to the `HttpClient`s built from `HOSTY_DEPENDENCY_*` URLs. media-server adds it
  to `RemoteTorrentEngine` / `RemoteTranscodeEngine` in one registration.
- **SSE / long-lived streams:** validated at connect; a stream outlives later revocation
  until reconnect. This matches the cache's bounded-staleness semantics and avoids
  mid-stream teardown machinery.
- **Core unreachable:** fail closed with 503, exactly like the identity validator;
  cached positives bridge a keep-apps Core restart (tokens stay valid across it by the
  #220 design). The engines' data planes (active downloads, running transcodes) are
  unaffected — only new control calls stall.
- **Authorization default: authenticate, don't gate.** Any *installed* app's token is
  accepted; the provider logs the caller's app id. This preserves the ratified
  "dependency is not an access barrier" semantics while closing the anonymous-caller
  hole. A per-provider strict mode ("require a declared dependency edge", using
  `dependsOnCaller`) is a later opt-in, not the default — enforcement policy can then
  tighten per app without another platform change.

## Rollout (each step independently shippable)

1. **Core:** the introspection endpoint + tests.
2. **SDK:** provider middleware + consumer handler in `HostySdk.App` (.NET first — every
   edge today is .NET on both sides; the TS server-slice twin waits for a TS provider to
   exist). This folds naturally into the Second Wave's Core-capability-client area
   ([hosty-app-sdk.md](hosty-app-sdk.md)), same package, no new distribution channel.
3. **torrent-engine:** adopt the middleware. (The interim `CONTROL_API_TOKEN` was already
   removed unused in 0.5.0, torrent-engine#22 — no legacy-header window is needed, since
   nothing ever sent it.)
4. **transcode-engine:** adopt the middleware.
5. **media-server:** register the handler on both engine clients.
6. **Enforcement staged like the token-adoption boot check:** providers first run
   accept-and-log (warn on anonymous calls), flip to require once the consumer handler
   has shipped. Default becomes require.

**Stopgap resolved 2026-07-20:** the original draft required `CONTROL_API_TOKEN` to stay
unset until step 5 exists (enabling it silently 401'd the only consumer). The owner chose
the stronger option — the setting was removed outright in torrent-engine 0.5.0
(torrent-engine#22), so the footgun no longer exists and the providers are plainly
unauthenticated until this proposal's middleware ships.

## Rejected Alternatives

- **Complete the operator shared secret (wire `CONTROL_API_TOKEN` into consumers).**
  Manual pairing per edge, secret sprawl across two apps' settings, no rotation story,
  and the observed failure mode *is* the misconfiguration (provider enforces, consumer
  silently 401s). It also builds a second trust root beside Core.
- **Core-minted per-edge tokens injected into both sides.** Symmetric distribution means
  the provider's environment changes whenever a consumer is installed or removed —
  change-detection then restarts the provider for another app's lifecycle events,
  exactly the coupling the runtime model avoids.
- **Offline validation in the provider** (share the signing key or a derived verifier).
  Contradicts the decided online-only rule, sprays keying material into app
  environments, and cannot see installed-ness — the one check that neutralizes the
  token's no-expiry limit.
- **mTLS / workload identity (SPIFFE-style).** Core becomes a CA with issuance,
  rotation, and distribution machinery — operational weight out of all proportion to two
  edges on a homelab, and it still would not cover the localCommand runtime cleanly.
- **Do nothing.** Records why not: the marketplace trajectory erodes the trust
  assumption, the most privileged apps sit on the most exposed ports, and the interim
  guard already shipped — drift has started, and the SDK history shows where
  unconverged security copies end.

## Relationship to the Shared-Network Hardening

cross-app-dependencies.md defers a "shared cross-app docker network" so provider
endpoints can leave the host/LAN surface. That work is **complementary, not competing**:
network scoping shrinks *who can connect*; introspection identifies *who called*.
Either alone is incomplete — networks do not cover localCommand/dev runtimes or
host-local processes, and authentication without network scoping still leaves an
unauthenticated-DoS surface on the port. Ship this first (it is small and the primitives
exist), keep the network hardening on its own track.

## Open Questions (for ratification)

1. Endpoint name and response shape — include `dependsOnCaller` from day one, or add it
   with strict mode?
2. Should anonymous calls during the accept-and-log phase surface as a Core notification
   (like the dependency advisory), or stay in provider logs?
3. Does the consumer handler belong in `HostySdk.App` immediately, or wait and ship with
   the Second Wave capability client so the engines take one dependency bump instead of
   two?

(A fourth question — whether to bridge `CONTROL_API_TOKEN` into media-server settings —
was resolved 2026-07-20 by deleting the token instead: torrent-engine#22.)

## References

- [cross-app-dependencies.md](../features/cross-app-dependencies.md) — the ratified
  no-auth decision this note revisits, and the discovery contract it builds on.
- [hosty-app-sdk.md](hosty-app-sdk.md) — trust model (decision 1), online-validation rule
  and cache numbers (decisions 9–10), Second Wave packaging.
- [torrent-engine#22](https://github.com/alex-de-haas/torrent-engine/pull/22) — removal
  of the unused interim `CONTROL_API_TOKEN` (0.5.0); the engine's README keeps the 0.4.x
  history as the motivating precedent for this note.
- [PR #220](https://github.com/alex-de-haas/docker-host/pull/220) — durable
  app-service signing key; the rotation and adopt-vs-recreate machinery this design
  leans on.

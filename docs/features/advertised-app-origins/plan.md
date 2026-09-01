# Advertised App Origins — Advertise A Host-Published Endpoint At A Usable Address

Status: Draft
Created: 2026-07-30
Updated: 2026-07-30

## Goal

For an endpoint that is **already published beyond loopback**, let Core advertise it at an address
another device can use, configured once per host instead of once per app per endpoint.

This is narrower than it first looks, and the boundary matters more than the feature.

**Remote access through a proxy already works and needs nothing from this plan.** When an endpoint has
a public origin — Cloudflare publication writes `HOSTY_PUBLIC_ORIGIN_<KEY>` into the app's settings
([CloudflarePublicationService](../../../apps/core/src/Haas.Hosty.Core/CloudflarePublicationService.cs)),
and an operator can set the same value by hand for their own reverse proxy — the whole chain is
already correct: the summary projects it, `ResolveEndpointOpenUrl` prefers it over the loopback URL,
the redirect allowlist accepts it, and any client anywhere opens the app. `cloudflared` runs on the
host and dials `127.0.0.1:{port}` itself, so a tunnelled app **should** stay loopback-bound. Nothing
here improves that case.

What is left uncovered is one case: **a LAN with no proxy in front**. There, `RuntimePublicHost`
answers two different questions with one value — how Core dials an app, and what address Core tells a
client the app lives at. The first must stay a loopback IPv4 literal, because docker publishes these
ports on `127.0.0.1` and `localhost` resolving to `::1` first stalls `HttpClient` until timeout
([cli-bootstrap.md](../cli-bootstrap/feature.md)). The second is wrong for every client that is not on the
host, and today the only fix is a per-endpoint public origin, which is the right shape for one
published hostname and the wrong shape for "this host is at 192.168.1.10, tell everyone".

## What this does not do

**It publishes nothing.** A port bound to loopback stays unreachable from every other device, and this
setting will not — must not — advertise it otherwise.

That exclusion is not hypothetical: **every first-party UI app is loopback-only today**, Shell
included. `apps/shell/manifest.json` declares its port with no `expose`, so the publish is
`127.0.0.1:7171:3000`. This is correct for the tunnel case above and it means the setting alone does
not make Shell, Marketplace, or the Telemetry UI reachable from a phone on the LAN. Making them
reachable is a separate decision per app — see the open question.

## Target behavior

A diff against [automatic-runtime-app-ports/feature.md](../automatic-runtime-app-ports/feature.md)'s
endpoint URL projection.

**A host-level advertised host, as a live Core setting** — `HOSTY_ADVERTISED_HOST`, joining the
`HOSTY_*` keys owned by `CoreSettings` under its own group. One value, a host and not an origin: the
scheme comes from the endpoint's protocol and the port from its assignment, which is what lets one
setting serve every app. It is a live setting rather than launch-only environment on the same
reasoning that made the Cloudflare provider and base domain live while the config path stayed
plumbing — an operator changes their network address without wanting to restart Core. Clearing it
restores today's behavior exactly.

Accepted values: a DNS name, an IPv4 literal, or a bracketed IPv6 literal. Rejected: anything
carrying a scheme, port, path, query or userinfo; the unspecified addresses `0.0.0.0` and `::`, which
name "every interface" and cannot be dialled; and loopback names, which are what the setting exists to
replace. A trailing dot is normalized away rather than rejected, since it is a valid absolute DNS form
that would otherwise fail same-origin comparison against the URL a client actually uses.

**Applied only where the port's recorded bind scope is `host` or `host-network`.** Core records the
scope per reservation ([RuntimePortAllocator](../../../apps/core/src/Haas.Hosty.Core/RuntimePortAllocator.cs));
`loopback` keeps `127.0.0.1`, because a LAN URL for a loopback-bound port is a URL that cannot work,
and advertising it turns a clear failure into a confusing one.

The scope is a **declaration, not a proof**. It is derived from the manifest's `expose`, which
controls the docker publish; under `localCommand` the listener's bind address is chosen by the app
itself, and under host networking the app binds in the host namespace directly. So the scope says
"the operator and the app author intended this to be reachable", which is the right basis for
advertising an address and is not evidence that a socket is listening on it. Reachability failures
stay a runtime observation, not something this projection claims to prevent.

**Precedence: an explicit per-endpoint public origin wins.** A published hostname is more specific
than the host's own address. Both remain acceptable redirect URIs.

**The persisted record does not change.** `AppEndpointContract.Url` stays the loopback URL Core dials,
and the advertised value exists only on the projected summary, exactly like `PublicOrigin` and
`Availability`. This is the single most important invariant in the change: the reason the setting is
safe is that Core→app traffic never sees it.

**One resolver, three consumers.** The precedence and normalization rules are computed in one place
and consumed by the summary projection, the redirect allowlist in `AppIdentityService`, and
`ShellPublicOriginResolver`. The allowlist reads the persisted record plus settings rather than the
projection, so without a shared resolver it would need its own copy of the rules — and three copies of
a precedence rule is how an authorization check drifts out of step with what the UI shows.

Applying the rule uniformly means Shell is not a special case, and because Shell's own port is
loopback-scoped the uniform rule gives it nothing: no advertised origin, and therefore no change to
the CORS allowlist, invitation redirects, or `hosty open`. That is a consequence of the rule and is
worth a test, because the alternative — Shell quietly acquiring a new accepted origin — is a CORS
change nobody asked for.

**Bind scope reaches the client.** `AppEndpointContract` does not expose it, so no client can tell
"this app publishes on loopback only" from "this host has no advertised address". Both produce an
unreachable URL and each needs a different sentence. Projected on the summary, null in the persisted
record.

**A live change publishes a refresh hint.** Endpoint URLs are part of every app summary an open client
is already holding, so without a hint on the event bus an operator sets the address and every open
Shell and native client keeps serving the old URLs until something else forces a re-read.

## Deliberately not doing

- **Detecting the address by enumerating interfaces.** A typical host has several, plus a VPN, and an
  address guessed wrong is broadcast to every client as fact. Offering candidates in the UI is a
  reasonable later addition; deriving one automatically is not.
- **Trusting the request's `Host` header** to derive the allowlist entry. Recorded so it is not
  re-proposed: the header is chosen by the sender, so an allowlist derived from it would let a request
  name its own permitted redirect target, which is the entire thing the allowlist exists to prevent.
- **Changing `expose` defaults, or publishing anything.** Whether a port is bound beyond loopback stays
  a manifest declaration.
- **A Core reverse proxy** that would serve app UIs under Core's own origin. It would solve LAN access
  for every app at once and it is a genuinely different architecture, contradicting the standing
  decision that Core never proxies app HTML ([auth-gateway](../auth-gateway/feature.md)).
- **TLS for LAN origins.** Plain HTTP on a LAN remains the case.

## Open questions

1. **What, if anything, changes for the first-party UI apps?** With this setting alone, LAN access
   covers only apps that already declare `expose: host` — which none of Shell, Marketplace or
   Telemetry UI do. The options are: (a) leave them tunnel-or-localhost only and accept that the
   native client reaches apps on the LAN but not the first-party UIs; (b) opt specific manifests into
   `expose: host`, which binds a UI to `0.0.0.0` on the operator's network and is a security decision
   plus a version bump per app; (c) make the bind scope an operator setting rather than a manifest
   declaration. This question decides whether the feature delivers "open my apps from my phone" or
   only "advertise what is already exposed", and the goal above cannot be finalized without it.
2. **Where the setting's UI lands.** It belongs in the Settings page's Core tab, which
   [shell-navigation](../shell-navigation/feature.md) shipped. Either this plan adds the field there
   directly, or the Core side ships first and the field follows.

## Phases

### Phase 1 — Core projection

- [ ] `HOSTY_ADVERTISED_HOST` setting with validation and normalization.
- [ ] Shared resolver; summary projection; bind scope on the endpoint contract.
- [ ] Redirect allowlist and `ShellPublicOriginResolver` consuming the same resolver.
- [ ] Refresh hint on change.

### Phase 2 — Clients

- [ ] Shell: the field in the Settings Core tab; loopback-only marked where an endpoint URL is offered.
- [ ] Native client: exact diagnosis from bind scope, replacing the heuristic
      [swift-shell](../swift-shell/feature.md) ships.

### Phase 3 — Decision from open question 1

- [ ] Whatever that answer requires, or an explicit record that nothing changes.

## Deliverables

- [ ] Answer open question 1; the goal is not final until it is answered.
- [ ] Core setting, validation, normalization, `/api/core/settings` exposure, and reset semantics.
- [ ] One resolver consumed by the summary projection, `AppIdentityService`, and
      `ShellPublicOriginResolver`; no second copy of the precedence rules.
- [ ] Bind scope projected onto endpoint summaries; persisted record unchanged.
- [ ] Refresh hint published on a live change.
- [ ] Shell settings field and loopback-only marker.
- [ ] Platform minor bump; `apps/shell` minor bump for the settings field.
- [ ] `feature.md` for this folder; `automatic-runtime-app-ports/feature.md` endpoint URL section
      updated; `cli-bootstrap.md` migrated into a feature folder as part of touching it, stating that
      `HOSTY_RUNTIME_PUBLIC_HOST` is not the knob for client reachability and why.

## Verification

- `npm run core:build`, `npm run core:test`, `npm run shell:test`, `npm run shell:build`, `npm run ci`,
  `node scripts/docs-index.mjs --check`.
- Unit: a `host`-scope endpoint projects the advertised origin and a `loopback`-scope one does not; an
  explicit per-endpoint public origin wins; the allowlist accepts the derived origin, still accepts the
  explicit one, and still refuses an unrelated one; validation refuses scheme, port, path, userinfo,
  `0.0.0.0`, `::` and loopback names, and normalizes a trailing dot; Shell's own loopback-scoped
  endpoint yields no advertised origin and the CORS allowlist is unchanged.
- Live: with the address set, open an `expose: host` app from a second device and confirm the app
  reports the signed-in user; confirm a loopback-only app still shows the explanation rather than a
  dead view; confirm Core's own health and telemetry reads still dial loopback and keep working, which
  is the invariant this change exists not to touch; change the setting with a client open and confirm
  it re-reads without a manual refresh.

## Links

- [Swift Shell](../swift-shell/feature.md) — the client blocked by this on a LAN; ships the diagnosis.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — bind scopes, endpoint URL
  projection, `publicOrigin`.
- [Auth And Gateway Model](../auth-gateway/feature.md) — the redirect allowlist, and the standing
  decision that Core does not proxy app UIs.
- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — the path that already solves remote access.
- [Raw L4 Ports](../raw-ports.md) — the `expose: host` declaration this depends on.

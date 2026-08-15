# Core Extension Model

Status: Draft
Created: 2026-07-10
Updated: 2026-08-15

Exploratory. This plan authorizes no implementation and changes no current system-app behavior; it
formalizes a pattern the platform already uses ad hoc so the next capability does not invent a second
delivery vehicle.

## Goal

Make platform capabilities replaceable, optional, or third-party-suppliable without growing the Core
kernel: telemetry storage, notification delivery channels, catalog/marketplace logic, additional
sign-in methods, backup targets. Today such a capability is either compiled into Core, or reached
through the one narrow seam that exists — a `provides` slot that selects Core-side behavior (see
Current Behavior) — and never through a contract Core calls.

Core is Native AOT, so in-process plugin loading (`AssemblyLoadContext`, MEF) is impossible by
construction. That constraint points at the better architecture anyway: extensions run out-of-process,
as ordinary installed apps, with fault isolation, independent update cycles, their own trust boundary,
and no language coupling. The closest prior art is Home Assistant add-ons and Docker volume/network
plugins — HTTP contracts against a supervisor — not VS Code extensions.

The pattern already exists in practice: the telemetry app took the telemetry store, query API, and the
observability UI out of Core and Shell, and Marketplace shipped as a read-only system app that Core
knows nothing about. The 2026-07-12 revision of this document folded in the interaction-form taxonomy,
contract cardinality, the ownership reading of "system", and the login-methods reframing of
authentication.

## Current Behavior

- **Ownership has a manifest field.** `app.0.1` carries a top-level `role`, validated to exactly
  `"system"` and projected onto `AppRecord.System` at install; `shell`, `marketplace`, `telemetry`,
  and `ai-gateway` all declare it. It governs who may see and reach the app, not whether it can be
  uninstalled ([removable-system-apps](../removable-system-apps/feature.md)).
- **A capability axis exists, but Core-side only.** The manifest's top-level `provides` is a list of
  kebab slot tokens, shape-validated with unknown slots deliberately allowed so a manifest may name a
  slot a newer Core understands. Core keys two things off a slot it knows (`PlatformCapabilities`):
  pre-start provisioning, and autostart priority. The registry holds exactly one slot today —
  `otlp-collector`, provisioned by `CollectorBootstrap` and started before its exporters — and
  `apps/telemetry` is its only declarant. Because the trigger is the slot rather than an app id, a
  third-party app declaring it gets the same treatment, which is the piece of this model that already
  works.
- **What `provides` is not.** It selects Core-side behavior; it never routes a call *to* the app,
  carries no version, declares no cardinality, and passes through no operator consent of its own.
  There is no `requires` counterpart for scope requests. The manifest `capabilities` field remains a
  lifecycle-affordance list (`open`, `update`, `restart`, …), and `interfaces` (a draft `app.0.1`
  extension) is discovery metadata other components resolve, not a contract Core invokes.
- Marketplace runs as a read-only system app with **zero Core scopes**, using only generic app-token
  endpoints (installed-apps, app-directory roster). It is live proof that a real extension can need no
  contract at all — just the ordinary API surface.
- Core's telemetry integration is producer-side only: it pushes host-produced docker stats and logs
  into the collector endpoint resolved live from the app's `AppRecord.Endpoints` (well-known endpoint
  keys, literal IPv4, never `localhost`). The former read proxy was removed with the telemetry-ui
  extraction; per-app ingest auth is still deferred. This push relationship is a de-facto sink contract
  that only lacks a name, a version, and auth.
- The idiomatic in-process seam is `IAppRuntimeAdapter` (multiple registrations, string-keyed
  `ResolveAdapter`). Catalog document fetching is pluggable via `ICatalogDocumentFetcher`, and catalog
  sources are runtime-mutable.
- A notification hub exists (Core-owned store, per-user SSE over the unified event stream — see
  [notifications](../notifications/feature.md)), and [core-event-bus](../core-event-bus/feature.md)
  ships an ephemeral hint-only bus. Neither is the durable, cursor-addressable domain event log this
  model needs; lifecycle transitions remain observable only as user notifications produced inline in
  `CoreLifecycleService`.
- Two Core-minted token systems exist: `AppIdentityService` (user-identity grants for app SSO) and
  `AppServiceTokenService` (opaque per-app service token injected as `HOSTY_APP_SERVICE_TOKEN`, used
  for app→Core callbacks). Neither carries scopes; there is no data-plane token yet.
- Cross-app `dependencies` already wire sibling endpoint URLs into env, and trusted-proxy SSO (the
  `X-Hosty-Trusted-User-Id` and `X-Hosty-Trusted-Proxy-Secret` headers, validated against the
  Core-configured `HOSTY_TRUSTED_PROXY_SECRET`, exchanged for a session) already provides an
  external-identity entry point.

## Target Behavior

Design principle: a contract is a question Core asks — "who signed in with this method?", "where does
this telemetry stream go?", "how do I deliver this notification?" — never a right for a plugin to reach
into the kernel. Core always keeps the decision and the privileged execution; plugins supply answers.
Contracts are small, versioned HTTP+JSON APIs (AOT-friendly with source-generated serialization; no
gRPC).

The companion rule sets the default: **a contract exists only where Core itself must know and call the
counterparty. Everything else is just an app using Core's API.** Marketplace demonstrated that the
contract-free form goes further than expected — prefer growing small generic endpoints over minting
bespoke contracts whenever the flow is app-initiated.

```mermaid
flowchart LR
  subgraph Clients
    S["Shell / CLI"]
  end
  subgraph Core["Core (Native AOT kernel)"]
    R["Capability registry"]
    E["Event log"]
    F["Built-in fallbacks"]
  end
  subgraph Apps["Installed apps"]
    T["Telemetry app (sink)"]
    G["Google Auth (login method)"]
    M["Marketplace (API client)"]
  end
  S -->|"install / update lifecycle"| Core
  S -->|"read-only catalog API"| M
  M -->|"generic scoped API"| Core
  Core -->|"OTLP stream (sink contract)"| T
  R -->|"login-method contract call"| G
  Apps -->|"SSE subscribe with cursor"| E
```

### Interaction Forms

| Form | Direction | Contract needed | Example |
| --- | --- | --- | --- |
| API client | app → Core | No — scopes only | Marketplace (zero scopes today) |
| Driver | Core → app, request/response | Yes | login method, notification channel, backup target |
| Sink | Core → app, data stream | Yes | telemetry OTLP push (de-facto today) |
| Event subscription | app-initiated pull from Core | One generic mechanism | automations, delivery plugins |
| System app pages | Shell renders app UI | No — existing `ui.*` manifest | Marketplace, telemetry UI |

1. **API clients (no contract).** An app consumes Core's API with whatever scopes the operator granted
   — possibly none. Core does not model the app's purpose at all. Marketplace is the canonical example:
   it serves its own catalog data and reads two generic app-token endpoints; stopping it removes
   discovery and nothing else.
2. **Driver contracts (Core calls the app, request/response).** Manifest entries grow from today's
   flat slot tokens into `provides: [{ contract, version, endpoint }]`. Core keeps a capability
   registry mapping contract →
   app → endpoint; endpoints resolve live from `AppRecord.Endpoints` at call time (literal IPv4, never
   `localhost`). Candidate contracts: login method, notification delivery channel, backup target.
   Runtime adapters stay in Core: they need docker.sock-level privileges.
3. **Sink contracts (Core pushes a stream into the app).** Same registry and manifest surface as
   drivers, but the shape is a continuous producer→consumer stream rather than a call: today's concrete
   case is Core pushing docker CPU/memory stats and logs as OTLP into the telemetry collector.
   Formalizing it means naming the contract (e.g. `hosty.telemetry.sink@1`), binding it to an endpoint
   key, and adding the deferred ingest auth. Sinks are naturally fan-out.
4. **Event subscriptions (the app pulls from Core).** Core writes domain events (`app.installed`,
   `app.started`, `app.crashed`, `backup.completed`, …) into a durable log with monotonic sequence
   numbers. An app subscribes over SSE/long-poll using its `HOSTY_APP_SERVICE_TOKEN` and a persisted
   cursor, and re-reads from the cursor after reconnect — at-least-once delivery with no Core-side
   retry queue. Pull beats webhooks because app→Core dialing already works, the app needs no inbound
   endpoint, and Core→container calls would require published ports and reintroduce the
   `localhost`/IPv6 dial hazards.
5. **System app pages (Shell).** A UI-capable app reuses `ui.entrypoint` and `ui.navigation`; Shell
   renders it through the existing app-origin iframe/SSO machinery. Already shipped for Marketplace and
   the telemetry app, whose Metrics / Structured logs / Traces pages live in an `apps/telemetry-ui`
   system-app UI reading its own backend directly — Core's telemetry read proxy was removed, and the UI
   labels appId-keyed data via a generic app-token roster endpoint rather than a telemetry-specific
   contract (see [observability](../observability/feature.md)).

### Provider Lifecycle

```mermaid
flowchart TB
  A["Install app whose manifest declares provides/requires"] --> B["Validate: does Core support the contract and version?"]
  B --> C["Operator explicitly confirms the provider/scope grant"]
  C --> D["Register in capability registry; mint scoped token into env"]
  D --> E["Operate: Core resolves endpoint and calls the contract"]
  E -->|provider unavailable| F["Degradation policy: fallback, queue, or fail"]
```

Cross-cutting rules:

- **Manifest.** `provides` gains structure — a contract identifier, a version, and the endpoint key
  Core resolves to call it — while today's bare slot tokens keep working, since Core already ignores
  slots it does not know. `requires` is new: the control-plane scopes an app asks for. An app that
  only serves its own read-only API declares neither. Both stay distinct from the lifecycle
  `capabilities` field, which is unrelated.
- **Trust.** `provides`/`requires` declarations are inert until the operator explicitly confirms them at
  install review, and an update that **changes** these declarations re-enters review — a harmless app
  must not grow into a login method through a minor version bump. Catalog signing can strengthen this
  later. Consent dialogs for sensitive contracts must be alarming by design: a media app requesting the
  login-method role should look anomalous.
- **Cardinality.** Every contract explicitly declares whether it is **single-active** (one confirmed
  provider selected by the operator, like a default app) or **fan-out** (all confirmed providers are
  called, or all receive the stream). Login methods, notification channels, and telemetry sinks are
  fan-out; single-active is reserved for genuine replacements. Leaving cardinality implicit is not
  allowed — a second provider would otherwise create unresolvable ambiguity.
- **Auth.** One scoped-token mint covers both directions: Core→app contract calls present a Core-issued
  token the app can verify, and app→Core control-plane/event-stream calls present the app's service
  token extended with granted scopes. This generalizes the deferred observability ingest auth and
  matches the [ai-agent-bridge](../ai-agent-bridge/feature.md) decision that data planes use
  Core-issued signed tokens.
- **Versioning.** Contract identifiers carry an integer version (`hosty.auth.method@1`). Core advertises
  supported contracts (e.g. `GET /api/capabilities`); installing an app that provides an unsupported
  contract version fails manifest validation.
- **Degradation.** Each contract declares what Core does when the provider is stopped or unhealthy (the
  registry consults the existing health supervisor): fall back to a built-in implementation (telemetry
  → "no data"), queue and retry (notification delivery), or shrink the option set (an unavailable login
  method's button disappears while local login remains). Because Core is never displaced from its own
  responsibilities, no contract needs a break-glass mechanism.

### Roles, Trust, And The "System" Label

The label "system" conflates two independent axes, and this model splits them:

- **Privilege is not a sort of app.** Any installed app may declare `provides`/`requires`; the right to
  act on them comes from per-declaration operator consent (plus, later, signing) — never from being
  "system". A small domain app living in the Google ecosystem is a legitimate login-method provider.
- **Ownership remains a real property.** Some apps are bundled with the platform, bootstrapped and
  supervised by Core (Shell, telemetry, Marketplace). That is a distribution/ownership fact — who
  installs, updates, and repairs the app — not a trust tier.

Consequences for the operator surface:

- **One app list, badges instead of a separate class.** All apps appear in the same Installed Apps
  list. Badges derive from **confirmed registry facts** — ownership, confirmed roles, and role state
  (active vs merely registered) — never from manifest self-description.
- **Uniform lifecycle actions, consequence-aware warnings.** Every app gets the same
  stop/restart/update/uninstall verbs. Warnings are generated only from Core's own bookkeeping:
  stopping an app that holds a confirmed contract role names that role. An app with no roles and no
  scopes gets zero ceremony. A manifest field for "message to show when I am stopped" is rejected:
  self-description is both untrustworthy and unnecessary.
- **Shell is a smaller exception than it looks.** Stopping the UI you are using is recoverable through
  three mechanisms that already exist: the loaded browser page talks to Core directly and survives a
  Shell stop, the CLI can start it back (`hosty apps start hosty.shell`), and Core bootstrap reinstalls
  a missing bundled app at startup. A deliberately scary confirmation is enough; a hard "mandatory app"
  block would contradict both the warn-don't-block precedent and the rule that Shell is only one of
  several possible UI clients.

### Worked Example: Additional Login Methods

The first draft asked "can a plugin replace authentication?". The answer is: it should not. **Core
remains the sole authorization authority** — users, roles, sessions (`hosty_session`), CSRF, and request
authorization are kernel-owned, and no external provider displaces them. What apps add are
authentication *methods*: extra ways to prove you are an existing Hosty user.

The contract is `hosty.auth.method@1`, a fan-out driver contract. The canonical example is a small
"Google Auth" app with no other product function:

- **Linking.** A signed-in user connects a Google account to their existing Hosty user. The method app
  runs the OIDC flow and returns a verified external subject to Core; Core stores the identity link.
  Linking requires an existing session, so there is no automatic user provisioning by default — which
  keeps the [auth-provider-extensions](../../ideas/auth-provider-extensions.md) boundaries intact.
- **Sign-in.** The login surface shows a button per *available* confirmed method. Choosing one delegates
  verification to the method app; the app returns the verified subject; Core resolves the linked user
  and issues its own session. A method app never issues credentials.
- **Degradation is trivial.** Methods supplement local password login rather than replacing it, so an
  unavailable method just loses its button.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Core
  participant P as Google Auth app
  participant X as Google
  B->>C: login page (no session)
  C-->>B: local login + confirmed method buttons
  B->>C: sign in with Google
  C->>P: delegate via auth.method contract
  P->>X: OIDC authorization flow
  X-->>P: verified subject (sub, email)
  P-->>C: verified external identity
  C->>C: resolve linked Hosty user
  C-->>B: Core-issued hosty_session, roles, CSRF
```

Two adjacent capabilities are deliberately separate:

- **Identity claims for apps (cheap, near-term).** Apps that only need "this is the user linked to
  Google account X" get it through the existing app-SSO grant: the identity link enriches the claims
  Core already mints. No new contract.
- **Identity token broker (heavy, deferred).** Handing an app a real Google access/refresh token is a
  different trust surface entirely: storing third-party refresh tokens, per-app consent on provider
  scopes, rotation, revocation. It anchors on the same identity link and will likely become a second,
  linked contract — but it must not weigh down the simple login-methods story.

A perimeter alternative remains available with no new contract: an authenticating-proxy system app (the
oauth2-proxy pattern) fronting Shell and presenting the existing trusted-proxy assertion to mint a Core
session. It suits whole-perimeter SSO; login methods suit per-user, per-account linking.

### Prior Art Already Shipped: Marketplace

Marketplace's extraction shipped 2026-07-11 as the first zero-scope API client with system-app pages,
and its boundaries are current behavior — see
[runtime-app-marketplace](../runtime-app-marketplace/feature.md) and
[marketplace-system-app](../../ideas/marketplace-system-app.md). Two of them constrain this model:

- **The install decision never leaves Core.** Feed resolution, manifest validation, operator consent,
  artifact locks, and any install-blocking trust policy run in Core. Marketplace output is treated like
  an operator-pasted URL.
- **Bootstrap must be generic.** The marketplace app itself installs without a marketplace, and the base
  install paths (CLI, direct manifest URL) stay in Core permanently. The final mechanism should be
  generic rather than another app-id-specific bootstrap branch.

### Limits Of The Model

An honest boundary statement: this approach does not allow adding functionality Core never anticipated.
A plugin can only extend seams Core explicitly cut, and each new *category* of extension is a Core
release that adds a contract. Three things soften this:

- The generic seams — API clients with scopes, event subscriptions, and system app pages — cover many
  scenarios without any new contract, and Marketplace proves the ceiling is high.
- Adding a contract is a small, ordinary Core release, not a redesign; the registry, token, and
  validation machinery are shared.
- Some functionality must never be pluggable, by design rather than by limitation: anything touching
  docker.sock or host privileges, the app lifecycle state machine, session/authorization integrity, and
  manifest validation. In-process extensibility (WASM/scripting hosts) is rejected for v1 as a second
  runtime inside the kernel with no current demand.

## Deliverables

Sequenced so each step is independently useful; nothing here is approved for implementation while this
plan is Draft.

- [ ] 1. Surface ownership and roles in the UI: one Installed Apps list, badges from Core-confirmed
      facts, uniform lifecycle actions with registry-derived warnings, immediate navigation updates on
      app state changes.
- [ ] 2. Formalize the telemetry push as the first sink contract (`hosty.telemetry.sink@1`) with scoped
      data-plane tokens — no behavior change, mechanism proven, and the deferred ingest-auth item
      closed.
- [ ] 3. Introduce the durable domain event log and pull subscriptions; ship a notification-channel
      plugin (e.g. Telegram delivery) as the first external consumer.
- [ ] 4. Design `hosty.auth.method@1` (link-first login methods) after the mechanism has survived steps
      2–3; keep the identity token broker explicitly deferred. The authenticating-proxy pattern remains
      available meanwhile for perimeter SSO.
- [ ] 5. Docs: a `feature.md` here once a contract ships, plus the manifest and Shell documents the
      `provides`/`requires` sections touch.

## Conflicts With Existing Features

- [shell-access-and-system-apps](../shell-access-and-system-apps/feature.md) treats system apps as a
  separate visibility/administration class; this plan moves toward one Installed Apps list with
  ownership/role badges and uniform lifecycle actions, while keeping visibility itself role-gated as
  today.
- [notifications](../notifications/feature.md) defers Core→app delivery to webhooks; this plan revises
  that direction to pull-based event subscriptions.
- [core-event-bus](../core-event-bus/feature.md) ships an ephemeral hint-only bus that apps can neither
  read nor write. The durable, cursor-addressable log in step 3 is a different mechanism and must not be
  mistaken for an extension of it.
- The manifest `capabilities` field name collides conceptually with capability contracts; the new
  sections need distinct names (`provides`/`requires`) and documentation.
- [auth-provider-extensions](../../ideas/auth-provider-extensions.md) lists OIDC and provisioning
  directions; the login-methods contract supplies a delivery mechanism for the OIDC half while keeping
  its boundaries. Full replacement of Core authentication by an external provider is not pursued.

## Risks

- **Contract sprawl / premature abstraction.** Mitigation: formalize the existing telemetry push as the
  first contract before designing new ones; one pilot per interaction form.
- **Privilege escalation through declarations.** Mitigation: explicit operator consent per declaration,
  re-consent when an update changes declarations, minimal scope grants, audit-log entries for every
  scoped call, catalog signing later, and consent UX that makes anomalous requests look anomalous.
- **Availability coupling.** Core paths that call providers inherit their failure modes, and provider
  roles can be held by casually-stopped domain apps. Mitigation: mandatory per-contract degradation
  policy, short timeouts, health-supervisor gating, and stop/uninstall warnings derived from confirmed
  registry roles.
- **Hot-path latency.** Out-of-process calls must stay off per-request paths; request authorization
  always evaluates against Core-owned sessions, never a plugin round-trip. Method apps are consulted
  only during interactive sign-in and linking.
- **Event log growth.** The durable log needs bounded retention and a compaction story before the first
  external subscriber.
- **Silent best-effort failures.** Swallow-everything client behavior has already produced invisible
  outages (empty marketplace, empty observability); registry calls need structured error surfacing and
  admin notifications instead.

## Open Questions

- Question: How is the ownership label expressed — `role: system`, an explicit `owner: platform`
  marker, or purely Core-side bootstrap state?
  Recommendation: since the label means ownership rather than privilege, prefer Core-side state (Core
  knows what it bootstrapped) surfaced as a badge, with a manifest field only if third-party "suites"
  later need it.
- Question: Where are `requires` scopes enforced — at token mint, per request, or both?
  Recommendation: both; mint restricts the ceiling, per-request checks catch stale grants after an
  update changes declarations.
- Question: How is the event log persisted (in-memory ring vs SQLite in Core) and how are event schemas
  versioned?
  Recommendation: start with a bounded persistent log inside Core state; version events with the
  contract-style integer suffix.
- Question: Where do login-method buttons render, given the login surface is Core-owned today?
  Recommendation: the method list must come from Core's confirmed registry (never from app
  self-description), with unavailable methods hidden; the exact split between Core-served login pages
  and Shell rendering needs a design pass together with the linking UX in user settings.
- Question: Which contract ships first?
  Recommendation: the telemetry sink (`hosty.telemetry.sink@1`) — it names an integration that already
  runs in production, proves registry/token/degradation with zero new product surface, and closes the
  deferred ingest-auth item.
- Question: What is the token-broker consent and storage model?
  Deferred with the broker itself; revisit once login methods exist and a concrete app needs
  provider-API access.

## Verification

- Each contract ships with a manifest-validation suite: an unsupported contract version fails install,
  and a declaration change on update re-enters operator review rather than being adopted silently.
- Degradation is tested per contract in the failing direction, not only the happy one — a stopped
  provider must produce the documented fallback, and a registry call that fails must surface rather
  than be swallowed.
- The first sink contract is verified against the live telemetry push: the same data arrives with the
  contract named and ingest auth enforced, and an unauthenticated push is refused.
- Event subscriptions are verified across a reconnect: an app resuming from its cursor receives every
  event it missed exactly once, and a slow subscriber does not stall Core.

## Links

- [Final Hosty architecture boundaries](../final-hosty-architecture.md) — the Core/Shell/CLI ownership
  rules this model extends.
- [Observability — telemetry backend](../observability/feature.md) — the de-facto first plugin; source
  of the sink contract.
- [Notifications](../notifications/feature.md) — the hub the first event-subscriber plugin would deliver
  for.
- [Runtime app marketplace](../runtime-app-marketplace/feature.md) — the shipped zero-scope API client
  with system-app pages.
- [Marketplace As A System App](../../ideas/marketplace-system-app.md) — the read-only catalog ownership
  boundary and migration design.
- [System App Pages](../../ideas/system-app-pages.md) — the shared admin-only page model for UI-capable
  system apps.
- [Runtime App Repository Feeds](../../ideas/runtime-app-repository-feeds.md) — current feed behavior
  with repository ownership and Core resolution.
- [AI Agent Bridge](../ai-agent-bridge/feature.md) — shares the Core-issued scoped-token direction for
  data planes.
- [Auth provider extensions](../../ideas/auth-provider-extensions.md) — auth directions the
  login-methods contract gives a delivery mechanism for.
- [On-Demand System App Updates](../../ideas/system-app-updates.md) — the reviewed update path provider
  apps rely on, since they update like any other app.

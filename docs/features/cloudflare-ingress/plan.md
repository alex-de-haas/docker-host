# Cloudflare Ingress — Remaining Work

Status: In Progress
Created: 2026-07-14
Updated: 2026-09-01

The one-click Cloudflare ingress plan shipped through PRs #194–#201: the API client and private token
store, the connect and discovery flow, the preservation-safe tunnel-config patcher, DNS CNAME CRUD and
the publication ownership store, the publish/unpublish reconciler, the publish API, and both Shell
surfaces. What that built is described in [feature.md](feature.md).

An audit on 2026-07-28 collected what was still missing and left one open question: should the API
path become a third provider value, or should the local provider merely skip derivation for endpoints
that already have a publication? **That question is answered here — a third provider value** — and the
answer reshapes the rest of the plan, so the deliverables below supersede the 2026-07-28 revision
rather than extending it. Nothing audited then has been dropped; the ordering and the framing changed.

The two shipped defects are still listed first, because they are defects.

## Why the current shape is the defect

The provider dropdown's `Cloudflare Tunnel` and the `Cloudflare ingress` connection card below it look
like unrelated features. They are not: both drive the same Cloudflare Tunnel with the same operator-run
connector, and Cloudflare terminates TLS in both. They differ only in **who writes the routes** — Core
rendering a local `config.yml` that `cloudflared` reads, or Core patching the tunnel's configuration
over the API and creating one exact CNAME per hostname.

A Cloudflare tunnel is either locally managed or remotely managed, never both; the connect flow already
filters locally-managed tunnels out as ineligible. So the two paths are mutually exclusive **in fact**
while the model treats them as unrelated: the provider enum holds only `none` and `cloudflared`
([CoreSettings.cs:102](../../../apps/core/src/Haas.Hosty.Core/CoreSettings.cs)), the API stack is
registered unconditionally and gated on whether a connection is stored, and Shell shows the publish
control only when the provider is `cloudflared`
([cloudflare-publish-control.tsx:33](../../../apps/shell/src/app/shell/pages/cloudflare-publish-control.tsx)).

Both reachable configurations are wrong, and both were observed on a live host:

- **Provider `none` with a healthy connection.** Connect succeeds, the card reports the account, zone,
  tunnel and a healthy connector — and no endpoint can be published, because Shell hides every publish
  control. The connection is inert.
- **Provider `cloudflared` with a healthy connection.** The publish control appears, a label publishes,
  and then the next start of that app re-derives `HOSTY_PUBLIC_ORIGIN_*` from `{subdomain}.{baseDomain}`
  and overwrites it. The route and DNS record survive; the injected origin reverts.

Core's publication endpoints never consulted the provider — `CloudflarePublicationService` requires a
stored connection and nothing else. The coupling lives entirely in Shell's visibility rule and in the
local provider's derivation. Making the API path a provider is therefore mostly the removal of an
accidental coupling plus one enum value, not a rewrite.

## Goal

Make ingress a single choice with three mutually exclusive values, so exactly one mechanism owns a
public origin at any moment; then finish the lifecycle, cleanup, and diagnostics work the publication
path already assumes.

## Target behavior

Written as a diff against [feature.md](feature.md).

### Three providers

`HOSTY_INGRESS_PROVIDER` gains a third value:

| Value | Shell label | Tunnel | Routes | DNS | Hostnames |
| --- | --- | --- | --- | --- | --- |
| `none` | Disabled | — | — | — | operator sets `HOSTY_PUBLIC_ORIGIN_*` by hand |
| `cloudflare-remote` | Cloudflare | remotely managed | Core PUTs the tunnel config over the API | Core creates one exact proxied CNAME per hostname | operator picks a label per endpoint |
| `cloudflared` | Cloudflare Tunnel (local config) | locally managed | Core renders `config.yml`, the operator runs `cloudflared --config` | operator adds one wildcard CNAME, once | derived `{subdomain}.{baseDomain}` for every running app |

`cloudflare-remote` is the name the original design used, and it matches Cloudflare's own
remotely-managed/locally-managed distinction. `cloudflared` keeps its exact current meaning, so no
persisted setting changes behavior under it and no migration is needed for hosts already using it.

The local provider stays. It is the only path that works without handing Hosty an API token and the
only one that works with a locally-managed tunnel; removing it remains out of scope
([Deliberately not doing](#deliberately-not-doing)).

### One owner per public origin

Provider decides who writes `HOSTY_PUBLIC_ORIGIN_<KEY>`, and therefore which surface may edit it:

- **`none`** — the operator. The free-form URL field in the app's Public origins tab is editable and is
  the only surface; `configure` accepts it as it does today.
- **`cloudflare-remote`** — the publication. The publish control owns any endpoint with a stored
  publication; the free-form field renders that value read-only with a pointer to the publish control.
  Endpoints with no publication stay operator-editable, because an operator may front one endpoint with
  their own proxy while publishing another.
- **`cloudflared`** — the derivation. The field is read-only for every public endpoint and explains
  that the origin comes from the base domain plus the app's subdomain.

`POST /api/apps/{id}/configure` enforces this in Core rather than trusting Shell: a write to a
`HOSTY_PUBLIC_ORIGIN_*` key that the active provider manages is refused with a distinct error, so the
value cannot diverge from Cloudflare behind the publication's back.

**The origin overwrite disappears by construction.** Derivation runs only under `cloudflared` and
publication only under `cloudflare-remote`, so a published label is never re-derived. This is why the
provider answer was preferred over exempting published endpoints from derivation: the exemption keeps
both mechanisms live at once and has to be re-established at every point that touches an origin.

### Ingress is its own settings tab

`Settings` gains a fourth tab beside Users, Core and Shared mounts, on the same URL-addressable rule
the page already follows ([settings-page.tsx](../../../apps/shell/src/app/shell/pages/settings-page.tsx)).
It holds the provider selector, the fields belonging to the selected provider, and — for
`cloudflare-remote` — the connection card, which moves out of the Core tab.

Fields are shown per provider, not all at once: `cloudflared` shows base domain, tunnel ID and
credentials file; `cloudflare-remote` shows none of them, because connect discovers the tunnel and the
selected zone supplies the base domain; `none` shows a sentence explaining that origins are set per app.
The visibility rule lives in the new Ingress section keyed on the provider value, and the Core tab keeps
rendering its groups generically from Core's `group` field — a `dependsOn` in the settings DTO would be
a contract change serving exactly one screen.

The Core tab loses the `Public ingress` group. Core keeps returning it in the same group so the
settings contract is unchanged; only the client that renders it moves.

### A stored connection migrates the provider once

A host that connected a token while the provider stayed `none` is in the inert state described above.
On first start after the upgrade, a stored Cloudflare connection with provider `none` moves the
provider to `cloudflare-remote`, logged as a migration. This is derived from persisted state, not
guessed: storing a connection has no other purpose. Any other provider value is left alone, and the
migration runs once.

### Selecting a provider is not the same as being ready

`cloudflare-remote` with no stored connection is a legitimate intermediate state: the publish control
renders a "connect first" state pointing at the Ingress tab instead of vanishing, and
`GET /api/core/status` carries a warning in the same shape the incomplete-`cloudflared` warning already
uses. Switching away from `cloudflare-remote` while publications exist warns and changes nothing
remotely — Hosty-owned routes and records are removed only by an explicit unpublish or by disconnect
with Remove.

### The rest of the audited remainder

Unchanged in substance from the 2026-07-28 audit, re-stated as behavior:

- An account, zone, or tunnel ambiguity is resolved once in Shell and persisted. Today it is a hard
  failure whose message says selection "is not supported yet".
- The token link is a Cloudflare template URL prefilling the required permission groups, instead of a
  plain dashboard link with the permissions written out as prose.
- An existing DNS record or tunnel route can be adopted explicitly. Today `cloudflare_hostname_conflict`
  is a dead end and the `adopted` ownership state is never assigned. The phase-0 spike found the live
  account already carrying matching proxied CNAMEs, so this is hit on the first connect, not at an edge.
- A revoked, expired, or permission-reduced token produces `reconnect_required` without deleting routes,
  DNS, or local intent. Today that status is never assigned and Shell's reconnect prompt is unreachable.
- Endpoint removal, app update, and uninstall remove the Hosty-owned DNS record and tunnel route. Today
  all three leave them behind, along with the stored publication.
- Disconnect offers Keep or Remove, defaults to Keep, and never deletes dashboard-owned objects. Today
  it deletes the token and integration state and abandons every published resource, behind a code
  comment still claiming no Hosty-owned resources exist.
- A per-endpoint publication reports `Not configured`, `Active`, `App stopped`, `Restart required`, or
  `Error`. Today Core exposes an ownership state plus a `restartRequired` bool, and Shell renders only
  "not configured" and "Published at". `Syncing` is deliberately not among them: publishing is
  synchronous, so nothing could ever produce it.
- The connector-locality verdict is consulted before a mutation, not only at connect.
- Core's own hostname is *reported* by diagnostics, with the CNAME target and tunnel service the
  operator must create by hand — now only under the providers that cannot publish it (`none` and
  `cloudflared`). Publishing it through the product workflow was a separate feature, and
  [core-public-origin](../core-public-origin/feature.md) has since shipped it: it turned on where
  `HOSTY_CORE_PUBLIC_ORIGIN` lives, not on anything in this plan.

## Deliverables

- [x] `cloudflare-remote` provider value: enum, validation, `/api/core/status` projection, and the
      `IIngressController` contract split so derivation and `config.yml` rendering stay `cloudflared`-only.
- [x] Publication gated on the provider in Core, not only hidden in Shell; a "connect first" state and a
      status warning for `cloudflare-remote` without a connection.
- [x] One owner per origin: per-provider editability of the Public origins field, plus a `configure`
      guard refusing writes to a managed `HOSTY_PUBLIC_ORIGIN_*`.
- [x] One-time provider migration for a host with a stored connection and provider `none`.
- [x] Shell `Ingress` settings tab: `HostSettingsTab`, route parsing and href, the section itself, the
      connection card moved out of the Core tab and out of `dialogs/`, per-provider field visibility.
- [x] Account/zone/tunnel selection in Shell, replacing the ambiguity hard-fail.
- [x] ~~Prefilled token template URL carrying the confirmed permission groups.~~ **Not done, deliberately.**
      Cloudflare's template links prefill through `permissionGroupKeys`, but the key for the tunnel
      permission is undocumented — the published tables cover DNS and zone and stop there. A link that
      prefills two of the three while silently dropping the one that is actually hard to find sends an
      operator away confident and back with a `403`. The connection card now names the permission the way
      the dashboard does instead ("Argo Tunnel (Legacy)"), which is the part that was really missing:
      searching the token editor for "Cloudflare Tunnel" finds nothing.
- [x] Explicit adoption of an existing DNS record or tunnel route, assigning the `adopted` state.
- [x] Assign `reconnect_required` on token revocation, expiry, or permission loss.
- [x] Lifecycle cleanup on endpoint removal, app update apply, and uninstall, with uninstall review
      listing Hosty-owned publications.
- [x] Disconnect Keep/Remove choices, halting and staying retryable on a failed deletion.
- [x] Per-endpoint publication state machine in Core DTOs, rendered by Shell.
- [x] Consult connector locality before mutation; classify external-probe failures against it.
- [x] Publication health/diagnostics endpoint and deduplicated host-admin warnings for public endpoints
      with no configured origin.
- [x] Notifications for publication outcomes.
- [x] ~~Core public-origin publication through the product workflow.~~ **Moved out of this plan** to
      [core-public-origin](../core-public-origin/feature.md). It is a different feature wearing this
      one's clothes: the hard part is not publishing a hostname but moving `HOSTY_CORE_PUBLIC_ORIGIN` out
      of the CLI's `launch.env`, and its readers include the login page and invitation links, so it can
      lock an operator out of their own host. Owning that risk inside an ingress plan would have hidden
      it. What ships here instead is the diagnostic below, which costs nothing and closes the part that
      was actually invisible.
- [x] Core's own hostname reported by diagnostics: `not_configured` / `external` alongside the drift
      states, carrying the CNAME target and tunnel service the operator must create by hand. A hint, not
      a publication — nothing in Hosty creates or owns Core's route or record.
- [x] Explicit restart affordance in Shell after a successful publish.
- [x] Shell tests for the provider-conditional Ingress tab, connected/disconnected/stopped/error states,
      and the label sanitizer.
- [x] `feature.md` rewritten around the three providers, with the "Where the two paths collide" section
      deleted rather than edited.
- [x] `docs/features/core-api/feature.md` updated with the connection and publication endpoints.
- [x] Platform minor bump; `apps/shell` minor bump. Regenerate the docs index.
- [ ] Live end-to-end verification against a real Cloudflare account (see Verification).

## Phases

### Phase 1 — The provider model

- [x] `cloudflare-remote` value, contract split, publication gating, status warning.
- [x] One owner per origin plus the `configure` guard.
- [x] Provider migration for a stored connection.
- [x] Regression tests: a published label survives a start; derivation never runs under
      `cloudflare-remote`; `configure` refuses a managed key.

### Phase 2 — The Ingress tab

- [x] Tab, route, section, moved connection card, per-provider field visibility.
- [x] Publish control's "connect first" state.
- [x] Shell tests.

### Phase 3 — Finish the connection

- [x] Shell selection for an ambiguous account/zone/tunnel.
- [x] Prefilled template URL (dropped with reasons; the permission names were fixed instead).
- [x] `reconnect_required` assignment and recovery.
- [x] Adoption path.

### Phase 4 — Lifecycle and cleanup

- [x] Endpoint removal, update, and uninstall cleanup.
- [x] Disconnect Keep/Remove.
- [x] Publication state machine and Shell rendering.

### Phase 5 — Diagnostics and platform origins

- [x] Locality consulted before mutation; health endpoint; warnings; notifications.
- [x] Restart affordance after a publish.
- [x] Core's own hostname reported by diagnostics; the publication workflow itself moved to
      [core-public-origin](../core-public-origin/feature.md).

### Phase 6 — Documentation and verification

- [x] `feature.md`, `core-api/feature.md`, docs index, version bumps.
- [ ] Live end-to-end run.

## Deliberately not doing

- **Removing the local `cloudflared` provider.** It is the only path that needs no API token and the
  only one that drives a locally-managed tunnel. Reduced to a third choice, not deleted.
- **Merging the two Cloudflare providers into one value with an auto-detected mode.** The tunnel's
  management mode is discoverable, but the operator's intent is not: an unconnected host and a host
  whose token was revoked would be indistinguishable from one that chose the local file.
- **OAuth connection and a hosted callback bridge.** Deferred on 2026-07-14, not rejected. Cloudflare
  OAuth clients are private by default, so a shared product client would need permanent domain
  verification (DNS TXT, logo, maintained client URL) before any third-party installation could connect,
  plus a Hosty-operated callback bridge — the first centrally hosted infrastructure in a self-hosted
  product — plus single-flight refresh-token rotation. Everything below the authorization layer is
  identical to the token path, so the extra weight buys connection polish only, and both end with a
  bearer credential in the same store.
- **The legacy Global API Key**, or any unscoped account credential.
- **Wrapping the locally-managed workflow in a wizard.** Browser login, OS elevation, and service
  installation stay platform-specific and failure-prone, and it cannot adopt the remotely-managed tunnel
  that already works.
- **Creating a tunnel, or installing and supervising a connector.** Connection requires a healthy
  existing connector and stops before any mutation when none is available.
- **Cross-zone hostnames, path-based routing, wildcard Hosty DNS, Load Balancer, Spectrum,
  private-network routes, and Access policies.**
- **Publishing every eligible app automatically**, or choosing hostnames on the operator's behalf.
- **A `hosty` ingress or Cloudflare CLI command.** Not rejected, just not in this scope.

## Standing decisions

Settled on 2026-07-14 and still constraining the code:

- Hosty owns only the exact routes and DNS records it created or explicitly adopted; every save reads
  the latest Cloudflare state and preserves unrelated applications.
- Hostname is the uniqueness key. Ownership is never inferred from a local port, so an app's port
  changing updates the route target without changing the public URL.
- Exact proxied CNAMEs, one per published hostname. Wildcard DNS is not required and other subdomains
  under the same base domain stay untouched.
- The form takes a label, not a URL; the selected zone supplies the base domain.
- Missing public origins are warnings, not start blockers.
- Saving never silently restarts an app. Cross-app dependency injection uses local endpoint URLs, so a
  public-origin change needs no dependent restart.
- Bearer credentials live in a dedicated private store, never in `settings.json`, API projections,
  browser storage, or logs. Disconnect cannot revoke the token — a scoped token cannot revoke itself —
  so it directs the administrator to the dashboard.

Added 2026-07-30:

- Ingress is one exclusive choice. Two mechanisms never own public origins at the same time, and a new
  ingress mechanism is a provider value, not a second surface riding alongside one.

## Open questions

None. The provider-versus-exemption question the previous revision carried is answered above.

## Verification

- `npm run core:build`, `npm run core:test`, `npm run cli:test`, `npm run shell:lint`,
  `npm run shell:test`, `npm run shell:build`, `npm run ci`
- `node scripts/docs-index.mjs --check`
- Unit: each provider value validates and rejects unknown values; `cloudflare-remote` writes no
  `config.yml` and derives no origin; `cloudflared` still derives and renders; publication is refused
  under `none` and `cloudflared`; `configure` refuses a managed `HOSTY_PUBLIC_ORIGIN_*` per provider and
  still accepts it under `none`; the migration fires once for connection-plus-`none` and never for any
  other combination.
- Shell: the Ingress tab renders per-provider fields, survives a refresh on its URL, and the publish
  control shows "connect first" under `cloudflare-remote` with no connection.
- Live: publish an endpoint under a chosen label, restart the app, and confirm the origin still resolves
  to that label.
- Live: token connect, reconnect after revocation, and missing-permission failure against a real scoped
  token.
- Live: a real remotely-managed tunnel carrying pre-existing Dashboard routes, before and after a Hosty
  save.
- Live: exact DNS create/update/rename/delete and an adoption conflict under a shared base domain.
- Live: publication of a stopped, never-started app followed by first start.
- Live: endpoint removal, uninstall, and disconnect under both Keep and Remove.
- Live: an existing `cloudflared` host upgrades and keeps deriving origins with no operator action.

### What the phase-0 spike established

A read-only spike ran against a live account and zone before implementation. Its findings are verified
facts, not assumptions, and they still shape the design:

- The template flow yields an **account-owned** token: `GET /user/tokens/verify` answers
  `Invalid API Token`, so validity must be proven by a resource probe and the account-scoped verify
  endpoint used for metadata. Token length is not a reliable check.
- The sufficient permission groups were **Argo Tunnel (Legacy) Read+Edit** (the `cfd_tunnel` permission
  under current dashboard naming — "Cloudflare Tunnel" is no longer a search hit), **DNS Edit**, and
  **Zone Read**. "Connectivity Directory" was not needed.
- The tunnel configuration carried a top-level `warp-routing` key beside `ingress`, which is what makes
  preserve-unknown pass-through mandatory rather than precautionary. The config exposed a monotonic
  `version`, `originRequest` entries, and a final catch-all, with no PUT precondition.
- The connector's `origin_ip` was **IPv6**, so locality comparison must be dual-stack.
- The account already published proxied `CNAME → <tunnel-id>.cfargotunnel.com` hostnames matching the
  tunnel's ingress rules, so the adoption path is exercised on the very first connect, not as an edge
  case. This is why the missing adoption deliverable above matters more than its size suggests.
- No write was performed. **The whole-document PUT round-trip and the DNS mutations have never been
  exercised against a live account** — only against unit-test fixtures.

## Links

- [Cloudflare Ingress](feature.md) — the shipped behavior, including the collision this plan removes.
- [Shell Navigation](../shell-navigation/feature.md) — the Settings page whose tab set this extends.
- [Advertised App Origins](../advertised-app-origins/plan.md) — the LAN-without-a-proxy case, which this
  plan deliberately does not cover.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — install-time reservations,
  the prerequisite that lets a stopped app be published; complete.
- [Core Settings](../../ideas/core-settings.md) — the live-settings surface the provider fields use.
- [Notifications](../notifications/feature.md) — the stream publication outcomes would use.
- [Cloudflare API Token Templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare Tunnel Connections API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get)
- [Cloudflare DNS Record Management](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)

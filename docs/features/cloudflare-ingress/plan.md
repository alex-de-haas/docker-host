# Cloudflare Ingress — Remaining Work

Status: Draft
Created: 2026-07-14
Updated: 2026-07-28

The one-click Cloudflare ingress plan shipped through PRs #194–#201: the API client and private token
store, the connect and discovery flow, the preservation-safe tunnel-config patcher, DNS CNAME CRUD and
the publication ownership store, the publish/unpublish reconciler, the publish API, and both Shell
surfaces. What that built is described in [feature.md](feature.md); this document is what an audit on
2026-07-28 found still missing.

The original plan was approved on 2026-07-14 and its checkboxes were never maintained — all 60 read
unchecked while phases 1 through 4b had merged. The deliverables below are the audited remainder.
Status is `Draft` because this re-scoping has not been approved in this form; promote to `Ready` to
start.

**Two of these are defects in shipped behavior, not unbuilt features** — the origin overwrite and the
two competing publish surfaces. They are listed first for that reason.

## Goal

Make the Cloudflare API path a real provider rather than a service stack riding alongside the local
one, so a published origin survives an app start; then finish the lifecycle, cleanup, and diagnostics
work the publication path assumes.

## Target behavior

Written as a diff against [feature.md](feature.md).

- Publishing under an operator-chosen label survives an app restart. Today the local provider must be
  selected for Shell to offer publishing at all, and that provider re-derives and overwrites
  `HOSTY_PUBLIC_ORIGIN_*` from `{subdomain}.{baseDomain}` on every start.
- One surface owns a public origin. Today the Cloudflare label dialog and the free-form URL field in
  the Public origins tab both write the same setting, and `configure` accepts a URL without consulting
  Cloudflare.
- An account, zone, or tunnel ambiguity is resolved once in Shell and persisted. Today it is a hard
  failure whose message says selection "is not supported yet".
- The token link is a Cloudflare template URL that prefills the required permission groups, instead of
  a plain dashboard link with the permissions written out as prose.
- An existing DNS record or tunnel route can be adopted explicitly. Today `cloudflare_hostname_conflict`
  is a dead end and the `adopted` ownership state is never assigned.
- A revoked, expired, or permission-reduced token produces `reconnect_required` without deleting
  routes, DNS, or local intent. Today that status is never assigned and the Shell reconnect prompt is
  unreachable.
- Endpoint removal, app update, and uninstall remove the Hosty-owned DNS record and tunnel route.
  Today all three leave them behind, along with the stored publication.
- Disconnect offers Keep or Remove, defaults to Keep, and never deletes dashboard-owned objects.
  Today it deletes the token and integration state and abandons every published resource.
- A per-endpoint publication reports `Not configured`, `Syncing`, `Active`, `App stopped`,
  `Restart required`, or `Error`. Today Core exposes an ownership state plus a `restartRequired` bool,
  and Shell renders only "not configured" and "Published at".
- The connector-locality verdict is consulted before a mutation, not only at connect.
- Core's own hostname can be published through the same workflow, persisting the launch setting and
  applying it with the existing keep-apps restart.

## Deliverables

- [ ] Stop the local provider overwriting a published origin — make the API path a distinct provider,
      or exempt endpoints with a stored publication from derivation.
- [ ] Collapse the two public-origin editing surfaces into one, and guard `configure` against writing
      a managed `HOSTY_PUBLIC_ORIGIN_*` behind Cloudflare's back.
- [ ] Account/zone/tunnel selection in Shell, replacing the ambiguity hard-fail.
- [ ] Prefilled token template URL carrying the confirmed permission groups.
- [ ] Explicit adoption of an existing DNS record or tunnel route, assigning the `adopted` state.
- [ ] Assign `reconnect_required` on token revocation, expiry, or permission loss.
- [ ] Lifecycle cleanup on endpoint removal, app update apply, and uninstall, with uninstall review
      listing Hosty-owned publications.
- [ ] Disconnect Keep/Remove choices, halting and staying retryable on a failed deletion.
- [ ] Per-endpoint publication state machine in Core DTOs, rendered by Shell.
- [ ] Consult connector locality before mutation; classify external-probe failures against it.
- [ ] Publication health/diagnostics endpoint and deduplicated host-admin warnings for public
      endpoints with no configured origin.
- [ ] Notifications for publication outcomes.
- [ ] Core public-origin publication through the product workflow (launch setting plus keep-apps
      restart), preserving loopback recovery.
- [ ] Explicit restart affordance in Shell after a successful publish.
- [ ] Shell tests for connected/disconnected/stopped/error states and the label sanitizer.
- [ ] Update `docs/features/core-api/feature.md` with the connection and publication endpoints.
- [ ] Live end-to-end verification against a real Cloudflare account (see Verification).

## Phases

### Phase 1 — Fix the shipped defects

- [ ] Published origin survives a start.
- [ ] One editing surface plus the `configure` guard.
- [ ] Regression tests for both.

### Phase 2 — Finish the connection

- [ ] Shell selection for ambiguous account/zone/tunnel.
- [ ] Prefilled template URL.
- [ ] `reconnect_required` assignment and recovery.
- [ ] Adoption path.

### Phase 3 — Lifecycle and cleanup

- [ ] Endpoint removal, update, and uninstall cleanup.
- [ ] Disconnect Keep/Remove.
- [ ] Publication state machine and Shell rendering.

### Phase 4 — Diagnostics and platform origins

- [ ] Locality consulted before mutation; health endpoint; warnings; notifications.
- [ ] Core public-origin workflow and restart affordance.

### Phase 5 — Verification

- [ ] Shell tests.
- [ ] `core-api/feature.md`.
- [ ] Live end-to-end run.

## Deliberately not doing

- **OAuth connection and a hosted callback bridge.** Deferred on 2026-07-14, not rejected. Cloudflare
  OAuth clients are private by default, so a shared product client would need permanent domain
  verification (DNS TXT, logo, maintained client URL) before any third-party installation could
  connect, plus a Hosty-operated callback bridge — the first centrally hosted infrastructure in a
  self-hosted product — plus single-flight refresh-token rotation. Everything below the authorization
  layer is identical to the token path, so the extra weight buys connection polish only, and both end
  with a bearer credential in the same store.
- **The legacy Global API Key**, or any unscoped account credential.
- **Wrapping the locally-managed workflow in a wizard.** Browser login, OS elevation, and service
  installation stay platform-specific and failure-prone, and it cannot adopt the remotely-managed
  tunnel that already works.
- **Creating a tunnel, or installing and supervising a connector.** Connection requires a healthy
  existing connector and stops before any mutation when none is available.
- **Removing the local `cloudflared` provider** before an explicit migration and compatibility review.
- **Cross-zone hostnames, path-based routing, wildcard Hosty DNS, Load Balancer, Spectrum,
  private-network routes, and Access policies.**
- **Publishing every eligible app automatically**, or choosing hostnames on the operator's behalf.

## Standing decisions

These were settled on 2026-07-14 and still constrain the code:

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

## Open questions

- Should the API path become a third provider value, or should the local provider simply skip
  derivation for endpoints with a stored publication? The first is closer to the original design; the
  second is a much smaller change and keeps one code path for `config.yml` rendering.

## Verification

- `npm run core:build`, `npm run core:test`, `npm run cli:test`, `npm run shell:lint`,
  `npm run shell:test`, `npm run shell:build`, `npm run ci`
- `node scripts/docs-index.mjs --check`
- Publish an endpoint under a chosen label, restart the app, and confirm the origin still resolves to
  that label.
- Token connect, reconnect after revocation, and missing-permission failure against a real scoped token.
- A real remotely-managed tunnel carrying pre-existing Dashboard routes, before and after a Hosty save.
- Exact DNS create/update/rename/delete and an adoption conflict under a shared base domain.
- Publication of a stopped, never-started app followed by first start.
- Endpoint removal, uninstall, and disconnect under both Keep and Remove.

### What the phase-0 spike established

A read-only spike ran against a live account and zone before implementation. Its findings are verified
facts, not assumptions, and they still shape the design:

- The template flow yields an **account-owned** token: `GET /user/tokens/verify` answers
  `Invalid API Token`, so validity must be proven by a resource probe and the account-scoped verify
  endpoint used for metadata. Token length is not a reliable check.
- The sufficient permission groups were **Argo Tunnel (Legacy) Read+Edit** (the `cfd_tunnel`
  permission under current dashboard naming — "Cloudflare Tunnel" is no longer a search hit),
  **DNS Edit**, and **Zone Read**. "Connectivity Directory" was not needed.
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

- [Cloudflare Ingress](feature.md) — the shipped behavior.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — install-time reservations,
  the prerequisite that lets a stopped app be published; complete.
- [Core Settings](../../ideas/core-settings.md) — the live-settings surface the provider fields use.
- [Notifications](../notifications.md) — the stream publication outcomes would use.
- [Cloudflare API Token Templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare Tunnel Connections API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get)
- [Cloudflare DNS Record Management](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)

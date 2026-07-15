# One-Click Cloudflare Public Ingress

Status: Ready
Created: 2026-07-14
Updated: 2026-07-14

## Goal

Connect Hosty to an existing healthy remotely managed Cloudflare Tunnel with a scoped API token created
from a prefilled template link, and let a host administrator publish runtime app endpoints by entering
only a subdomain label in Shell. Hosty must synchronize exact DNS records and tunnel routes without
`cert.pem`, tunnel credential JSON, local YAML, terminal commands, or destructive ownership of
dashboard-managed applications.

## Scope

- Add a new API-managed ingress provider with a persisted identity distinct from the current local
  `cloudflared` provider.
- Implement token-based connection: a prefilled Cloudflare token template URL, one paste field,
  verification before storage, private credential storage, and revocation/reconnect handling.
- Discover/select the Cloudflare account, zone/base domain, healthy remotely managed tunnel, and
  connector, including a connector-locality preflight.
- Add a provider-aware Public origins form that accepts one DNS label per `public: true` endpoint.
- Persist publication intent and Hosty ownership per app endpoint.
- Create exact proxied CNAME records and narrowly patch the selected tunnel's latest remote configuration.
- Preserve dashboard-managed routes, global options, unknown fields, ordering, and catch-all behavior.
- Validate hostname conflicts and support explicit adoption without silent overwrite.
- Add synchronization progress, health diagnostics, restart-required state, warnings, and notifications.
- Handle Core/Shell public origins, endpoint/update/uninstall cleanup, disconnect choices, and token
  health.
- Update Core, CLI, Shell, CI/release metadata, tests, and current feature documentation.

## Out of Scope

- OAuth-based connection and any hosted callback bridge (deferred together with the OAuth path; the idea
  records the verified distribution constraints).
- Accepting the legacy Global API Key or any unscoped account credential.
- Revoking the Cloudflare token from Hosty (the scoped token cannot revoke itself; disconnect directs the
  administrator to dashboard revocation).
- Installing, updating, or supervising the `cloudflared` connector.
- Creating a tunnel when no healthy remotely managed tunnel exists.
- Supporting a locally managed tunnel through the new API provider.
- Publishing every eligible app automatically or automatically choosing final hostnames.
- Cross-zone hostnames, arbitrary full URLs, path-based routing, wildcard Hosty DNS, Cloudflare Load Balancer,
  Spectrum, private-network routes, or Access policy management in the first version.
- Making truly simultaneous Dashboard and Hosty configuration writes atomic when Cloudflare exposes no
  conditional tunnel-configuration update.
- Removing the current local `cloudflared` provider before explicit migration and compatibility review.
- Automatically restarting runtime apps after a public-origin change.
- Storing the Cloudflare API token in Shell, browser storage, Core behavior settings, or logs.

## Current Behavior

- Provider `cloudflared` writes a complete local `config.yml` and expects an operator-provided tunnel ID,
  credentials JSON, wildcard DNS, and separately supervised process.
- The provider derives app hostnames automatically and overwrites `HOSTY_PUBLIC_ORIGIN_*` during app start.
- It exposes no Cloudflare API client, token storage, remote ownership metadata, DNS reconciliation,
  connector health, or external reachability verification.
- Shell Platform settings ask for base domain, tunnel ID, credentials-file path, and provider value.
- Installed apps accept full public-origin URLs through the generic configure endpoint; the value is
  validated for shape (absolute `http(s)` origin without path, query, or fragment) but not restricted to
  any domain.
- A changed app public origin is injected only on the app's next start/restart.
- Core and Shell public origins are CLI launch settings; Core already has a keep-apps restart endpoint backed
  by the managed CLI.

## Target Behavior

- Shell shows `Connect Cloudflare`; it opens Cloudflare's prefilled token-creation page, accepts one
  pasted scoped token, and completes verification, discovery, and selection without terminal input.
- When exactly one eligible account/zone/healthy remote tunnel exists, Hosty selects it automatically;
  ambiguous discovery asks once and persists the selection.
- Discovery compares each connector's reported public origin IP with the host's egress IP and raises a
  named pre-mutation warning on mismatch; end-to-end publication verification remains the definitive
  locality proof.
- Connection requires a Core hostname when Core lacks a working public origin, suggests `core`, publishes it,
  persists the launch setting, and performs the existing keep-apps restart while preserving local recovery.
- The installed-app Public origins panel shows a label field with immutable base-domain suffix and per-endpoint
  state: `Not configured`, `Syncing`, `Active`, `App stopped`, `Restart required`, or `Error`.
- Saving one popup validates every submitted endpoint, applies one tunnel-config mutation set, mutates only
  the corresponding DNS records, persists local origins after remote success, and returns product-level
  stages/errors.
- A stopped app can be published immediately because install-time port assignments provide its target URL;
  remote state is valid but displayed as `App stopped` until the service runs.
- Dashboard-managed routes and unrelated subdomains remain editable between Hosty operations and are
  preserved on every Hosty save.
- Running apps are never restarted silently. Shell offers explicit restart of the changed app after successful
  synchronization; Shell/Core changes use their approved platform-specific restart flow.
- Missing publication remains a non-blocking local-app warning when Cloudflare is connected.

## Acceptance Criteria

- [ ] A host administrator can connect Cloudflare by creating a token on the prefilled template page and
  pasting it once, without entering a certificate path, tunnel credential path, YAML path, or terminal
  command.
- [ ] The template URL prefills exactly the permission groups the integration needs; the minimal
  permission-group set for adopting (not creating) a tunnel is confirmed and encoded once.
- [ ] A pasted token is verified against Cloudflare's token-verification endpoint and by executing the
  discovery reads before it is persisted or the integration is reported connected.
- [ ] Global API Key authentication is not offered, and a non-token credential fails with a clear error.
- [ ] The token is stored only in a private Core credential store and is masked from all APIs, logs,
  diagnostics, and browser state.
- [ ] Token revocation, expiry, or permission reduction produces `Reconnect required` without deleting
  routes, DNS, or local intent.
- [ ] No eligible healthy remote connector causes a clear pre-mutation failure and no Cloudflare resource
  change.
- [ ] A connector whose reported public origin IP does not match the host's egress IP produces a named
  locality warning before any mutation; external-probe failures while that warning is active are
  classified as likely connector-locality errors.
- [ ] Account/zone/tunnel ambiguity is resolved once in Shell and the selected base domain/tunnel is persisted.
- [ ] A missing Core public origin is configured through a required label and applied through an atomic launch
  settings update plus keep-apps restart, while loopback recovery remains available.
- [ ] Shell remains manually publishable through its system-app Public origins panel.
- [ ] With the remote provider connected, entering `media` previews and creates
  `https://media.<base-domain>`; full/cross-zone URL entry is unavailable.
- [ ] Every `public: true` endpoint in one app popup is validated before any mutation; duplicate submitted
  labels fail the entire operation.
- [ ] Hostname uniqueness checks include Hosty publications, exact zone DNS records, and selected-tunnel
  ingress rules. Existing unowned objects block save unless explicitly adopted.
- [ ] Hosty identifies ownership by app endpoint and exact hostname, never by local port.
- [ ] An existing Hosty-owned hostname updates its route target when the assigned local port changes without
  changing the public URL.
- [ ] Exact proxied CNAME records point only Hosty-owned names at `<tunnel-id>.cfargotunnel.com`; unrelated
  DNS records and wildcard records are untouched.
- [ ] Tunnel read-modify-write preserves every unrelated ingress rule, path, origin request, global option,
  unknown JSON field, relative order, and final catch-all semantics.
- [ ] A popup produces at most one successful tunnel-configuration PUT and verifies the returned state.
- [ ] A Dashboard change completed before a Hosty operation is read and preserved by that operation.
- [ ] Remote/local partial failure records an exact failed stage, preserves retryable intent, and performs only
  ownership-safe compensating rollback.
- [ ] Generic app configure cannot bypass remote-provider synchronization for managed public-origin settings.
- [ ] A successful change persists `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>`; a running app shows `Restart required`
  and a stopped app receives it on first start.
- [ ] Missing configured origins for public endpoints create deduplicated host-admin warnings without blocking
  install/start/local operation.
- [ ] DNS, tunnel, connector, stopped-origin, app-response, and Cloudflare/origin `5xx` failures are reported as
  distinct states; `401`/`403` count as externally reachable application responses.
- [ ] Removing a manifest endpoint removes only its Hosty-owned DNS/route during reviewed update apply.
- [ ] Uninstall review lists Hosty-owned publications; confirmed uninstall removes them before app ownership
  state is deleted, and cleanup failure leaves a retryable installed record.
- [ ] Disconnect offers Keep or Remove Hosty resources, defaults to Keep, and never deletes dashboard-owned
  objects. Remove deletes the stored token only after every owned deletion succeeds; a failed deletion halts,
  preserves the token and remaining ownership, and reports a retryable error. Completed disconnect directs the
  administrator to dashboard revocation.
- [ ] The existing local `cloudflared` provider continues to behave as documented until explicitly migrated.
- [ ] Core, CLI, Shell, mixed-owner round-trip, lifecycle, and regression tests pass.

## Deliverables

- [ ] Core token connection flow: template URL construction, paste/verify API, and private credential store.
- [ ] Cloudflare API client for token verification, discovery, tunnel config, DNS, and connector status.
- [ ] Persistent Cloudflare connection/publication ownership store and migration boundary.
- [ ] New `cloudflare-remote` provider and legacy-provider coexistence/migration behavior.
- [ ] Pass-through tunnel configuration patcher with mixed-owner preservation tests.
- [ ] Publication operation state machine, API, idempotency, rollback, and read-back verification.
- [ ] Core/Shell launch-origin apply/restart integration through the managed CLI.
- [ ] Lifecycle cleanup integration for endpoint removal, app update, uninstall, disconnect, and port changes.
- [ ] Warnings, deduplicated notifications, health checks, and reconnect behavior.
- [ ] Provider-aware Shell connection card (template link plus token paste), platform status, public-origin
  editor, status/progress, conflict adoption, restart, and disconnect UI.
- [ ] Core/CLI/Shell unit, API, integration, security, and regression tests.
- [ ] CI/release wiring and updated feature/API/security/local-development/repository-release documentation.

## Technical Design

### Provider And State Boundaries

Keep provider `cloudflared` unchanged for the locally managed config-file implementation. Add persisted
provider identity `cloudflare-remote`; it never writes/removes local tunnel files and never derives hostnames
from app IDs during start.

Add `CloudflareIntegrationStore` under the private Core data root for non-secret state:

- connection status and reconnect reason;
- account ID/name;
- zone ID/name/base domain;
- tunnel ID/name and last connector status;
- last observed tunnel configuration version;
- per-publication app ID, endpoint key, label, hostname, DNS record ID, last applied local service URL,
  ownership/adoption state, requested intent, sync state/error, and timestamps;
- resumable publication-operation stage and rollback snapshot references.

Add a separate `CloudflareCredentialStore` for the API token value and its non-secret metadata (token ID,
name, optional expiry). Use owner-only directory/file permissions through `SecureFileSystem`, atomic
writes, masked projections, explicit deletion, and log redaction. Connector tokens are not fetched or
stored; the existing connector remains externally owned.

### Token Connection

Connection starts in Shell with two artifacts produced by Core:

1. a prefilled Cloudflare token template URL (`permissionGroupKeys` plus a suggested token name such as
   `Hosty <hostname>`) that opens the token-creation form with exactly the required permission groups;
2. a paste form posting to a host-admin/CSRF-protected connect endpoint.

On paste, Core verifies the token and executes the discovery reads (accounts, zones, tunnels, connectors)
to prove the granted permissions, then persists the token in `CloudflareCredentialStore` only after both
succeed. Verification must not assume a user-owned token: the phase-0 spike confirmed the template flow
produces an **account-owned** token, which returns `Invalid API Token` from `GET /user/tokens/verify` and
must instead be checked with `GET /accounts/{account_id}/tokens/verify` — so Core proves validity by a
resource probe (e.g. `GET /accounts`) first, then calls the account-scoped verify for status/expiry once
the account id is known. Do not assume a fixed token length (the spike's account token was 53 chars, not
the 40-char user-token length). The token is never echoed back to Shell, stored in browser state, or
logged. Verification failure reports which capability was missing so the administrator can adjust the token
in the dashboard and retry.

Every later Cloudflare call classifies `401`/`403` as an authorization failure: status changes to
`Reconnect required`, all non-secret ownership/intent is retained, and no cleanup runs automatically.
Reconnect verifies that retained ownership still points at the selected account/zone/tunnel before
resuming. The minimal permission-group set for adopting (not creating) a tunnel is confirmed during
implementation against Cloudflare's permission-group listing and encoded once in the template URL builder.

### Discovery, Selection, And Connector Locality

Connection performs:

1. token verification and permission probing;
2. account and active zone discovery;
3. remotely managed (`config_src: cloudflare`) tunnel discovery;
4. connector status read;
5. connector locality check;
6. automatic selection only when exactly one eligible choice exists;
7. explicit account/zone/tunnel selection otherwise;
8. no mutation until a healthy connector and Core-origin requirements are satisfied.

The locality check compares each connector's reported public origin IP (from the tunnel connections API)
with the host's egress IP observed through a Cloudflare-owned trace endpoint. A mismatch raises a named
`connector_not_local` warning before selection is confirmed: tunnel routes will target this host's
loopback services, so a connector on another machine would forward public traffic into the wrong host.
NAT can mask a real mismatch in either direction, so the warning is advisory; the end-to-end verification
stage of the first publication is the definitive proof, and its external-probe failures are classified as
likely connector-locality errors while the warning is active.

Because the egress-IP lookup is an external network call feeding only an advisory warning, it must never
block connection. The lookup is wrapped so any failure other than cancellation is logged and the check
degrades to `locality_unknown` — connection proceeds and the definitive end-to-end probe still runs. Only a
successful lookup that actually disagrees with the connector IP produces `connector_not_local`.

The comparison must be dual-stack. The phase-0 spike's connector reported an **IPv6** `origin_ip`
(`2001:…`), so comparing it against an IPv4-only egress lookup would always mismatch and raise a false
`connector_not_local`. Compare the connector's address family against the matching-family egress address,
and when the host and connector advertise different families with no overlap, degrade to `locality_unknown`
rather than declaring a mismatch — the end-to-end probe remains the definitive proof.

### Core And Shell Public Origins

The connection wizard reads current Core/Shell launch origins. If Core has no verified public origin, it
requires a DNS label (default suggestion `core`) and includes the Core loopback service in the first
publication mutation.

Add a Core/CLI launch-settings helper that atomically updates `HOSTY_CORE_PUBLIC_ORIGIN` and, when changed,
`HOSTY_SHELL_PUBLIC_ORIGIN` through `LaunchSettingsStore`, then performs the existing detached
`core restart --keep-apps`. Core exposes this only through a host-admin/CSRF-protected operation and returns
restart/reconnect status to Shell. Failure leaves loopback access and the remote publication intact for retry.

Shell's system-app public endpoint uses the ordinary app panel. Successful synchronization updates both its
app public-origin setting and the Shell launch origin. Core is light-restarted first; Shell then offers its
normal explicit app restart so environment/session behavior adopts the new origin. No unrelated runtime app
is restarted.

### Publication API And Operation Model

Add a purpose-built host-admin/CSRF-protected public-origin API. One request contains the full desired label
map for the app's current public endpoints plus explicit adoption confirmations. Generic configure continues
to handle unrestricted origins for provider `none`/legacy behavior, but rejects direct managed-origin writes
with `public_origin_managed` while `cloudflare-remote` is active.

The API creates a durable operation and returns an operation ID. Shell polls Core for these stages:

1. authorization verified;
2. hostname/ownership checked;
3. DNS change prepared;
4. tunnel configuration synchronized;
5. local origin applied;
6. connector/external endpoint verified;
7. completed, restart required, app stopped, or failed.

Requested labels are durable before remote calls, so retries after browser/Core interruption resume by
observing Cloudflare and local state. Only one publication mutation per selected tunnel runs at a time.

### Hostname Validation And Ownership

Normalize labels to lowercase and require one valid single DNS label. Construct the origin only under the
selected zone. Before mutation, validate the whole popup against:

- duplicate labels in the submitted app;
- other Hosty publication records;
- exact DNS records in the selected zone;
- exact selected-tunnel ingress hostnames;
- an existing owned route whose current value no longer matches the ownership snapshot.

A free hostname may be created. A hostname owned by the same app endpoint may update its service. Any unowned
exact object blocks with its current destination when available. **Adopt** requires explicit confirmation,
is allowed only after reread, records the existing IDs/value, and never changes an unrelated hostname merely
because it targets the same local port.

### Tunnel Configuration Mutation

Fetch the latest configuration for every operation. Patch it as a pass-through `JsonNode` document (or an
equivalent extension-data-preserving representation) so unknown/new Cloudflare fields survive. This is not a
hypothetical safeguard: the phase-0 spike's tunnel configuration carried a top-level `warp-routing` key
alongside `ingress`, so a narrow ingress-only serialization would silently drop the operator's WARP routing.
Preserve every top-level key and every `originRequest`/global option verbatim. For the submitted app
endpoints only:

- update a same-hostname owned rule's `service` when the local assigned URL changes;
- insert new exact rules before any overlapping wildcard/final catch-all rules;
- remove an old owned rule only when its current hostname/service/path still matches the stored snapshot;
- preserve every other array entry and global option in its existing relative order;
- preserve a valid final catch-all.

Submit at most one tunnel configuration PUT for a successful popup operation. Read it back and compare both
the desired Hosty projection and a pre-write fingerprint/projection of unrelated rules/global options.
Cloudflare documents no expected-version/ETag precondition, so Hosty serializes its own writes, minimizes the
GET/PUT window, and treats a truly simultaneous Dashboard write as an accepted provider race. Ordinary
Dashboard edits completed before Hosty starts are always read and preserved.

### DNS And Compensation

Use one exact proxied CNAME per Hosty hostname, targeting `<tunnel-id>.cfargotunnel.com`, and store the DNS
record ID. Optional Cloudflare comment/tag metadata may aid diagnosis but is not the ownership authority.

Preflight all conflicts before mutation. For removals, remove the exact owned DNS record before deleting the
route so a partial failure leaves at worst an unreachable stale rule. For additions/updates, prepare the
ingress target before creating/patching DNS so public traffic never points at a missing intended route. Mixed
popup operations still converge through one final tunnel document.

On failure, compensation rereads current state and reverses only objects that still match the just-applied
Hosty snapshot. It never restores an old full document over newer dashboard changes. Requested intent and
the failed stage remain for Retry.

Persist `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` only after DNS and route read-back succeed. A running app then shows
`Restart required`; a stopped app uses the setting on first start. A later install-time port reassignment
marks the publication pending and updates the same hostname's service target automatically.

### Health, Warnings, And Notifications

Connection/status reads distinguish token authorization, zone/DNS, tunnel configuration, connector,
origin-service, and external HTTPS health. A stopped app with synchronized resources is `App stopped`, not a
Cloudflare error. For running apps, accept `2xx`, `3xx`, `401`, and `403` as reachable application responses;
classify DNS, tunnel/connector, Cloudflare `5xx`, and origin `5xx` separately.

While `cloudflare-remote` is connected, every public endpoint without a configured publication creates one
deduplicated host-admin warning and app-card badge. Clearing a public endpoint replaces any unhealthy-route
warning with the expected `Not configured` warning; it does not block local lifecycle. Successful publish or
removal of the endpoint contract resolves the warning.

### Lifecycle Cleanup And Disconnect

- Reviewed app update/runtime switch lists publications for removed endpoints and deletes their owned DNS and
  route before committing the endpoint removal. Cleanup failure blocks apply and leaves ownership retryable.
- Uninstall review lists owned publications. Confirmed remove deletes them before deleting the app record;
  failure leaves the app installed/stopped with a cleanup error and Retry.
- Renaming a publication removes the old owned pair and creates the new pair in one durable operation.
- Disconnect offers **Keep published routes** (default) or **Remove Hosty routes**. Keep deletes the stored
  token but retains non-secret ownership and local origins for later reconnect. Remove deletes only verified
  owned objects and deletes the token **only after** every owned deletion succeeds; if any remote deletion
  fails, the operation halts, preserves the still-valid token and the remaining ownership records, and
  surfaces a retryable cleanup error. Deleting the token while owned resources remain would orphan them,
  because Hosty would have lost the authorization needed to remove them. Dashboard-owned objects are never
  removed. In both outcomes Shell directs the administrator to revoke the token in the Cloudflare dashboard
  once disconnect completes, because the scoped token cannot revoke itself.
- Token revocation or permission reduction never performs cleanup automatically.

### Legacy Provider Migration

The current `cloudflared` setting and local file behavior remain intact. Connecting `cloudflare-remote` from
`none` does not touch local files. Switching from legacy `cloudflared` is an explicit migration:

1. discover a remotely managed target tunnel;
2. map existing valid `HOSTY_PUBLIC_ORIGIN_*` values under the selected zone to labels;
3. validate/adopt or create exact DNS/routes;
4. verify remote state;
5. activate `cloudflare-remote` and stop legacy reconciliation;
6. remove only the legacy config file bearing Hosty's managed header.

A failed migration leaves the legacy provider/settings/file and existing public-origin values active.

## Risks

- The API token is a long-lived bearer credential granting DNS and tunnel mutation. Keep it in the private
  credential store, mask every projection, redact logs, suggest an expiry in the template flow, and rely on
  dashboard revocation plus reconnect for rotation.
- The administrator can edit or revoke the token at any time; misclassifying the resulting `401`/`403` as a
  sync failure would corrupt diagnostics. Authorization failures must map to `Reconnect required`.
- A connector running on a different host than Core receives routes targeting the wrong loopback. The
  locality heuristic is public-IP based and NAT-blurred, so external verification must classify this failure
  distinctly and keep the warning visible until disproven.
- Whole-document tunnel PUT can damage unrelated routes if serialization is lossy. Use pass-through JSON,
  mixed-owner fixtures, unrelated projections, read-back verification, and ownership-safe compensation.
- DNS/tunnel/local settings/restarts are not one atomic transaction. Durable operation state and observed-state
  retries must converge without claiming false success.
- Simultaneous Dashboard/Hosty saves cannot be made atomic with the documented API. The accepted single-admin
  workflow minimizes this; never overwrite from a cached configuration.
- Changing Core/Shell origins can interrupt browser sessions or CORS/redirect behavior. Keep loopback recovery,
  apply launch settings atomically, and use the existing detached keep-apps restart.
- Cleanup bugs could delete third-party records. Require stored record IDs plus current-value verification and
  explicit adoption; never infer ownership from hostname pattern or port alone.
- External reachability probes may see transient DNS/edge propagation. Retry with bounded backoff and report
  `Propagating` separately from terminal conflict/auth failures.

## Open Questions

None.

## Implementation Phases

### Phase 1 — Token Connection And Discovery

- [ ] Add `CloudflareCredentialStore`, the connect/verify API, and template URL construction with the
  confirmed permission-group set.
- [ ] Add the Cloudflare API client for token verification, accounts, zones, tunnels, and connectors.
- [ ] Add discovery/selection, healthy-connector preflight, and the connector-locality check.
- [ ] Add negative security tests: masking, redaction, revoked tokens, and missing permissions.

### Phase 2 — Remote Provider And Preservation-Safe Reconciliation

- [ ] Add connection/publication stores and `cloudflare-remote` provider.
- [ ] Add Cloudflare DNS/tunnel clients, pass-through mutation, ownership/adoption, rollback, and read-back.
- [ ] Add mixed Dashboard/Hosty fixtures and concurrency/idempotency tests.

### Phase 3 — Publication Lifecycle And Platform Origins

- [ ] Add durable public-origin operation API and generic-config managed guard.
- [ ] Integrate install-time targets, app restart-required state, port-change resync, update/uninstall cleanup,
  and disconnect choices.
- [ ] Add Core/Shell launch-origin apply helper and keep-apps restart integration.
- [ ] Add health classification, warnings, and notifications.

### Phase 4 — Shell Product Workflow

- [ ] Add the Platform Cloudflare connection card: template link, token paste, selection, status, reconnect,
  and disconnect.
- [ ] Add provider-aware label/suffix editor, conflict/adoption UX, progress stages, badges, and restart actions.
- [ ] Add Core/Shell origin workflow and local recovery messaging.
- [ ] Add Shell tests for all connected/disconnected/stopped/error states.

### Phase 5 — Migration, Documentation, And End-To-End Verification

- [ ] Add explicit legacy-provider migration and rollback tests.
- [ ] Update feature/API/security/local-development/repository-release documentation.
- [ ] Validate token connect/reconnect/revoke, existing tunnel adoption, dashboard coexistence, stopped-app
  publication, restart, cleanup, and failure recovery against a real Cloudflare test account/tunnel.

## Verification

- `npm run core:build`
- `npm run core:test`
- `npm run cli:build`
- `npm run cli:test`
- `npm run shell:lint`
- `npm run shell:test`
- `npm run shell:build`
- `npm run check-versions`
- `npm run ci`
- Core-managed Shell and Demo App install/start/publication verification.
- Token paste verification, missing-permission, revocation, and reconnect tests against a real scoped token.
- Real remotely managed tunnel test with pre-existing Dashboard routes before and after Hosty saves.
- Exact DNS create/update/rename/delete/adopt conflict test under a shared base domain.
- Stopped never-started app publication followed by first start and explicit restart-required flow.
- Core public-origin apply plus keep-apps restart and loopback recovery test.
- Endpoint removal, uninstall Keep/Remove, disconnect Keep/Remove, API timeout, and partial rollback tests.

## Links

- [One-Click Cloudflare Public Ingress Idea](../ideas/one-click-cloudflare-ingress.md)
- [Install-Time Runtime Port Reservations Plan](install-time-runtime-port-reservations.md)
- [Ingress (Cloudflare Tunnel Provider)](../features/cloudflared-ingress.md)
- [Core Settings](../ideas/core-settings.md)
- [CLI Bootstrap](../features/cli-bootstrap.md)
- [Notifications](../features/notifications.md)
- [Repository And Release Model](../features/repository-release-model.md)
- [Cloudflare API Token Templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare Tunnel Configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update)
- [Cloudflare Tunnel Connections API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get)
- [Cloudflare DNS Record Management](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)

## Notes

- The user approved all remaining product recommendations on 2026-07-14. The same day, the scoped API token
  replaced OAuth as the primary authorization method after verifying Cloudflare's public-client
  distribution requirements (private-by-default clients, permanent domain verification) and refresh-token
  rotation behavior. The OAuth client and callback bridge are deferred, not rejected.
- This plan depends on install-time runtime port reservations for publication before first start. That
  prerequisite is now complete end to end (persistent assignments, install-time allocation, reassignment
  API + Shell UI, and the start-time port-unavailable preflight).
- Approved and moved to `Ready` on 2026-07-14; implementation begins with Phase 1.
- Version changes are evaluated once only when the eventual pull request is prepared for merge.

### Phase-0 spike (read-only, verified against a live account)

A read-only spike ran against a real account and zone before promotion. It confirmed the token-first flow
end to end and produced concrete adjustments now folded into the design above:

- The template flow yields an **account-owned** token: `GET /user/tokens/verify` returns `Invalid API
  Token`; use `GET /accounts/{account_id}/tokens/verify`, and prove validity by a resource probe first. Do
  not assume a 40-char token length.
- Sufficient permission groups were **Argo Tunnel (Legacy) Read+Edit** (the `cfd_tunnel` permission under
  the current dashboard naming; "Cloudflare Tunnel" is no longer a search hit), **DNS Edit**, and **Zone
  Read**. "Connectivity Directory" was not needed for read/discovery.
- Discovery matched the design: exactly one healthy `config_src: cloudflare` tunnel was present (auto-select
  with no prompt), alongside an inactive tunnel that was correctly filtered out.
- The tunnel configuration carried a top-level `warp-routing` key beside `ingress` — proving preserve-unknown
  pass-through is mandatory, not precautionary. The config exposed a monotonic `version`, `originRequest`
  entries, and a final catch-all, with no PUT precondition.
- The connector's `origin_ip` was **IPv6** — the locality comparison must be dual-stack.
- The account already published several proxied `CNAME → <tunnel-id>.cfargotunnel.com` hostnames matching the
  tunnel's ingress rules, so the adoption / hostname-conflict path is exercised on the very first connect,
  not as an edge case.
- No write was performed; the whole-document PUT round-trip and DNS mutations remain to be exercised in
  Phase 2 against a disposable target.

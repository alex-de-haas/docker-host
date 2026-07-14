# One-Click Cloudflare Public Ingress

Status: Promoted
Created: 2026-07-14
Updated: 2026-07-14

## Motivation

The current Cloudflare ingress provider is automation only after an operator has completed a fragile,
terminal-driven setup: create a locally-managed tunnel, locate its credentials JSON, configure DNS,
point Core at an absolute config path, and separately supervise `cloudflared`. This is incompatible with
the common Cloudflare workflow where a remotely-managed tunnel already works and its routes are edited
from the dashboard. In that situation, the local `cert.pem` and `<UUID>.json` files do not exist, so the
current setup fails before Hosty can provide any value.

Public ingress should instead be a product workflow:

1. Select **Connect Cloudflare** in Shell.
2. Create the scoped API token on the prefilled Cloudflare page Shell opens, and paste it once.
3. Let Hosty select the only healthy tunnel and zone automatically; choose once only when discovery is
   ambiguous.
4. Open an installed app's existing Public origins panel and enter a label such as `media`.
5. Review the generated `https://media.<base-domain>` origin and save it.
6. Hosty persists the local origin, configures Cloudflare DNS and the tunnel route, and verifies the result.

After the one-time Cloudflare connection, publishing an eligible endpoint must never require a terminal,
a path to a credential file, YAML editing, or manual DNS and tunnel routes.

## Possible Approaches

### Approach A — Paste a scoped API token from a prefilled template link (recommended MVP)

Cloudflare API tokens are scoped, individually revocable bearer credentials created by each
administrator in their own Cloudflare account. Cloudflare documents token template URLs: Shell opens
`https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=…&name=…` and the token-creation
form arrives prefilled with exactly the permission groups Hosty needs. The administrator reviews the
summary, creates the token, and pastes it into Shell once. Because the credential is created in the
connecting administrator's own account, no shared product-level identity exists: nothing has to be
registered, domain-verified, hosted, or kept available by the Hosty project for connection to work.

On paste, Core verifies the token against Cloudflare's token-verification endpoint, proves the required
capabilities by running discovery, and only then persists the token in a dedicated private credential
store. A later `401` or dashboard revocation changes the integration to `Reconnect required`; it never
deletes DNS, routes, or local publication intent. The legacy Global API Key (email plus unscoped
full-account key) is not offered and not accepted.

The first version adopts an existing **healthy remotely-managed tunnel**. This directly supports operators
who already have a working connector and avoids pretending that Hosty can install an OS service without
platform-specific elevation. Once connected, Core:

- discovers eligible accounts, zones, and remotely-managed tunnels;
- lets the administrator choose a zone and tunnel only when discovery is ambiguous;
- checks connector locality before anything is mutated (see Target Experience);
- reads the current remote tunnel configuration before every update;
- preserves routes it does not own;
- creates exact, proxied CNAME records for Hosty-owned hostnames;
- adds/removes Hosty-owned ingress rules while keeping the final catch-all rule valid;
- turns the administrator's per-endpoint label into an HTTPS origin under the selected base domain;
- synchronizes that explicit intent to the runtime-app `HOSTY_PUBLIC_ORIGIN_*` setting and Cloudflare;
- waits for the tunnel connector and the changed HTTPS URL to become reachable;
- reports a named failed step and attempts compensating rollback instead of exposing raw command output.

Cloudflare connection does **not** publish every app automatically and does not choose hostnames for the
operator. The installed-app Public origins panel remains the source of publication intent. Each endpoint
whose manifest declares `public: true` gets its own label field; Hosty may suggest a label, but nothing is
created until the administrator saves it.

Cloudflare exposes item-level create/update/delete operations for DNS records, but its public remotely
managed Tunnel API exposes ingress rules only as one configuration document: `GET configuration` and `PUT
configuration`. There is no documented item-level public-hostname endpoint. This transport constraint does
not make Hosty the owner of the full tunnel. Each save performs a narrow read-modify-write:

1. fetch the latest tunnel configuration and exact DNS records for the submitted hostnames;
2. validate the complete submitted popup as one mutation set;
3. add, update, or remove only routes owned by the affected Hosty app endpoints;
4. preserve every unrelated route, its order, path, service, `originRequest`, global options, and final
   catch-all rule;
5. submit the reconstructed full configuration once, mutate only the affected DNS records, and read back the
   result for verification.

The implementation must patch the latest configuration as a pass-through JSON document (or preserve
unknown fields through equivalent extension data), not deserialize it into a narrow Hosty-owned model that
could discard newer Cloudflare properties. Verification compares the unrelated route/global-option
projection captured before the write with the returned document as well as checking the intended Hosty
changes.

Core stores Hosty ownership by app endpoint and exact hostname, plus the Cloudflare DNS record ID and last
applied route value. Tunnel ingress rules do not expose stable item IDs. A hostname already present in an
unowned rule or DNS record is a visible conflict and is never overwritten automatically. Existing dashboard
routes and third-party application subdomains remain dashboard-owned and may be changed between Hosty saves;
the next Hosty operation starts from that latest state.

The deployment has one logical administrator, so a dashboard write racing the few seconds between Hosty's
GET and PUT is not an expected workflow. Cloudflare returns a configuration `version`, but the documented
PUT body has no expected-version or ETag precondition, so that rare simultaneous race cannot be made atomic.
It is an accepted provider limitation, not a reason to forbid normal dashboard administration.

Pros:

- No OAuth client, no consent-screen distribution constraints, no hosted callback component, and no
  refresh-token rotation machinery; connection has no dependency on infrastructure operated by the
  Hosty project.
- The prefilled template link removes the permission-picking burden that historically made token
  workflows fragile.
- The token is scoped, revocable from the Cloudflare dashboard, and optionally expiring.
- Fits Cloudflare's recommended remotely-managed model and solves the existing-working-tunnel case
  without replacing its connector.
- No `cert.pem`, tunnel credentials JSON, local YAML, or terminal workflow.
- Can preserve existing dashboard-managed routes.

Cons:

- The administrator leaves Shell for the Cloudflare dashboard once and copies a secret through the
  clipboard.
- The token is long-lived unless an expiry is chosen, so private storage, masking, and log redaction are
  security-critical.
- The scoped token cannot revoke itself; disconnect deletes the stored copy and directs the
  administrator to dashboard revocation.
- The public Tunnel API still requires a whole-document PUT internally, so unrelated-route preservation
  and read-back verification are security-critical.
- A healthy connector remains a prerequisite in the MVP.
- Applying Core/Shell public origins requires a light Core restart because they are launch settings today.

### Approach B — Adopt the tunnel through a public OAuth client with a callback bridge (deferred)

Use Cloudflare's OAuth Authorization Code flow with PKCE against a product-owned public OAuth client and
a minimal Hosty-controlled HTTPS callback bridge (Cloudflare offers no Device Authorization flow). The
sketched handoff keeps secrets local: Core generates state and the PKCE verifier, the bridge stores only
a short-lived single-use authorization result keyed by opaque state and never sees the verifier or
resulting tokens, Core polls and consumes the result exactly once, and Shell polls Core, never the
bridge.

Verification against Cloudflare's documentation on 2026-07-14 surfaced constraints that make this path
substantially heavier than Approach A for the same end state:

- OAuth clients are **private by default**: only members of the Cloudflare account that registered the
  client can authorize it. Every Hosty installation would share the product's baked-in client ID, so any
  third-party installation requires making the client public — permanent domain verification via DNS
  TXT, a logo, and a client URL maintained by the Hosty project.
- The callback bridge would be the first centrally hosted Hosty infrastructure, attaching availability,
  abuse-control, and operating obligations to every self-hosted installation's connect path.
- Cloudflare's OAuth stack rotates refresh tokens and invalidates the entire grant chain when a stale
  refresh token is reused, so Core would need single-flight refresh with atomic persistence of the
  rotated token before first use.

Pros:

- Consent-screen authorization without handling a pasted secret; per-application revocation UX.
- Keeps Cloudflare authorization narrowly scoped without the administrator reading a permission summary.

Cons:

- Domain-verified public client, hosted bridge, and refresh rotation machinery are all mandatory before
  the first third-party installation can connect.
- Everything below the authorization layer is identical to Approach A, so the extra weight buys
  connection UX polish only.

Both approaches end with a bearer credential in the same private credential store, so OAuth can be
layered on later without reworking discovery, reconciliation, ownership, or diagnostics.

### Approach C — Hide the current locally-managed workflow behind a wizard

Install or locate `cloudflared`, run `tunnel login/create`, create the local config, and install an OS
service from Core or the CLI.

Pros:

- Reuses most of the current config renderer.
- Does not require the Cloudflare remote-configuration API after setup.

Cons:

- Browser-based login, OS elevation, service installation, and filesystem permissions still make the
  flow platform-specific and failure-prone.
- It cannot adopt the remotely-managed tunnel that already works for the motivating user.
- Cloudflare documents locally-managed tunnels as an alternative workflow for legacy, testing, and local
  development scenarios rather than the default model.

## Target Experience

The Shell Platform dialog contains one Cloudflare card:

- **Disconnected** — `Connect Cloudflare` opens the prefilled token-creation page and offers one paste
  field.
- **Connected** — selected account, zone/base domain, detected tunnel, connector health, `Sync now`, and
  `Disconnect`.
- **Attention required** — the exact failed stage, a plain-language reason, and `Retry` / `Roll back`.

Connection additionally checks connector locality. Tunnel routes target this host's loopback services, so
a connector running on a different machine would forward public traffic into the wrong host. The tunnel
connections API reports each connector's public origin IP; a mismatch with the host's own egress IP
raises a named warning before anything is mutated. NAT can blur the comparison, so the warning is
advisory and the first end-to-end verified publication provides the definitive proof.

The existing Installed apps → Public origins form becomes provider-aware:

- With no ingress provider, it remains an unrestricted absolute-URL input.
- With Cloudflare connected, it becomes a DNS-label input plus an immutable suffix. Entering `media` shows
  `https://media.example.com`; cross-zone hostnames cannot be entered accidentally.
- Each `public: true` endpoint has its own label, preview, and state: `Not configured`, `Syncing`, `Active`,
  `App stopped`, `Restart required`, or `Error`.
- Hosty reserves runtime ports during installation and exposes endpoint URLs before the first start. Saving
  therefore records durable publication intent and applies Cloudflare DNS and tunnel configuration
  immediately, including when automatic start was disabled. A stopped app may have an active route but is
  shown as `App stopped` until its origin service runs.
- The full `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` value becomes active only after the corresponding remote route
  has synchronized successfully. A failed Cloudflare call keeps the requested label for Retry but does not
  claim that the public origin works.
- Clearing a label removes only the DNS record and route that Hosty owns, then clears the local public
  origin. Pre-existing operator-owned resources are preserved.

The hostname, not the local port, is the conflict and ownership key. Several hostnames may legitimately
target the same service port, and an automatic port may later be reassigned. For each submitted endpoint:

- an unchanged Hosty-owned hostname updates its service target if the assigned port changed;
- a free hostname adds a route immediately before the final catch-all rule and creates an exact proxied
  CNAME to `<tunnel-id>.cfargotunnel.com`;
- a hostname used by another Hosty endpoint, dashboard rule, or exact DNS record is rejected in the form
  before saving, with the current owner/destination shown when available;
- renaming removes the old Hosty-owned route/record and creates the new pair in the same operation;
- deletion proceeds only when the current Cloudflare objects still match the ownership snapshot; otherwise
  Shell asks for explicit adoption or conflict resolution instead of deleting an external change.

When one app popup contains several public endpoints, Core validates all of them first and applies one
tunnel configuration update. The form never partially accepts duplicate hostnames within the app.

During each save, Shell shows product-level stages rather than logs:

1. Cloudflare authorization verified.
2. Hostname and existing records checked.
3. DNS record prepared.
4. Tunnel route synchronized.
5. Local public origin applied.
6. Connector and HTTPS endpoint verified.

The operation is idempotent. Retrying after a browser close, Core restart, API timeout, or partial
Cloudflare success resumes from observed state. Hosty does not report success until Cloudflare returns the
expected configuration, the connector is healthy, and HTTPS probes reach the intended local services.

### Warnings and notifications

When Cloudflare is connected, an unset or unhealthy public origin is visible but does not block local app
operation:

- an installed-app card and its Public origins section show an attention badge for every `public: true`
  endpoint without a configured origin;
- Core emits one deduplicated host-admin notification per affected app after install/start: the app remains
  available locally but the endpoint will not work externally;
- a configured origin whose DNS, remote route, connector, or external probe is unhealthy gets a different
  warning naming the failed layer;
- resolving or intentionally clearing the affected publication resolves the corresponding notification;
- external reachability accepts an intentional application response such as `401` or `403` as reachable;
  it distinguishes those from DNS/tunnel failures and Cloudflare/origin `5xx` responses.

Saving a public origin for a running app does not restart it automatically. The origin is an environment
value, so Shell shows `Restart required` and offers **Restart now**. Under the current dependency contract,
dependent apps receive the dependency's local endpoint URL rather than its public origin, so only the app
whose public origin changed needs a restart. A stopped app receives the value on its next start.

## Existing Feature Conflicts

- The existing provider value `cloudflared` means locally-managed config-file ownership. It must not be
  silently reinterpreted as remote API ownership, because that would break working local tunnels. Introduce
  a distinct persisted provider identity and an explicit migration action; retain the local provider until
  remote migration has been verified.
- Existing persisted app `HOSTY_PUBLIC_ORIGIN_*` values remain active until the replacement remote route and
  DNS pass verification. A failed migration restores their previous values.
- Existing dashboard routes and DNS records are operator-owned. Matching records may be explicitly adopted;
  conflicting records block the operation and are never replaced automatically.
- The current local provider writes and removes a managed `config.yml`, while the remote provider must not
  touch operator files. Switching providers therefore changes both configuration ownership and connector
  launch mode; the UI must show which connector remains responsible before disabling the old provider.
- The current provider overwrites user-entered origins with deterministic generated hostnames on app start.
  The remote provider must remove that behavior: the administrator's saved per-endpoint label is
  authoritative, and start/restart only reconciles it.
- The current automatic-port feature assigns a port only on first start. Immediate publication of a newly
  installed stopped app depends on install-time port reservations; this is tracked separately and must land
  before, or in the same delivery as, the remote provider.

## Risks

- The API token is a long-lived bearer credential granting DNS and tunnel mutation. It must live only in
  the dedicated private credential store, be masked from settings/status APIs and logs, and rely on
  dashboard revocation plus reconnect for rotation.
- The administrator can edit or revoke the token in the dashboard at any time. Cloudflare `401`/`403`
  responses must be classified as authorization failures leading to `Reconnect required`, not as partial
  synchronization errors.
- A connector running on a different host than Core would receive routes pointing at the wrong loopback.
  The locality check is public-IP based and NAT-blurred, so external verification must classify this
  failure distinctly.
- Cloudflare tunnel configuration updates replace the full remote configuration. A preservation bug could
  damage dashboard-managed routes even though the product intent is item-level, so round-trip and mixed-owner
  regression tests are mandatory.
- DNS, tunnel configuration, local origin persistence, and Core restart are not one atomic transaction.
  Rollback is compensating and must distinguish Hosty-created resources from pre-existing resources.
- Changing Core/Shell public origins affects CORS, login redirects, session continuity, and app identity
  redirects. Existing local access must remain available as a recovery path.
- A truly simultaneous dashboard save can race Hosty's read-modify-write because Cloudflare does not
  document an atomic compare-and-swap precondition. The single-administrator workflow makes this unlikely,
  but the UI must keep the mutation window short and verify the resulting document.

## Decisions from Discussion

- **A scoped API token from a prefilled template link is the primary authorization path** (2026-07-14).
  This supersedes the earlier OAuth-primary decision after verification showed that a shared public OAuth
  client requires permanent domain verification plus a hosted callback bridge before any third-party
  installation could connect. OAuth remains a compatible later addition; the legacy Global API Key is
  rejected.
- **No hosted Hosty infrastructure participates in connection.** The OAuth callback bridge is deferred
  together with the OAuth path.
- **The existing healthy remotely-managed tunnel is adopted.** Hosty detects it through the API; when exactly
  one eligible healthy tunnel exists it is selected without a prompt, otherwise Shell asks once.
- **Connector locality is checked before mutation.** Discovery compares the connector's reported public
  origin IP with the host's egress IP and warns by name on mismatch; end-to-end publication verification
  remains the definitive check.
- **Hosty coexists with dashboard-managed routes.** Hosty owns only the exact routes and DNS records created
  or explicitly adopted for Hosty app endpoints. Every save reads the latest Cloudflare state and preserves
  unrelated third-party applications. Dashboard changes between Hosty operations are supported; only a truly
  simultaneous write remains an accepted API limitation.
- **Public origins remain operator-chosen per endpoint.** Hosty never publishes every app automatically and
  never changes an explicit hostname merely because an app starts.
- **The Cloudflare form accepts a label, not a full URL.** The provider-selected zone supplies the fixed base
  domain and Shell previews the resulting HTTPS origin.
- **Exact DNS records are used.** Each published Hosty hostname gets its own proxied CNAME to the selected
  tunnel. Wildcard DNS is not required, and other subdomains under the same base domain remain untouched.
- **Hostname is the uniqueness key.** Hosty never infers route ownership from the local port. A hostname
  already used by another Hosty endpoint, dashboard route, or exact DNS record fails validation unless the
  administrator explicitly adopts it.
- **Missing public origins are warnings, not start blockers.** Local operation remains valid; the warning
  states that external access is unavailable.
- **Saving does not silently restart apps.** Shell reports `Restart required` and offers an explicit restart
  for the changed app. Current cross-app dependency injection uses local endpoint URLs, so no dependent app
  restart is required for a public-origin-only change.
- **Ports exist before first start.** Install-time runtime port reservations make local endpoint URLs
  available as soon as installation completes, so a stopped app can be configured and synchronized without
  a `Pending app start` state.
- **Core and Shell origins use the product workflow.** Connection requires a Core label when no working Core
  public origin exists, suggests `core`, applies the launch setting through a keep-apps restart, and preserves
  local recovery access. Shell remains manually publishable through its system-app Public origins panel.
- **Bearer credentials use a dedicated private Core store.** They do not enter `settings.json`, API
  projections, browser storage, or logs. Disconnect deletes the stored token and directs the administrator
  to revoke it in the Cloudflare dashboard, because the scoped token cannot revoke itself.
- **The MVP requires a healthy existing connector.** If none is available, connection stops before any DNS or
  tunnel mutation; connector installation/supervision is a separate future feature.
- **Cloudflare resource cleanup follows lifecycle intent.** Removed endpoints delete Hosty-owned resources;
  uninstall review lists and removes them after confirmation; disconnect offers Keep or Remove, defaults to
  Keep, and never deletes dashboard-owned resources.

## Open Questions

None.

## Current Recommendation

Replace the current platform setup form with a remotely-managed Cloudflare integration centered on
Approach A: a scoped API token created from a prefilled template link, verified on paste, and stored in a
private credential store. Scope the first vertical slice to an existing healthy tunnel, because that
solves the reported failure without adding OS service installation to the same change. Defer the OAuth
client and callback bridge: they add distribution and hosting obligations to the Hosty project without
changing anything below the authorization layer.

Keep public origin selection in the existing per-app panel. The provider contributes the base-domain
suffix, validation, Cloudflare synchronization, status, and diagnostics; the administrator contributes the
endpoint label. Missing values remain non-blocking warnings, and applying a changed origin offers an
explicit restart of only the affected app.

The idea was promoted after the user approved all remaining recommendations on 2026-07-14; the token-first
authorization decision replaced the earlier OAuth-first recommendation the same day. Shared use of one
tunnel and base domain is an agreed product requirement: Hosty performs narrow hostname mutations and
preserves dashboard-managed applications. The linked Draft planning document is the implementation source
of truth and still requires explicit approval before implementation begins.

## Links

- [Ingress (Cloudflare Tunnel provider)](../features/cloudflared-ingress.md) — current locally-managed
  implementation and its operator-owned setup boundary.
- [One-Click Cloudflare Public Ingress Plan](../planning/one-click-cloudflare-public-ingress.md) —
  implementation source of truth.
- [Install-Time Runtime Port Reservations](install-time-runtime-port-reservations.md) — prerequisite for
  configuring and synchronizing a public origin before an app's first start.
- [Core settings](core-settings.md) — current Shell platform settings surface.
- [CLI bootstrap](../features/cli-bootstrap.md) — launch-owned Core and Shell public origins and Core
  restart mechanics.
- [Cloudflare API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) —
  documented prefilled token-creation URLs (`permissionGroupKeys`).
- [Cloudflare Tunnel configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update) — documented
  whole-configuration PUT contract for remotely managed tunnel ingress.
- [Cloudflare Tunnel connections API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get) — connector metadata
  (including the connector's public origin IP) used for the locality check.
- [Cloudflare DNS record management](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/) — item-level create, partial update, and delete operations.

## Notes

- Cloudflare self-managed OAuth clients launched on 2026-06-03. They are private by default — authorizable
  only by members of the account that registered them — and public visibility requires permanent domain
  verification (DNS TXT), a logo, and a client URL. This distribution constraint is the main reason the
  OAuth path is deferred.
- OAuth scope names correspond to API token permission names, so a later OAuth layer can reuse the same
  permission set chosen for the token template.
- Cloudflare's current API guide names the relevant permissions "Cloudflare Tunnel Write",
  "Cloudflare One Connectors Write", "Cloudflare One Connector: cloudflared Write", and "DNS Write". The
  minimal set for adopting (not creating) a tunnel is confirmed against the template URL during
  implementation.
- Cloudflare's configuration GET/PUT response includes a monotonically changing configuration version, but
  the documented PUT request body contains only `config`; no expected-version or ETag precondition is
  documented as of 2026-07-14.
- DNS record APIs support item-level POST/PATCH/DELETE operations. Remotely managed Tunnel ingress has only
  documented GET/PUT configuration operations, so Hosty's item-level product behavior is implemented as a
  preservation-first read-modify-write over the latest document.
- The tunnel connections API reports each connector's `origin_ip` — "the public IP address of the host
  running cloudflared" — which makes the locality heuristic possible; NAT keeps it a heuristic.
- Single-label hostnames under the zone apex stay within Universal SSL coverage; multi-level subdomains
  would require an Advanced Certificate, which is another reason the form accepts exactly one DNS label.
- This idea intentionally does not describe the current provider as remotely managed. Until implemented,
  the feature document remains the source of truth: Hosty writes a local config and does not call the
  Cloudflare API.

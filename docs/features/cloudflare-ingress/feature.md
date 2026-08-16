# Feature: Cloudflare Ingress

Created: 2026-06-17
Updated: 2026-08-16

Runtime app services listen only on loopback. Ingress is the layer that accepts public traffic,
terminates HTTPS, and routes by hostname to the right loopback port. Core never runs a reverse proxy
itself — it drives an operator-run **Cloudflare Tunnel**, and Cloudflare terminates TLS at its edge.
Hosty never creates a tunnel and never installs or supervises a connector.

Ingress is **one exclusive choice**, `HOSTY_INGRESS_PROVIDER`:

| Value | Shell label | Tunnel | Routes | DNS | Hostnames |
| --- | --- | --- | --- | --- | --- |
| `none` | Disabled | — | — | — | the operator sets `HOSTY_PUBLIC_ORIGIN_*` by hand |
| `cloudflare-remote` | Cloudflare | remotely managed | Core PUTs the tunnel config over Cloudflare's API | Core creates one exact proxied CNAME per hostname | the operator picks a label per endpoint |
| `cloudflared` | Cloudflare Tunnel (local config) | locally managed | Core renders `config.yml`; the operator runs `cloudflared --config` | the operator adds one wildcard CNAME, once | derived `{subdomain}.{baseDomain}` for every running app |

The two Cloudflare values are not alternatives in name only: a Cloudflare tunnel is either locally or
remotely managed, never both, and the connect flow filters locally-managed tunnels out as ineligible.
Exactly one mechanism owns an app's public origins at a time, which is what keeps a published label from
being overwritten by a derived hostname on the app's next start.

## Providers

The provider, base domain, tunnel ID, and credentials file are live Core settings: edit them from Shell's
**Settings → Ingress** tab, or set the environment variables as the baseline. A persisted setting wins over
its env var. Only the `config.yml` output path is launch-only.

| Env var / setting | Meaning |
| --- | --- |
| `HOSTY_INGRESS_PROVIDER` | `none` (default), `cloudflare-remote`, or `cloudflared`. |
| `HOSTY_INGRESS_BASE_DOMAIN` | **`cloudflared` only.** Base domain for derived hostnames, e.g. `example.com`. |
| `HOSTY_INGRESS_TUNNEL_ID` | **`cloudflared` only.** Cloudflare Tunnel UUID. |
| `HOSTY_INGRESS_CREDENTIALS_FILE` | **`cloudflared` only.** Path to the tunnel credentials JSON. |
| `HOSTY_INGRESS_CONFIG_PATH` | **Env-only.** Where Core writes `config.yml` (default `<data>/core/ingress/config.yml`). |

Under `cloudflare-remote` the connected zone supplies the base domain and connect discovers the tunnel, so
the three local-config fields are neither read nor shown. Saving applies live in both directions: switching
away from `cloudflared` removes the `config.yml` Core wrote, so an operator-run `cloudflared` stops serving
the stale routes rather than merely stopping to receive updates.

`GET /api/core/status` carries a warning when the selected provider is not ready — a `cloudflared` provider
missing its domain, tunnel, or credentials file, or a `cloudflare-remote` provider with no stored
connection. Selecting a provider before it is usable is a legitimate intermediate state, not a save error.

A host that connected a Cloudflare token while the provider was still `none` — the only thing an operator
could do before this was a provider — is moved to `cloudflare-remote` once, at boot
([CloudflareProviderMigration.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareProviderMigration.cs)).
That is derived from persisted state rather than guessed: storing a connection has no other purpose. Any
other provider value is left alone.

## Who owns a public origin

The provider decides who writes `HOSTY_PUBLIC_ORIGIN_<KEY>`, and therefore which surface may edit it
([PublicOriginOwnership.cs](../../../apps/core/src/Haas.Hosty.Core/PublicOriginOwnership.cs)):

- **`none`** — the operator. The free-form URL field in the app's Public origins tab is editable and is the
  only surface.
- **`cloudflare-remote`** — the publication, for the endpoints that have one. An endpoint with no
  publication stays operator-editable, because fronting one endpoint with your own proxy while publishing
  another is a legitimate arrangement.
- **`cloudflared`** — the derivation, for every public endpoint.

`POST /api/apps/{id}/configure` enforces this rather than trusting the client: a write that *changes* a
managed `HOSTY_PUBLIC_ORIGIN_*` is refused with `public_origin_managed` (409). An unchanged resend passes,
and blank counts as unset — the settings form posts every field, including origins that have no value yet.
Shell renders the same rule as a read-only field explaining whether the value is derived or published.

## Local provider (`cloudflared`)

Single-level subdomains only, so everything stays under one wildcard CNAME and certificate:

- one public endpoint → `{subdomain}.{baseDomain}`;
- several public endpoints → `{subdomain}-{endpoint}.{baseDomain}`;
- `{subdomain}` defaults to the sanitized app id, overridden per app with `HOSTY_INGRESS_SUBDOMAIN`;
- Core is seeded as `core.{baseDomain}` → its own port.

For each public endpoint Core persists `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` **before start**
([`EnsureIngressPublicOriginsAsync`](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)), so
the existing settings → environment pipeline injects it. The host is deterministic, so this does not wait
on the runtime port.

Core re-renders the whole `config.yml` declaratively on every start, stop, restart, port reassignment and
remove, on settings save, and once at startup. Because Core knows each app's actual loopback port, dynamic
ports need no operator action. `cloudflared` hot-reloads the file. Rendering is best-effort: a write failure
is logged and never fails the lifecycle operation. An operator-authored config that Core did not write is
left alone.

### Setup (one time)

Using a placeholder domain `example.com`:

1. **Create a tunnel.** `cloudflared tunnel create hosty` → note the UUID and credentials file.
2. **Add one wildcard DNS record.** CNAME `*.example.com` → `<UUID>.cfargotunnel.com`, proxied. Universal
   SSL covers `*.example.com` at a single subdomain level — this is why hostnames are single-level. No
   per-app DNS changes are needed.
3. **Point Core at the tunnel**, from Settings → Ingress or the environment variables above.
4. **Run the tunnel against the Core-written config** (do not hand-edit it):
   `cloudflared tunnel --config <data>/core/ingress/config.yml run`.
5. **Verify.** Install and start an app, then open `https://<app>.example.com`.

## API provider (`cloudflare-remote`)

### Connection

An administrator pastes one scoped API token into the **Cloudflare connection** card on Settings → Ingress
([cloudflare-connection-card.tsx](../../../apps/shell/src/app/shell/pages/cloudflare-connection-card.tsx)),
which posts it to `POST /api/core/cloudflare/connect` (admin session + CSRF).

Verification is a resource probe, not a token endpoint: the template flow yields an **account-owned** token,
and `GET /user/tokens/verify` rejects those, so Core proves the token by running the discovery reads and
only then calls the account-scoped `GET /accounts/{id}/tokens/verify` — best-effort, purely to harvest the
token's name and expiry ([CloudflareConnection.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareConnection.cs)).
The token is persisted only after both succeed. `401` and `403` are classified apart so a valid token with
missing permissions reads differently from an invalid one.

The token lives in an owner-only `cloudflare-credential.json` beside the core root and is masked to
first-four/last-four everywhere it is projected
([CloudflareCredentialStore.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareCredentialStore.cs)). It
never enters `settings.json`, an API response, or a log line.

Shell links to Cloudflare's token page and lists the permissions to grant as text. The link is a plain
dashboard URL rather than a prefilled template: Cloudflare's `permissionGroupKeys` parameter has no
documented key for the tunnel permission, and prefilling two of three while silently dropping the one that
is hard to find would be worse than none. The tunnel permission is therefore named the way the dashboard
names it — **Argo Tunnel (Legacy) · Edit** — because searching the token editor for "Cloudflare Tunnel"
finds nothing. The other two are Zone · DNS · Edit and Zone · Zone · Read.

### Discovery and selection

Connect discovers the account, zone (which supplies the base domain), tunnel, and connectors. A tunnel is
eligible only when it is remotely managed and healthy. A single candidate is selected automatically; more
than one answers `409` carrying the candidates, and Shell asks which to use and repeats the connect with the
answer. A selection that no longer matches anything re-asks with the current list rather than failing
opaquely. Zero candidates is a `cloudflare_no_*` error. The resolved selection is persisted in
`cloudflare-integration.json`.

Discovery also compares the connector's reported `origin_ip` against the host's egress IP (observed through
`https://one.one.one.one/cdn-cgi/trace`) and records a `local` / `not_local` / `unknown` verdict. The
comparison is dual-stack, because a connector's reported address is frequently IPv6. The verdict is
re-observed immediately before every publish, not only at connect — a connector can be moved long after the
token was pasted. It is advisory throughout: a `not_local` publish succeeds and reports the verdict, which
Shell surfaces as a warning that the address reaches a different machine.

### Publication

`POST /api/apps/{appId}/public-origins/publish` takes an endpoint key and a single DNS label; the hostname
is `{label}.{baseDomain}`. Shell renders this as a label field with the base domain fixed beside it and a
live `→ https://…` preview
([public-origin-control.tsx](../../../apps/shell/src/app/shell/pages/public-origin-control.tsx)).
The control appears only under this provider — under any other one Core refuses with
`cloudflare_provider_inactive` — and stays visible, explaining itself, when no token is connected yet.

The same endpoint and the same field are how a publication is **renamed**. The label stays editable after
an endpoint is published, and the dialog's one primary button follows what is in it: it reads `Reapply`,
enabled, only when the label is unchanged *and* the route is `origin_drifted`; in every other state it
reads `Rename`, enabled once the field holds a label that differs from the published one. There is no
separate rename request, because a rename *is* a publish of an endpoint that already has one. Reapply is
the single special case so that a healthy publication does not present a greyed-out repair it does not
need, and does not hide renaming behind an operator guessing that the field is editable.

**Creating a publication is gated on the provider; removing one is not.** A stored publication outlives a
provider change, so unpublish, the uninstall and update cleanups, and disconnect-with-Remove all keep
working after the operator switches to `none` or `cloudflared`. Gating removal too would mean the only way
to clean up is to switch the provider back first, and an app uninstalled in the meantime would leave a live
route behind.

One publish performs two remote mutations, route first, then DNS:

1. read the tunnel's current configuration and PUT it back with the app's rule inserted;
2. create or update an exact proxied `CNAME` → `{tunnelId}.cfargotunnel.com`.

The patcher is pass-through
([CloudflareTunnelConfigPatcher.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareTunnelConfigPatcher.cs)):
it deep-clones the document, updates only a matched rule's `service` (keeping its `originRequest`), inserts
a new rule *before* the catch-all, and never matches or deletes the catch-all itself. Unknown top-level keys
survive because the document is carried as an opaque JSON object — load-bearing rather than precautionary,
since a real tunnel config carries `warp-routing` beside `ingress`.

After the PUT, Core reads the configuration back and compares the projection of everything it did not intend
to touch — on a rename that projection also excludes the old hostname, which was removed on purpose; a
mismatch fails with `cloudflare_readback_unrelated_changed`. If the DNS step then fails, the rollback
reverses only what this operation changed.

A rename runs those same two steps for an endpoint that is already published, and that is what makes it
gapless. The old hostname's rule is removed in the *same* PUT that inserts the new one, so no moment exists
with both routes or with neither, and the DNS step updates the stored record id rather than creating one —
the record is renamed and keeps its id, and an `adopted` publication stays adopted across the rename. The
alternative an operator would otherwise be left with, unpublish then publish, is not the same operation: it
deletes the DNS record and creates a new one, leaving a window in which the hostname resolves to nothing.
For an adopted publication it is worse still, since unpublish deliberately leaves the adopted record in
place while dropping the publication — republishing under a new label then meets the foreign-record path
again, and the old record is left pointing at a tunnel that has no route for it.

**A failed rename puts the old route back.** Rolling back a first publish only has to remove what it added,
but a rename has also *taken something away* by the time DNS runs, so removing the new rule alone would
leave the endpoint with no route at all while DNS still resolves the old hostname — worse than the state it
started from. Core therefore captures the old rule verbatim before removing it and restores it in the same
PUT that removes the new one, one document write for both halves so the undo cannot itself open the window
it is closing. Verbatim matters: rebuilding the rule from hostname and service would drop a per-rule
`originRequest` the operator had tuned, so `RestoreIngress` re-inserts the captured node.

**A rename cannot adopt.** Adoption points a publication at a record Hosty did not create; on a rename the
publication already owns one under the old hostname, so taking over a foreign record at the new hostname
would strand the old one — the exact outcome renaming in place exists to avoid. A rename onto a hostname
that already carries a foreign DNS record is therefore refused outright with `cloudflare_hostname_conflict`,
before any mutation and regardless of `adopt`; the message names both hostnames and says to remove that
record in Cloudflare or choose another label. The check is scoped to renames: re-publishing under the
*unchanged* label never consults it, so a hand-made duplicate record at the endpoint's own hostname cannot
turn Reapply — the repair for a drifted route — into a conflict. Shell shows this error plainly rather than
with the adoption hint, which belongs only to a first publish where adoption is actually on offer.

Ownership is keyed by hostname, never by local port, and is stored per `(app id, endpoint key)`. A hostname
already held by another Hosty endpoint fails `cloudflare_hostname_owned` (409) and is never overwritten. A
pre-existing foreign DNS record fails `cloudflare_hostname_conflict` (409) — and can be **adopted**: the
operator repeats the publish with `adopt`, and Hosty takes over the existing record, marking the publication
`adopted`. Adoption is never implied, because an unasked-for takeover would let a typo point someone else's
hostname at a local app. An adopted publication keeps that state across re-publishes, so a later unpublish
never deletes a record Hosty did not create.

A successful publish writes `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` on the app record. Nothing is restarted as a
side effect; a running app keeps serving its previous address, which Shell reports with a **Restart now**
action on the success toast. Host administrators also receive a notification per publish outcome.

Publication runs only on request. There is no timer and no background reconciliation.

### Publication state

`GET /api/apps/{appId}/public-origins` reports a state per endpoint: `active`, `app_stopped`,
`restart_required`, `origin_drifted` (the endpoint's local port moved and Core could not push the new
target, so the hostname still routes to the old one — see
[Public Origins](../public-origins/feature.md)), or `error` (the stored token stopped working, so the
publication cannot be verified or changed). An endpoint with no publication has no summary, which is
`not_configured`. There is no `syncing` state — publishing is synchronous, so nothing could produce it.

`restart_required` comes from a `PendingRestart` flag recorded when a publish or unpublish lands on a running
app and cleared the next time that app starts. Core cannot observe a running app's environment and an app
record carries no start time, so this is the only honest answer to "is the new address live yet?".

### Cleanup

Explicit unpublish deletes the owned DNS record (tolerating an already-deleted one), removes the tunnel
route, drops the stored publication, and clears the setting. An adopted record is left in place; only the
route goes.

The same cleanup runs on **uninstall** and when an **update** drops an endpoint that used to be public.
Both are best-effort and neither can fail the operation that triggered it. A removal that fails keeps its
stored publication, because that entry is the only remaining pointer to what is left in Cloudflare — the
diagnostics below then surface it. The uninstall preflight lists the hostnames that will go offline,
distinguishing an adopted record (kept) from an owned one (deleted).

**Disconnect asks Keep or Remove.** Keep leaves every published route and record exactly as it is, so
reconnecting the same account picks up where it left off. Remove deletes them first — and if any deletion
fails, the connection is kept and `cloudflare_disconnect_incomplete` (409) is returned, because the token is
the only means of finishing the job. Either way the local token copy is deleted; a scoped token cannot
revoke itself, so the operator is directed to the dashboard.

### When the token stops working

Cloudflare pushes nothing, so a revoked, expired, or permission-reduced token is discovered on the next call
that uses it. That call records `reconnect_required` with a reason and answers
`cloudflare_reconnect_required` (409); every later publish answers the same without another round trip.
Nothing is deleted — routes, DNS records, stored publications, and the discovered account all survive — so
reconnecting a fresh token with the same permissions restores the whole setup.

### Diagnostics

`GET /api/core/cloudflare/diagnostics` compares what Hosty believes it published against what Cloudflare
actually serves, and reports per publication:

| State | Meaning |
| --- | --- |
| `ok` | route and DNS record match |
| `app_missing` | the owning app was uninstalled without the cleanup finishing |
| `endpoint_missing` | the app is installed but no longer declares that endpoint public |
| `route_missing` | the tunnel has no route for the hostname, so it resolves to nothing |
| `route_stale` | the route forwards to a local URL the endpoint no longer has, e.g. after a port reassignment |
| `dns_missing` / `dns_foreign` | the record is gone, or points somewhere other than this tunnel |
| `unknown` | the comparison could not run |

The comparison is keyed by `(app id, endpoint key)` rather than by app id, which is what makes
`endpoint_missing` and `route_stale` visible at all. DNS is matched on content rather than record id, so an
operator who recreated a record by hand still reads as `ok`. It mutates nothing: a background writer would
fight the operator's own dashboard changes.

Stored publications are reported even when the comparison cannot run — under `none`, or with no connection —
with state `unknown`. That is the case that matters most: switching the provider away retracts nothing, and
an operator who reads "ingress is off" and believes their apps are no longer exposed is wrong until they
unpublish. Shell turns that list into a warning naming each hostname that is still live.

The same response lists public endpoints with neither a publication nor an operator-set origin — declared
reachable from the internet and reachable from nowhere. That half needs no Cloudflare connection, so it is
answered under every provider. Shell renders both on the Ingress tab.

#### Core's own address

The response also reports Core's own hostname, under the same state vocabulary plus `not_configured` (no
`HOSTY_CORE_PUBLIC_ORIGIN`, so Core answers on loopback) and `external` (a hostname outside the connected
zone — someone else's proxy fronts it, which this tunnel has nothing to say about). It carries the two
objects the operator must create by hand: the proxied `CNAME` target `{tunnelId}.cfargotunnel.com`, and the
tunnel rule's service `http://localhost:{corePort}`.

This is a hint, not a publication. Nothing in Hosty creates or owns Core's route or DNS record — the
publication endpoints are app-scoped and Core is not an app — so every verdict here ends in something the
operator does themselves. It exists because that gap was previously invisible: an operator publishes every
app in two clicks and is never told that the host's own address, which invitation links and the native
client are built from, is the one thing left to do by hand. There is deliberately no `route_stale` check for
Core: its port is a launch setting rather than something the allocator moves, and `http://127.0.0.1:7070`
against an expected `http://localhost:7070` would report drift that is not drift.

## Platform origins

Core's own public origin is a CLI launch setting (`HOSTY_CORE_PUBLIC_ORIGIN`), displayed read-only in Shell.
It cannot be published through the API path: the publication endpoints are app-scoped and Core is not an app.
See [plan.md](plan.md) for why that is still open and what it is blocked on. The local provider does seed a
`core.{baseDomain}` route into `config.yml`, but that creates no DNS record and persists no launch setting.

Shell is publishable, but only because it is an ordinary app whose `web` endpoint is `public: true` — there
is no special handling for publishing the Shell you are currently using.

The `hosty` CLI has no ingress or Cloudflare commands.

## Security and limitations

- Only endpoints declared `public: true` are exposed; every other port stays on loopback.
- The tunnel is a pure L7 router: it terminates TLS and forwards plain HTTP to loopback with
  `X-Forwarded-Proto: https`. It does **not** inject Hosty auth or forward Hosty session cookies — each app
  authenticates its own public endpoints.
- Switching the provider to `none` retracts nothing: the persisted origins, the tunnel routes, and the DNS
  records all stay, and the connector keeps serving them. Shell warns and lists them; taking them offline is
  an explicit unpublish or a disconnect with Remove.
- Core does not check whether `cloudflared` is installed or running; it does not own the process.
- A truly simultaneous Dashboard and Hosty write cannot be made atomic — Cloudflare exposes no conditional
  update on the tunnel configuration. A Dashboard change *completed before* a Hosty operation is read and
  preserved.

## Testing Expectations

- Provider `none` is a no-op; a complete `cloudflared` configuration derives origins and writes the config;
  a missing tunnel id is refused; disabling removes the managed config; an operator-authored config is
  preserved; `cloudflare-remote` neither derives an origin nor writes a config even with a leftover base
  domain, and switching to it removes a config `cloudflared` had written
  ([CloudflaredIngressControllerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflaredIngressControllerTests.cs)).
- Subdomain sanitization and override, single- versus multi-endpoint hostnames, deterministic route ordering
  with the Core seed, and duplicate dropping
  ([CloudflaredIngressPlannerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflaredIngressPlannerTests.cs)).
- Ownership per provider: `none` owns nothing, `cloudflared` owns every public origin, `cloudflare-remote`
  owns only published endpoints and ignores another app's publication
  ([PublicOriginOwnershipTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/PublicOriginOwnershipTests.cs)).
- `configure` accepts an operator origin under `none`, refuses a changed managed one, accepts an unchanged
  resend, and accepts the form's blank for an origin that has no value yet.
- The provider migration fires once for a stored connection with provider `none`, and for nothing else
  ([CloudflareProviderMigrationTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflareProviderMigrationTests.cs)).
- The API client sends the bearer header, classifies `config_src`, flattens connections carrying an IPv6
  `origin_ip`, surfaces `403`, treats HTTP 200 with `success: false` as failure, preserves `warp-routing`
  across a config round-trip, and wraps the PUT body in `{"config": …}`
  ([CloudflareApiClientTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflareApiClientTests.cs)).
- Connect auto-selects a single healthy remote tunnel, persists the selection, masks the token, and fails
  distinctly on no-healthy-tunnel and `401`/`403`; an ambiguity carries its candidates, a selection resolves
  it, and a stale selection re-asks; disconnect deletes token and state.
- `reconnect_required` is recorded on a 401/403 during publication, keeps the discovery state and the
  credential, and is cleared by reconnecting.
- Connector locality matches on IPv6, reports `unknown` across families, and `not_local` on a same-family
  mismatch.
- The patcher inserts before the catch-all preserving siblings, appends when a configuration has no
  catch-all at all, updates only `service` while keeping `originRequest`, removes only the named rule, never
  mutates its input, and never touches the catch-all.
- Publish writes route before DNS and preserves `warp-routing`; a DNS failure rolls back the route; a
  hostname owned by another endpoint and a foreign pre-existing record are both refused; adoption takes over
  the existing record without creating one, survives a re-publish, and leaves the record on unpublish;
  unpublish reverses the order; a label change removes the old route and renames the DNS record.
- A rename whose DNS update fails restores the previous route verbatim, keeping a per-rule `originRequest`,
  and leaves the publication and the DNS record where they were; a rename onto a foreign DNS record is
  refused before any mutation and cannot be forced with `adopt`; and a stray duplicate record at the
  endpoint's own hostname still lets an unchanged label be re-applied.
- The patcher restores a captured rule before the catch-all and leaves an already-present hostname alone.
- Publish writes `HOSTY_PUBLIC_ORIGIN_*` and flags restart-required; unpublish removes route, record, and
  setting; publishing without a connection, without a local URL, or under another provider is refused.
- Publication state reports restart-required after publishing onto a running app, active once it starts,
  app-stopped while it is down, and error while the connection needs reconnecting.
- Uninstall and orphan cleanup remove route and record, keep the stored publication when Cloudflare fails,
  and touch only endpoints the app no longer declares; the disconnect sweep reports what it could not remove.
- Diagnostics report `ok` for a matching setup and each kind of drift — `route_missing`, `dns_missing`,
  `dns_foreign`, `app_missing`, `endpoint_missing`, `route_stale` — treat a hand-recreated record as `ok`,
  list public endpoints with no address even with no connection, and still list stored publications after a
  provider switch
  ([CloudflareDiagnosticsServiceTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflareDiagnosticsServiceTests.cs)).
- Core's own address reports `ok` when routed and resolving, `not_configured` with both halves of the recipe
  when `HOSTY_CORE_PUBLIC_ORIGIN` is unset, `route_missing` when the tunnel has no rule for it, `external`
  for a hostname outside the connected zone, and still answers the not-configured case with no connection.
- Cleanup survives a provider switch: publishing is refused afterwards, while unpublish and the app-scoped
  removal still remove the route, the DNS record, and the setting.
- Shell: the publish control renders only under the API provider, the ingress predicates hold for all three
  values, the local-config fields are visible only under `cloudflared`, and the Ingress tab survives a
  refresh on its own URL ([ingress.test.mjs](../../../apps/shell/test/ingress.test.mjs),
  [shell-routes.test.mjs](../../../apps/shell/test/shell-routes.test.mjs)).
- Shell: on a published endpoint an edited label is an enabled `Rename`, an unchanged one is `Reapply` only
  while the route is drifted and a disabled `Rename` in every other state, an emptied field presses nothing,
  and casing or whitespace alone never reads as an edit
  ([public-origin-control.test.mjs](../../../apps/shell/test/public-origin-control.test.mjs)).

## Links

- [Cloudflare Ingress Plan](plan.md) — the one deliverable that remains, and what it is blocked on.
- [Public Origins](../public-origins/feature.md) — the control, the ownership rule and the reconcile
  both Cloudflare providers share with the manual one.
- [Shell Navigation](../shell-navigation/feature.md) — the Settings page this feature's tab belongs to.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — install-time port reservations,
  which give a stopped app the local URL a publication targets.
- [Advertised App Origins](../advertised-app-origins/plan.md) — the LAN-without-a-proxy case, which ingress
  deliberately does not cover.
- [Core Settings](../../ideas/core-settings.md) — the live-settings surface the provider fields use.
- [Cloudflare API Token Templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare Tunnel Configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update)

# Feature: Cloudflare Ingress

Created: 2026-06-17
Updated: 2026-07-28

Runtime app services listen only on loopback. Ingress is the layer that accepts public traffic,
terminates HTTPS, and routes by hostname to the right loopback port. Core never runs a reverse proxy
itself — it drives an operator-run **Cloudflare Tunnel**, and Cloudflare terminates TLS at its edge.

Two mechanisms do this today, and they are not alternatives to each other:

- the **local provider**, selected with `HOSTY_INGRESS_PROVIDER=cloudflared`, which renders a complete
  `config.yml` from the running-app set and derives every hostname deterministically;
- the **Cloudflare API connection**, which is not a provider at all: a separate service stack that
  talks to Cloudflare's API so an operator can publish one endpoint at a time under a chosen label.

The API connection was designed to become a distinct `cloudflare-remote` provider. It did not: the
provider enum still holds only `none` and `cloudflared`
([CoreSettings.cs:102](../../../apps/core/src/Haas.Hosty.Core/CoreSettings.cs)), and the API stack is
registered unconditionally and gated on whether a connection is stored. Shell shows its publish
control only when the provider is `cloudflared`, so in practice the two run together — see
[Where the two paths collide](#where-the-two-paths-collide).

## Providers

Selected with `HOSTY_INGRESS_PROVIDER`:

- **`none`** (default) — the operator owns exposure and sets `HOSTY_PUBLIC_ORIGIN_*` themselves (own
  reverse proxy, port-forward, or a LAN URL). Combine with a pinned port so the mapping is stable
  across restarts. This is the path for operators who do not want Cloudflare, or who use Hosty only
  on the LAN.
- **`cloudflared`** — Core renders the tunnel config from the set of running apps and derives public
  origins automatically.

There is one `IIngressController` registration
([HostyCoreApplication.cs:105](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)); the
`none` case is a no-op inside it rather than a second implementation.

## Local provider

The provider, base domain, tunnel ID, and credentials file are live Core settings: edit them from
Shell's **Platform → Core settings → Public ingress** group, or set the environment variables as the
baseline. A persisted setting wins over its env var. Only the `config.yml` output path is launch-only.

| Env var / setting | Meaning |
| --- | --- |
| `HOSTY_INGRESS_PROVIDER` | `none` (default) or `cloudflared`. |
| `HOSTY_INGRESS_BASE_DOMAIN` | Base domain for derived hostnames, e.g. `example.com`. |
| `HOSTY_INGRESS_TUNNEL_ID` | Cloudflare Tunnel UUID. |
| `HOSTY_INGRESS_CREDENTIALS_FILE` | Path to the tunnel credentials JSON. |
| `HOSTY_INGRESS_CONFIG_PATH` | **Env-only.** Where Core writes `config.yml` (default `<data>/core/ingress/config.yml`). |

Saving applies live — the controller reads current values and re-renders immediately, no restart.
When `cloudflared` is selected but a required value is missing, Core skips writing the config and
surfaces a warning on `GET /api/core/status` rather than emitting a broken file.

### Hostname scheme

Single-level subdomains only, so everything stays under one wildcard CNAME and certificate:

- one public endpoint → `{subdomain}.{baseDomain}`;
- several public endpoints → `{subdomain}-{endpoint}.{baseDomain}`;
- `{subdomain}` defaults to the sanitized app id, overridden per app with `HOSTY_INGRESS_SUBDOMAIN`;
- Core is seeded as `core.{baseDomain}` → its own port.

For each public endpoint Core persists `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` **before start**
([`EnsureIngressPublicOriginsAsync`](../../../apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs)),
so the existing settings → environment pipeline injects it. The host is deterministic, so this does
not wait on the runtime port.

Core re-renders the whole `config.yml` declaratively on every start, stop, restart, port reassignment
and remove, on settings save, and once at startup. Because Core knows each app's actual loopback
port, dynamic ports need no operator action. `cloudflared` hot-reloads the file. Rendering is
best-effort: a write failure is logged and never fails the lifecycle operation. An operator-authored
config that Core did not write is left alone.

## Cloudflare API connection

An administrator pastes one scoped API token into Shell's **Cloudflare ingress** card
([cloudflare-connection-card.tsx](../../../apps/shell/src/app/shell/dialogs/cloudflare-connection-card.tsx)),
which posts it to `POST /api/core/cloudflare/connect` (admin session + CSRF).

Verification is a resource probe, not a token endpoint: the template flow yields an **account-owned**
token, and `GET /user/tokens/verify` rejects those, so Core proves the token by running the discovery
reads and only then calls the account-scoped `GET /accounts/{id}/tokens/verify` — best-effort, purely
to harvest the token's name and expiry
([CloudflareConnection.cs:30](../../../apps/core/src/Haas.Hosty.Core/CloudflareConnection.cs)). The
token is persisted only after both succeed. `401` and `403` are classified apart so a valid token
with missing permissions reads differently from an invalid one.

The token lives in an owner-only `cloudflare-credential.json` beside the core root and is masked to
first-four/last-four everywhere it is projected
([CloudflareCredentialStore.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareCredentialStore.cs)).
It never enters `settings.json`, an API response, or a log line; the API client sets the bearer header
and the error type carries only status codes and Cloudflare's own messages.

Shell links to Cloudflare's token page and lists the three permissions to grant as text — the link is
a plain dashboard URL, not a template that prefills them
([CloudflareConnectionEndpoints.cs:10](../../../apps/core/src/Haas.Hosty.Core/CloudflareConnectionEndpoints.cs)).
The grants are Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, and Zone · Zone · Read.

### Discovery

Connect discovers the account, zone (which supplies the base domain), tunnel, and connectors. A tunnel
is eligible only when it is remotely managed and healthy, so a locally-managed or inactive tunnel is
filtered out. Selection is automatic **only when exactly one candidate exists**; zero produces
`cloudflare_no_*` and more than one produces an ambiguity error whose message says selection "is not
supported yet". There is no picker — ambiguity is a dead end until one is built. The resolved
selection is persisted in `cloudflare-integration.json`.

Discovery also compares the connector's reported `origin_ip` against the host's egress IP (observed
through `https://one.one.one.one/cdn-cgi/trace`) and records a `local` / `not_local` / `unknown`
verdict. The comparison is dual-stack, because a connector's reported address is frequently IPv6. A
`not_local` verdict is logged, persisted, and rendered as a warning on the connection card — it does
not block anything, and nothing in the publish path consults it.

## Publication

`POST /api/apps/{appId}/public-origins/publish` takes an endpoint key and a single DNS label; the
hostname is `{label}.{baseDomain}`. Shell renders this as a label field with the base domain fixed
beside it and a live `→ https://…` preview
([cloudflare-publish-control.tsx](../../../apps/shell/src/app/shell/pages/cloudflare-publish-control.tsx)).

One publish performs two remote mutations, route first, then DNS:

1. read the tunnel's current configuration and PUT it back with the app's rule inserted;
2. create or update an exact proxied `CNAME` → `{tunnelId}.cfargotunnel.com`.

The patcher is pass-through
([CloudflareTunnelConfigPatcher.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareTunnelConfigPatcher.cs)):
it deep-clones the document, updates only a matched rule's `service` (keeping its `originRequest`),
inserts a new rule *before* the catch-all, and never matches or deletes the catch-all itself. Unknown
top-level keys survive because the document is carried as an opaque JSON object — this is load-bearing
rather than precautionary, since a real tunnel config carries `warp-routing` beside `ingress`.

After the PUT, Core reads the configuration back and compares the projection of everything it did not
intend to touch; a mismatch fails with `cloudflare_readback_unrelated_changed`. If the DNS step then
fails, only what this operation created is rolled back.

Ownership is keyed by hostname, never by local port, and is stored per `(app id, endpoint key)`.
A hostname already held by another Hosty endpoint fails `cloudflare_hostname_owned`; a pre-existing
foreign DNS record fails `cloudflare_hostname_conflict`. Both answer `409`, and neither is
overwritten. Adoption of an existing record is not implemented — the `adopted` ownership state exists
in the store but nothing ever assigns it, so the only escape from a conflict is to remove the record
in Cloudflare by hand.

A successful publish writes `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` on the app record and reports whether the
app is running. Nothing is restarted as a side effect; Shell reports the need in a toast.

Publication runs only on request. There is no timer, no startup pass, and no reconciliation of stored
publications against Cloudflare's actual state.

## Where the two paths collide

The API connection was meant to be a provider distinct from `cloudflared`. Because it is not, two
mechanisms write the same setting with different values:

- Shell shows the publish control only when `HOSTY_INGRESS_PROVIDER` is `cloudflared`;
- but with that provider selected, every app start re-derives `HOSTY_PUBLIC_ORIGIN_*` from the
  deterministic `{subdomain}.{baseDomain}` scheme and persists it before launch.

So an origin published under an operator-chosen label is overwritten by the derived one the next time
the app starts, unless the label happens to equal the sanitized app id. The tunnel route and the DNS
record created by the publish survive; only the injected origin reverts.

Separately, two Shell surfaces edit the same value from the same endpoint row: the Cloudflare publish
dialog (a label) and the older **Public origins** settings tab (a free-form URL,
[settings.tsx:34](../../../apps/shell/src/app/shell/settings.tsx)). Neither references the other, and
`POST /api/apps/{id}/configure` accepts a `HOSTY_PUBLIC_ORIGIN_*` value without consulting Cloudflare,
so a URL typed there diverges from the published record.

## Cleanup

Explicit unpublish is complete: it deletes the owned DNS record (tolerating an already-deleted one),
removes the tunnel rule, drops the stored publication, and clears the setting. It also copes with the
app having been uninstalled underneath it.

Nothing else cleans up. Removing an endpoint from a manifest, updating an app, and uninstalling an app
all leave the DNS record, the tunnel rule, and the `cloudflare-publications.json` entry in place —
no lifecycle path calls the publication service. Disconnect deletes the stored token and integration
state and nothing else, leaving every published resource behind; its code comment still claims no
Hosty-owned resources exist yet, which stopped being true when publication shipped. There are no
Keep/Remove choices.

The connection status vocabulary includes `reconnect_required`, and Shell renders a reconnect prompt
for it, but no code path ever assigns it — a revoked or expired token surfaces only as a failure on
the next call.

## Platform origins

Core's own public origin is a CLI launch setting (`HOSTY_CORE_PUBLIC_ORIGIN`), displayed read-only in
Shell. It cannot be published through the Cloudflare API path: the publication endpoints are
app-scoped and Core is not an app. The local provider does seed a `core.{baseDomain}` route into
`config.yml`, but that creates no DNS record and persists no launch setting. A keep-apps restart
endpoint exists, and nothing in the Cloudflare path calls it.

Shell is publishable, but only because it is an ordinary app whose `web` endpoint is `public: true` —
there is no special handling for publishing the Shell you are currently using.

The `hosty` CLI has no ingress or Cloudflare commands.

## Cloudflare setup (one time, local provider)

Using a placeholder domain `example.com`:

1. **Create a tunnel.** `cloudflared tunnel create hosty` → note the UUID and credentials file.
2. **Add one wildcard DNS record.** CNAME `*.example.com` → `<UUID>.cfargotunnel.com`, proxied.
   Universal SSL covers `*.example.com` at a single subdomain level — this is why hostnames are
   single-level. No per-app DNS changes are needed.
3. **Point Core at the tunnel**, from the Shell panel or the environment variables above.
4. **Run the tunnel against the Core-written config** (do not hand-edit it):
   `cloudflared tunnel --config <data>/core/ingress/config.yml run`.
5. **Verify.** Install and start an app, then open `https://<app>.example.com`.

The API connection needs no wildcard record — it creates an exact proxied CNAME per published
hostname — but it still requires a healthy remotely-managed tunnel with a running connector, which
the operator creates and supervises.

## Security and limitations

- Only endpoints declared `public: true` are exposed; every other port stays on loopback.
- The tunnel is a pure L7 router: it terminates TLS and forwards plain HTTP to loopback with
  `X-Forwarded-Proto: https`. It does **not** inject Hosty auth or forward Hosty session cookies —
  each app authenticates its own public endpoints.
- Switching the provider back to `none` does not retract origins Core already persisted.
- Core does not check whether `cloudflared` is installed or running; it does not own the process.
- Hosty never creates a tunnel, and never installs or supervises a connector.
- A truly simultaneous Dashboard and Hosty write cannot be made atomic — Cloudflare exposes no
  conditional update on the tunnel configuration. A Dashboard change *completed before* a Hosty
  operation is read and preserved.

## Testing Expectations

- Provider `none` is a no-op; a complete `cloudflared` configuration derives origins and writes the
  config; a missing tunnel id is refused; disabling removes the managed config; an operator-authored
  config is preserved
  ([CloudflaredIngressControllerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflaredIngressControllerTests.cs)).
- Subdomain sanitization and override, single- versus multi-endpoint hostnames, deterministic route
  ordering with the Core seed, and duplicate dropping
  ([CloudflaredIngressPlannerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflaredIngressPlannerTests.cs)).
- The API client sends the bearer header, classifies `config_src`, flattens connections carrying an
  IPv6 `origin_ip`, surfaces `403`, treats HTTP 200 with `success: false` as failure, preserves
  `warp-routing` across a config round-trip, and wraps the PUT body in `{"config": …}`
  ([CloudflareApiClientTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflareApiClientTests.cs)).
- Connect auto-selects a single healthy remote tunnel, persists the selection, masks the token, and
  fails distinctly on no-healthy-tunnel, ambiguity, and `401`/`403`; disconnect deletes token and state.
- Connector locality matches on IPv6, reports `unknown` across families, and `not_local` on a
  same-family mismatch.
- The patcher inserts before the catch-all preserving siblings, updates only `service` while keeping
  `originRequest`, removes only the named rule, never mutates its input, and never touches the
  catch-all.
- Publish writes route before DNS and preserves `warp-routing`; a DNS failure rolls back the route; a
  hostname owned by another endpoint and a foreign pre-existing record are both refused; unpublish
  reverses the order; a label change removes the old route and renames the DNS record.
- Publish writes `HOSTY_PUBLIC_ORIGIN_*` and flags restart-required; unpublish removes route, record,
  and setting; publishing without a connection or without a local URL is refused.

## Links

- [Cloudflare Ingress Plan](plan.md) — the ingress work that remains.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — install-time port
  reservations, which give a stopped app the local URL a publication targets.
- [Core Settings](../../ideas/core-settings.md) — the live-settings surface the provider fields use.
- [Cloudflare API Token Templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare Tunnel Configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update)

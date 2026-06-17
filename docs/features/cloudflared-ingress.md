# Feature: Ingress (Cloudflare Tunnel provider)

## Goal

Give runtime apps externally reachable, TLS-terminated URLs without the operator hand-editing a
reverse proxy and re-typing public origins on every install. A runtime app's services listen only
on loopback; "ingress" is the layer that accepts public traffic, terminates HTTPS, and routes by
hostname to the right loopback port. Core does not run a reverse proxy itself — the default
`cloudflared` provider drives an operator-run **Cloudflare Tunnel** by writing its config file and
auto-deriving `HOSTY_PUBLIC_ORIGIN_*` for each public endpoint.

## Non-goals

- Core terminating TLS or running an in-process reverse proxy (Cloudflare terminates TLS at its edge).
- Calling the Cloudflare API. Core only writes a local `config.yml`; DNS is a one-time operator step.
- Supervising the `cloudflared` process. The operator runs it and points it at the Core-written config.
- Per-endpoint custom hostnames beyond the `{subdomain}` / `{subdomain}-{endpoint}` scheme (future).
- Binding app ports on a LAN interface (LAN users use the `none` provider; see below).

## Providers

Selected with `HOSTY_INGRESS_PROVIDER`:

- **`none`** (default) — today's behavior. The operator owns exposure and sets `HOSTY_PUBLIC_ORIGIN_*`
  themselves (own reverse proxy / port-forward, or a LAN URL). Combine with a pinned port
  (`HOSTY_PORT_<KEY>`) so the mapping is stable across restarts. This is the path for operators who
  don't want Cloudflare or who only use Hosty on the LAN.
- **`cloudflared`** — Core renders the tunnel config from the set of running apps and derives public
  origins automatically.

## Configuration

| Env var | Meaning |
| --- | --- |
| `HOSTY_INGRESS_PROVIDER` | `none` (default) or `cloudflared`. |
| `HOSTY_INGRESS_BASE_DOMAIN` | Base domain for derived hostnames, e.g. `example.com`. |
| `HOSTY_INGRESS_TUNNEL_ID` | Cloudflare Tunnel UUID. |
| `HOSTY_INGRESS_CREDENTIALS_FILE` | Path to the tunnel credentials JSON. |
| `HOSTY_INGRESS_CONFIG_PATH` | Where Core writes `config.yml` (default `<data>/core/ingress/config.yml`). |

Per app (a Hosty app setting): `HOSTY_INGRESS_SUBDOMAIN` overrides the auto-derived subdomain (e.g.
`pm` → `pm.example.com`). When `cloudflared` is selected but a required value is missing, Core skips
writing the config and surfaces a warning on `GET /api/core/status` rather than emitting a broken file.

## Hostname scheme

Single-level subdomains only, so everything stays under one wildcard CNAME / wildcard certificate:

- One public endpoint → `{subdomain}.{baseDomain}` (e.g. `pm.example.com`).
- Multiple public endpoints → `{subdomain}-{endpoint}.{baseDomain}` (e.g. `media-ui.example.com`,
  `media-jellyfin.example.com`).
- `{subdomain}` defaults to the sanitized app id and can be overridden per app.
- Core itself is seeded as `core.{baseDomain}` → its own port.

For each public endpoint Core sets `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` to `https://<hostname>`, which the
existing settings → environment pipeline injects into the app — so the app needs no change.

## Behavior

- On app start (before launch) Core persists the derived `HOSTY_PUBLIC_ORIGIN_*` settings; the host is
  deterministic, so it does not depend on the runtime port.
- On every start / stop / remove, and once at Core startup, Core re-renders the whole `config.yml`
  declaratively from all running apps' public endpoints plus the Core seed and a required catch-all
  rule. Because Core knows each app's actual loopback port, dynamic ports are handled automatically —
  the operator never updates the tunnel mapping by hand.
- `cloudflared` hot-reloads the config file, so no process restart is needed when routes change.
- Rendering is best-effort: an ingress write failure is logged and never fails the lifecycle operation.

Example rendered `config.yml`:

```yaml
# Managed by Hosty Core - do not edit. Regenerated on runtime app lifecycle changes.
tunnel: <TUNNEL_UUID>
credentials-file: /home/hosty/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: core.example.com
    service: http://localhost:7070
  - hostname: pm.example.com
    service: http://localhost:34999
  - service: http_status:404
```

## Cloudflare setup (one time)

Using a placeholder domain `example.com`:

1. **Create a tunnel.** `cloudflared tunnel create hosty` → note the tunnel UUID and the generated
   credentials file (e.g. `~/.cloudflared/<UUID>.json`). Put the credentials where Core can read it.
2. **Add one wildcard DNS record.** A CNAME `*.example.com` → `<UUID>.cfargotunnel.com`, proxied
   (orange cloud). Cloudflare Universal SSL covers `*.example.com` at a single subdomain level — this
   is why Core uses single-level hostnames. No per-app DNS changes are ever needed.
3. **Point Core at the tunnel:**
   ```
   HOSTY_INGRESS_PROVIDER=cloudflared
   HOSTY_INGRESS_BASE_DOMAIN=example.com
   HOSTY_INGRESS_TUNNEL_ID=<UUID>
   HOSTY_INGRESS_CREDENTIALS_FILE=/home/hosty/.cloudflared/<UUID>.json
   ```
4. **Run the tunnel against the Core-written config** (do not hand-edit it):
   ```
   cloudflared tunnel --config <data>/core/ingress/config.yml run
   ```
   Run it as a service so it stays up.
5. **Verify.** Install and start an app, then open `https://<app>.example.com`.

## Security and limitations

- Only endpoints declared `public: true` are exposed; all other ports stay on loopback.
- The tunnel is a pure L7 router: it terminates TLS and forwards plain HTTP to loopback with
  `X-Forwarded-Proto: https`. It does **not** inject Hosty auth or forward Hosty session cookies — each
  app authenticates its own public endpoints (per the auth/gateway boundaries).
- Switching the provider back to `none` does not retract origins Core previously persisted; remove them
  manually if needed.
- Core does not check whether `cloudflared` is installed or running (it does not own the process); it
  only writes the config and warns about missing configuration.

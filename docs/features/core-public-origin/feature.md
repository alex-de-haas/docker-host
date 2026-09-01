# Core's Own Public Origin

Created: 2026-09-01
Updated: 2026-09-01

The address Core tells the world it lives at is a live Core setting, editable where every other host
setting is edited and publishable through the Cloudflare API provider the way an app endpoint is.

`HOSTY_CORE_PUBLIC_ORIGIN` is what an operator's browser, an invited user's link, and an agent client
all navigate to. It is the origin in setup and invitation links, the OAuth issuer and every endpoint in
`/.well-known/oauth-authorization-server`, the RFC 9728 protected-resource document for `/api/mcp`, the
`WWW-Authenticate` pointer on an MCP 401, and the origin the login page reports. A wrong value does not
degrade a feature — it points people at a host that does not answer.

## The Setting

The value lives in the `Server` group of `{root}/core/settings.json`, beside the listen port, and is
served as a "Public origin" row in the "Core process" group by `/api/core/settings` and
`/control/v1/settings`. Resolution is **persisted → `HOSTY_CORE_PUBLIC_ORIGIN` → Core's listen URL**:
the stored value wins over the environment variable, and clearing it falls back rather than blanking the
value. The row's `default` is what a reset would land on, which is the environment baseline when a host
was launched with one.

That is the opposite precedence from the listen port in the same group, deliberately. The port is read
once at startup, so a flag or env var can outrank the store for a single run. Every reader of the public
origin builds a link or a metadata document per request, so an origin that only applied after a restart
would leave the operator's own invitation links pointing at the old host for as long as they put off
restarting.

**Validation refuses only what is wrong by form**: a value that is not an absolute `http`/`https` origin,
one carrying a path, query, fragment or userinfo, and the unspecified addresses (`0.0.0.0`, `[::]` — a
bind address, never somewhere to send a browser). A loopback origin is *accepted*: it is the default
state and the right answer for a single-machine host. Reachability is never a refusal and there is no
pre-save probe — that judgment is advisory and belongs to the ingress diagnostics, the same stance the
connector-locality check records. A stored value is canonicalized to its authority, and a hand-edited
`settings.json` entry that does not parse is skipped per-entry rather than taken or fatal.

## Two Stages

A save takes effect in two stages, and the UI says so rather than implying the change is complete:

- **Immediately** for everything Core itself hands out: login and origin meta, setup and invitation
  links, the OAuth metadata documents, and `/api/core/status`. These are built per request from
  `CorePublicOriginResolver`, not from a startup snapshot.
- **On next start** for installed apps. `HOSTY_CORE_PUBLIC_ORIGIN` is part of an app's environment,
  injected at container create or process start, and Core cannot rewrite the environment of a running
  process. The live value is resolved at each start, so the next app to start gets the new origin — but a
  running one keeps what it was given.

## Recovery

**Core answers on its listen URL whatever this value says.** That is the property that makes a wrong
value survivable rather than fatal, and it is held by three separate mechanisms:

- the session cookie's `Secure` flag follows the request scheme (`CreateSessionAsync`'s
  `secureCookie: request.IsHttps`), not the public origin — a `Secure` cookie is silently dropped over
  plain HTTP, so tying it to an `https` origin would make loopback sign-in fail with no error anywhere;
- OAuth resource resolution accepts the listen URL alongside the public origin, so a flow completed over
  loopback still resolves to Core's own audience;
- `HOSTY_CORE_ORIGIN` — how an app's server process dials Core — is derived from the listen URL, so a
  wrong public origin cannot break app-to-Core traffic.

So an operator who saves an unreachable origin signs in over `http://localhost:{corePort}` and corrects
it from the Settings page they arrived at. On a headless host the same repair is
`hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN` over the loopback control plane; setting it there
prints the same two-stage note Shell shows, so an operator with no browser is told what still needs a
restart.

## Browser-Only

Docker apps' `HOSTY_CORE_ORIGIN` is derived from Core's `ListenUrl` with the loopback→
`host.docker.internal` rewrite, which is what `localCommand` apps already did with the listen URL
directly. It used to be derived from the public origin, which meant that once an origin was set,
containers dialled Core by its public name — out through the tunnel and back — even though
`--add-host host.docker.internal:host-gateway` kept the direct path available.

The public origin is therefore browser-only, and a wrong value's blast radius is links and OAuth
metadata rather than every app's calls to Core. Nothing dials Core by its public name: every reader of
`HOSTY_CORE_ORIGIN` (`apps/ai-gateway`, `apps/telemetry-backend`, `apps/marketplace`, `apps/demo-app`,
`packages/app-sdk`) uses it purely as a server-to-server base URL, and both SDKs document that a browser
must never be sent there.

## Publishing It

With the Cloudflare API provider connected, Core's hostname is published from Settings → Ingress under a
label the operator chooses: one proxied `CNAME` and one tunnel rule to `http://localhost:{corePort}`.

Ownership is keyed on the reserved pair `(hosty.core, core)` in the same publication store the apps use.
That is what lets Core's hostname ride the identical reconciler — conflict and adoption handling, the
read-back, the rollback, rename-in-place — with no synthetic app record to keep consistent with a
registry Core is not in. The service layer forks instead: `PublishCoreAsync` beside the app path, writing
into the Core settings store rather than an app's settings. Every sweep that walks publications expecting
an installed app skips the reserved pair, and the bulk cleanups route through the Core path so a removed
publication can never leave Core advertising a hostname whose route and record are gone.

**The setting is written last**, only after the reconciler's read-back has confirmed both the route and
the DNS record. A failure leaves the origin untouched rather than advertising a name that resolves to
nothing.

**Unpublish restores the previous origin** — the persisted value from before Hosty took it over, carried
on the publication record; a null there clears the override, so Core falls back to its environment
baseline or its listen URL. It restores only while the setting still names the published hostname: an
administrator who edited the value after publishing has made a newer choice, and unpublish must not
overwrite it with a stale one. A rename reads through to the value from before the *first* publish, so
unpublishing never restores a hostname Hosty itself wrote.

Since Core builds its links per request, a publish is live immediately and there is no restart to prompt
for — the one place this flow reads differently from an app's.

Diagnostics report Core's address under the app state vocabulary, with a `managed` flag saying whether
Hosty published it. A Hosty-written route is compared against the exact service string it wrote, so a
Core port that moved reads as `route_stale` and the remedy is to reapply it; a hand-written route is
judged on presence alone, because the operator may have spelled the port as `127.0.0.1` where Core
expects `localhost`. Shell shows the by-hand `CNAME`-and-rule recipe only under `none` and `cloudflared`,
the providers that cannot publish it.

## Testing Expectations

- The setting: environment baseline versus persisted override, clearing back to the baseline and (with
  no baseline) to the listen URL, persistence across a reload, and canonicalization of a stored value.
- Validation accepts loopback, LAN and public origins and refuses a bare host, a non-http(s) scheme, a
  path, a query, a fragment, userinfo, and the unspecified addresses — refusing before anything is
  written, so a bad submission never displaces a working value.
- The shared `Server` group: writing either key leaves the other intact, and a hand-edited invalid origin
  is skipped without disturbing the stored port or crashing startup.
- Readers follow the live value: setup and invitation links, the OAuth AS metadata and protected-resource
  document, and the MCP 401 pointer, all without a restart.
- Recovery, end to end: with the setting naming an unreachable host, sign-in over the listen URL still
  issues a session, that session can correct the value from the admin surface, and the reset works over
  the control plane. The session cookie's `Secure` flag is pinned to the request scheme separately, so a
  refactor cannot pass the loop by accident.
- The decoupling: a non-loopback public origin never reaches `HOSTY_CORE_ORIGIN`, which follows the
  listen URL with the loopback rewrite for docker and unchanged for `localCommand`.
- Publication: route and DNS synced with the setting written last (and left untouched when the mutation
  fails), unpublish restoring the previous origin or clearing it, unpublish declining to overwrite a
  newer manual edit, a rename keeping the original previous origin, and the disconnect sweep taking
  Core's publication with it.
- Diagnostics: Core's publication reported as Core rather than as a missing app, a Hosty-written route
  that moved reported as `route_stale`, and a hand-written route not judged on its target.

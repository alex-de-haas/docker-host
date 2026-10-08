---
created: 2026-09-30
updated: 2026-10-08
summary: Core derives local browser addresses under hosty.localhost without stored public origins or DNS.
components: [apps/core, apps/shell, packages/app-sdk]
---

# Local Browser Origins

Core derives browser addresses for plain HTTP loopback endpoints without storing a public-origin
setting or provisioning DNS. The default instance uses `core.hosty.localhost:<port>` for Core.
Public app endpoints use a stable app hostname beneath `hosty.localhost`, with their assigned ports.
Non-default data roots include their persisted instance identity: `i-<instance-id>.hosty.localhost`.
These addresses refer to the browser's own machine; they are not remote/LAN addresses.

## Resolution and transport

`LocalBrowserOrigins` owns the policy. App IDs escape hyphens as `-h`, dots as `-d` and underscores
as `-u`, then split into 50-character chunks wrapped in `a` and `z` to keep every DNS label valid.
For example, `hosty.shell` uses `ahosty-dshellz.hosty.localhost`. Distinct accepted app IDs retain
distinct names; display names do not participate. Core's `core` label is reserved.

A managed `HOSTY_LOCAL_NAME_<ENDPOINT>` label replaces the generated app hostname for that endpoint
beneath the same instance suffix; its port is always derived from the endpoint's current transport.
The Local provider editor stores this label and supports reset to the generated name. Core reserves
local names across apps, even when hidden behind an external origin. Core and generated labels are
reserved, and private endpoints cannot receive local labels. Renaming is an explicit operator action;
upgrades preserve existing generated names and manual full origins.

A valid explicit app `HOSTY_PUBLIC_ORIGIN_<ENDPOINT>` takes precedence. Clearing it restores the
local default. Core resolves the persisted setting, environment baseline, then listen address,
and preserves an explicit setting or environment origin exactly, including a literal IP. Only an
implicit plain-HTTP loopback listen address projects to the separate managed Core browser hostname.
HTTPS, LAN and external origins retain their configured hostnames.

App code initiation requires a Core hostname different from every configured app endpoint cookie
host, including private/raw WebSocket endpoints. HTTP supports canonical `localhost` and
`.localhost` names through a Core-origin sessionStorage nonce and an exact-Origin continuation POST.
Only validated app-origin initiation initializes the proof; continuation URLs and parent-Domain
cookies cannot initialize it. Blocked storage fails closed, with credential-free silent recovery
and an explicit popup path. If bootstrap storage access or writing fails, or local browser capacity
is exhausted, a bounded exact-Origin form cancels only the nonce-owned server intent. This releases
the pending quota immediately and preserves other attempts; cancellation never issues credentials.
Post-claim code-persistence failures return terminal proof-cleanup HTML with a generic unavailable
message. Audit-storage failure does not prevent that cleanup, and the consumed intent cannot replay. HTTPS and literal-IP HTTP retain their isolated nonce cookies; other
HTTP DNS names remain refused. Hosts are canonicalized without DNS resolution. Source development's
explicit `http://[::1]:3001` origin also remains supported, with app endpoints on other hosts and
popup fallback for its cross-site silent path. See [app code exchange](../app-code-exchange/feature.md).
A refused topology never enables unbound issuance.

Endpoint summaries expose `browserOrigin` separately from transport `url` and explicit
`publicOrigin`. Navigation, app identity redirect validation and runtime
`HOSTY_PUBLIC_ORIGIN_*` environment use the browser projection. Container-to-Core transport still
uses `host.docker.internal`; local processes, readiness probes, port assignment and CLI control keep
their existing direct transport. Generated origins are absent from publication settings and ingress
publication state. Ingress Local (wire value `none`) provides the local name editor and an advanced full-origin option;
it provisions no DNS or proxy. Endpoint summaries additionally carry `localOrigin`, `localName`,
`localSuffix` and `localDefaultOrigin` for an editor that does not guess the assigned port or namespace.

App origin edits reject the Core hostname and another app's effective or reserved generated name.
Core origin edits reject a hostname used by a registered public app endpoint. Confirmation also
checks the actual request hostname at decision time, including legacy transport hosts.

## Navigation and migration

Shell canonicalizes ordinary query-free document GET navigation from bare local hosts on its
entry routes before authentication. Core canonicalizes login and confirmation entry GETs, and
query-free setup/recovery entries. API calls and POST bodies are not redirected. Login preserves
only an allowlisted continuation; token-bearing setup/recovery links stay on their requested origin.
Newly generated setup, recovery, invitation, confirmation and OAuth links already use Core's
browser origin.

A Core session remains host-only and bound to its issuing browser origin. An old session cannot
approve a decision on the new origin; the confirmation route sends the user through fresh login.
The shared-host denial, nonce, request-origin, expiry and replay protections remain in place.

App-requested removal also uses this isolated Core confirmation. `apps.install` permits preparing
the request, while direct app-token removal is forbidden. The page shows frozen cleanup choices,
including data/backups deletion; execution rejects a missing or replaced installation. Shell uses
this same flow. See [installation SDK and confirmation](../app-installation-sdk/feature.md).

Running apps store `appliedBrowserOrigin` after start/restart. A legacy running app without it, or
one started against a different Core browser origin, reports `restartRequired`. Its next explicit
restart applies the injected environment. Core does not silently restart live workloads to migrate
browser addresses. Adopting existing Docker containers or partially adopting a mixed service graph
preserves the last applied origin/configuration rather than claiming the new environment is active.
Configured app origins and existing port assignments are preserved.

## Verified behavior and current limitation

On 2026-10-08, a fresh source Core instance passes normal password login and the authenticated
Shell dashboard on generated HTTP `.localhost` names in Chromium and native Safari. Its Core-managed
Demo App passes explicit popup authorization and frame recreation in both browsers; Safari uses the
existing fallback when the Core session is unavailable in the frame. The nonce uses Core-origin
storage and an exact-Origin POST, without relying on Safari accepting Secure cookies over HTTP.

On 2026-09-30 a separate Core-managed localCommand Shell instance passed the Chromium browser
entry, Core login, authenticated dashboard and required-permission review-page flow without public
origin settings. Real-password HTTP tests exercise approval and denial on the isolated hostname.

On 2026-10-01, Safari 27 and Chromium passed real password login and the authenticated Shell
dashboard on an isolated Core-managed localCommand installation. Shell now navigates through Core
and exchanges an app-bound code on its server; background API calls use its own cookie and
service credential. Core's cookie is not part of this transport. Next's internal Request URL can
contain its listen address, so Shell validates the browser Host against the configured callback
origin instead of comparing the internal URL's origin.

Initial embedded sign-in submits an app-owned Origin-checked intent form and follows its
nonce-bound continuation in the app's frame. Its success
depends on the browser treating Shell and Core as the same site: a shared local DNS suffix is not
proof of that. A 2026-10-05 cookie probe under the default `*.hosty.localhost` names classified the
Core frame as same-site in Chromium and cross-site in Safari, which sent no Core cookie. Where the
cookie is unavailable, a known silent continuation returns only state-bound `login_required` and the app offers its popup
button. After sign-in, the app-origin `sessionStorage` grant survives frame recreation in that tab.
There is no browser detection. [Embedded app sign-in](../embedded-app-sign-in/feature.md) describes
the shared registrable-domain deployment and the same popup fallback for other arrangements.

The JavaScript SDK also supports app-owned popup authorization for embedded content. A Core-managed
Marketplace fixture passed embedded sign-in in Chromium and Safari 27. Chromium additionally passed
sign-in without `apps.install`, using the ordinary sandbox, and rejected a revoked parent session on
reload before recovering through a new Core login. The fixture had no real catalog configured.

Native Safari 27 also passed embedded Harness recovery after Core logout: a subsequent API request
rejected the revoked app grant, the user entered the normal password in Core's popup, and Harness
loaded protected source settings again without reloading Shell. A separate Marketplace fixture
without `apps.install` passed popup sign-in under the ordinary iframe sandbox. Chromium verified
Harness MCP calls and assignment revocation against Core with a deterministic model adapter.

An isolated 0.116.0-to-source upgrade preserved a running localCommand process and a Docker container.
Both reported `restartRequired` with their old environment; explicit app restarts injected the new
browser addresses and cleared the flag without changing transport ports or public-origin settings.

Native Ubuntu 24.04 ARM64 and Mac Docker Desktop pass the server-side Shell authorization-code
exchange, authenticated API access and recovery revocation with the same ARM64 Shell image.
On Linux, changing both Core and Shell to custom `*.localhost` origins preserves that flow;
clearing the settings restores the generated origins. These checks exercise public HTTP routes,
not browser automation or an external ingress provider.

Firefox 157 on Ubuntu 24.04 ARM64 also passes the interactive Shell login flow:
opening `localhost:7171` reaches Core's generated hostname, ordinary email/password login
returns to Shell's generated hostname, and the authenticated dashboard displays the current
user, app inventory and live Core state. Reloading the page preserves the session. This
targeted check does not cover permission approval, embedded apps or interactive setup/recovery.

## Docker-to-Core transport

For a plain HTTP loopback Core listener on native Linux, Core discovers Docker's default bridge
and verifies its gateway against addresses assigned to the corresponding local bridge interface.
It adds a Kestrel listener on that address and maps `host.docker.internal` to it when creating app
containers. The ordinary loopback listener, browser origins, port publication and API authorization
are unchanged. The additional listener rejects `/control` routes before forwarded headers.

Discovery runs at Core startup and Docker app start. There is no background network polling or
proxy process. If Docker becomes available later, app start reloads the endpoint and waits for
Core health before launching the app. Docker absence does not prevent local Core startup.
Discovery/readiness failures produce `docker_core_transport_unavailable` when starting Docker apps.
A previously running container retains its creation-time address mapping; a changed Docker gateway
requires recreating that container through its normal app lifecycle.

Mac/Windows Docker Desktop use the existing host relay. Native Linux detection skips bridge
binding for Docker Desktop and refuses to guess addresses for remote or rootless daemons; automatic
bridge transport requires a local Docker Engine bridge with an IPv4 gateway. Explicit non-loopback,
HTTPS or Kestrel endpoint configurations remain operator-controlled. No wildcard listener or host
firewall change is introduced. A public-origin edit never changes this internal transport.

Live external provider/private-repository checks and the remaining platform/browser matrix
remain open in [the plan](plan.md). These checks do not establish complete release acceptance.

## Host Source And Mount Authority

Core requires its own confirmation when an app selects any source override (including registered
worktrees), selects an inline host mount, or changes the shared-mount registry. Existing approved
global mount selections remain immediate. Ordinary lifecycle operations and clearing an override
require no additional confirmation. All callers are prohibited
from selecting app storage or externally mounted paths as executable overrides, and external mounts
cannot expose the Core data root or executable source folders. Reviews freeze paths and target state,
recheck caller authority under mutation locks and leave source/mount state unchanged on stale consent.
See [source workflows](../runtime-source-workflows/feature.md) and
[shared mounts](../global-mounts/feature.md) for the path policy.

## Permission setup without lifecycle blocking

Required declarations are setup diagnostics, not launch preconditions. Missing or
unsupported rights never prevent start, restart, autostart, runtime switching or workload
adoption. Permission observation cannot stop an app. Current grants still authorize each
privileged call and unknown permissions cannot be approved. The shared SDK notice in
Shell, Harness, Marketplace and Telemetry UI opens isolated Core review for administrators,
including a verified-frame embedding path. See [permission management](../app-permission-management/feature.md)
for the launch authority audit and notice behavior.

## Testing Expectations

- Keep generated names injective, label lengths bounded and instance identity stable.
- Preserve explicit origins exactly, internal transport and publication ownership; clearing settings
  restores defaults. Test named-localhost storage proof, literal-IP HTTP and HTTPS nonce topology
  against every endpoint cookie host, including private/non-HTTP schemes, while other HTTP DNS
  configurations fail closed.
- Exercise real login and approval/denial, host-only session cookies, origin binding and shared-host rejection.
- Verify legacy GET navigation without forwarding credentials, callback codes or POST bodies.
- Verify runtime environment and restart-required migration for both localCommand and Docker.
- Run `python3 scripts/check-docker-core-transport.py <built-core-dll-or-executable>` for changes to
  the transport. It starts an isolated Core and checks health and authorization from default and
  per-app Docker networks. `--image <local-node-image>` reuses an existing image. Linux CI scopes
  this smoke check to transport source/workflow changes; it does not add a full OS/browser matrix.
- Cover bridge discovery refusal, endpoint reload/removal, late Docker availability and CLI-route
  isolation. The ordinary test suite covers public-origin/transport separation.
- Complete browser acceptance for Shell, embedded/standalone apps and browser capabilities, including Safari;
  resolution success alone is insufficient.

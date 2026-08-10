# Feature: Public Origins

Created: 2026-08-10
Updated: 2026-08-10

A public origin is the external HTTPS address one app endpoint answers on. It is a durable property of
the endpoint, not of the process behind it: Core reserves the endpoint's local port at install, so the
address exists before the app has ever started and survives it being stopped.

Three ingress providers implement it, and exactly one owns a given endpoint's origin at a time
([cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md) describes the two Cloudflare ones in
full). What this document describes is what they have in common: one control that sets an origin, one
owner that decides who may, and one reconcile that materializes it whoever moved the underlying port.

## One control

A globe on the endpoint row opens the public-origin dialog
([public-origin-control.tsx](../../../apps/shell/src/app/shell/pages/public-origin-control.tsx)),
under every provider. Host-admin only, and only for an endpoint declared `public`.

The question is always "what is this endpoint's public address". The provider decides what the answer
is made of, and what applying it does:

| Provider | Input | Applying it |
| --- | --- | --- |
| `none` | a full URL | writes `HOSTY_PUBLIC_ORIGIN_<KEY>`; instantly reversible |
| `cloudflared` | the app's subdomain | writes `HOSTY_INGRESS_SUBDOMAIN`; Core renders it into `config.yml` on the next reconcile |
| `cloudflare-remote` | a subdomain label | creates a proxied CNAME and a tunnel route; clearing it **deletes a DNS record** |

The two label-shaped providers share one input and one live hostname preview, which is what makes them
feel like one control rather than two that resemble each other. Under `cloudflared` the field is
labelled as what it is — the *app's* subdomain, so it moves every public endpoint of that app, not only
the one whose row it was opened from.

Reversibility is not flattened. Publishing keeps its adoption prompt for a pre-existing DNS record,
offered explicitly and never implied, and unpublishing stays a separate action rather than a cleared
field. A unified input must not turn "clear it and save" into a silent remote deletion.

The public-origin fields in the app's settings dialog are read-only and point here. A second editable
field could only ever express the simplest of the three shapes, and Shell rendering one rule while
Core enforced another is exactly how the two surfaces came to disagree.

## One owner

[`PublicOriginOwnership`](../../../apps/core/src/Haas.Hosty.Core/PublicOriginOwnership.cs) decides who
owns an endpoint's origin right now, and the `configure` guard refuses a write to a managed one. Under
`none` every origin is the operator's; under `cloudflared` Core derives them all; under
`cloudflare-remote` a publication owns the endpoints that have one, and the rest stay the operator's —
fronting one endpoint with your own proxy while publishing another is a legitimate arrangement.

The stored `HOSTY_PUBLIC_ORIGIN_*` setting is a projection of that decision, never a second source of
truth. Treating it as authoritative is what once let derivation overwrite a published origin on every
start.

## One materialization

`IIngressController`
([CloudflareIngress.cs:19](../../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs)) is the
provider abstraction, and both providers now sit behind it. `ProviderIngressController` asks each of
them on every reconcile and each no-ops unless it is the selected one — dispatching to exactly one
would strand the `config.yml` the local provider has to delete after a provider switch.

This is what makes "who changed the port" irrelevant. Install, operator reassignment, the boot
rehoming pass and boot itself already call `ReconcileIngressAsync`; each now materializes the right
thing for the selected provider without knowing which one it is. Before, publishing was reachable only
from the publish endpoint, so a hostname followed its local port only when an operator pressed a
button, and a port moved by anything else left the tunnel routing to a port nothing listens on.

`ReconcileAsync` receives every **installed** app, not every running one.

### The local provider

`cloudflared` renders a route for every installed app with a public endpoint and a resolved URL. An
endpoint with no URL is skipped — reachable only for a port key that first appears in an update, a
runtime switch, or a live manifest, which carries no install-time reservation and so no URL until the
app's next start ([automatic-runtime-app-ports/feature.md](../automatic-runtime-app-ports/feature.md)).

A stopped app's hostname therefore resolves to a route whose local port has no listener, and
cloudflared answers `502` — "the address exists, the app is down" — instead of falling through to the
catch-all `404`, "no such hostname". That is an observable change from before 0.77.0: an external
uptime check keyed on `404` sees a different code.

`config.yml` is consequently rewritten only by install, uninstall, a port change, a subdomain change,
or a public-origin change. An ordinary start or stop produces byte-identical output.

### The API provider

`cloudflare-remote` materializes publications
([CloudflareRemoteIngress.cs](../../../apps/core/src/Haas.Hosty.Core/CloudflareRemoteIngress.cs)), and
does so whatever provider is selected. A publication outlives a provider change — which is why
unpublish is ungated too — so its hostname stays routed and live after a switch to `none` or
`cloudflared`; gating reconciliation would strand it on a dead port the moment anything moved one.
Creating a publication stays gated on the provider. The work is bounded by publications, so a host
that never published pays nothing.

A
publication records the target last written into the tunnel, so reconciliation diffs two strings and
pushes only what actually moved: a steady-state boot makes no API call at all, and only the boot where
something moved talks to Cloudflare.

A move goes through `RepointAsync`, which rewrites exactly one route rule and verifies the read-back.
It is deliberately not a re-publish: the hostname, label, DNS record and ownership state are unchanged
when only a local port moved, so it touches neither DNS — the CNAME points at the tunnel, not at a
port — nor the conflict and adoption logic, which exist to decide who owns a hostname and have no
question to answer when the hostname is already ours.

A push that cannot happen — no connection, an expired token, Cloudflare unreachable — records
`DriftedServiceUrl` on the publication and surfaces the `origin_drifted` state. It is not retried on
the startup path and never stalls boot; the next reconcile that reaches Cloudflare repairs it and
clears the marker. Connecting Cloudflare reconciles immediately, so the reconnect the drift message
asks for is itself the repair. A port that moved and moved back before anyone could push clears the
marker without an API call — the route was never wrong by the time it mattered — and the dialog
offers Reapply on a drifted publication so the state is actionable rather than only described. `origin_drifted` outranks `app_stopped` (starting the app repairs nothing) and
ranks below `error` (a broken connection must be fixed before the drift can be).

### When nobody can materialize it

Under `none`, and for an unpublished endpoint under `cloudflare-remote`, the origin is the operator's.
Core cannot repair it and cannot even detect that it is stale: such an origin typically reads
`https://app.example.com` with no port at all, because it names the operator's own reverse proxy whose
upstream lives in that proxy's configuration — a file Core neither writes nor can read.

So Core reports the event instead of asserting a state. When the boot rehoming pass moves a port whose
origin is operator-owned, it publishes one host-admin notification naming the old and new local port
and saying to update the upstream. A standing "broken" badge would claim knowledge Core does not have.

## Testing Expectations

- The local provider routes an installed app whatever its runtime state, skips an endpoint with no
  resolved URL, and renders byte-identical config across a start/stop of the same app
  ([CloudflaredIngressControllerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflaredIngressControllerTests.cs)).
- The API provider re-points a moved port without touching DNS, makes no API call when nothing moved,
  records drift without throwing when there is no connection or the API fails, repairs and clears the
  drift on the next successful reconcile, does nothing under another provider, and skips an endpoint
  with no URL
  ([CloudflareRemoteIngressControllerTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/CloudflareRemoteIngressControllerTests.cs)).
- `origin_drifted` is projected ahead of `app_stopped` and behind `error`.
- A retained publication is reconciled under any provider, a host with no publications makes no API
  call under any provider, and a port that moved back clears the drift without one.
- Saving a public origin or a subdomain reconciles ingress; an ordinary settings write does not.
- The control's provider-to-shape selection is total, an unknown provider never becomes a publish
  surface, the subdomain sanitizer accepts only DNS-label characters, and the setting key it writes
  matches Core's normalization
  ([public-origin-control.test.mjs](../../../apps/shell/test/public-origin-control.test.mjs)).

## Links

- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — the two Cloudflare providers in full.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — the local port an origin
  points at, and the boot pass that moves it.
- [Core Public Origin](../core-public-origin/plan.md) — Core's own hostname, deliberately separate.

# Public Origins — One Control, One Owner, One Materialization

Status: Ready
Created: 2026-08-10
Updated: 2026-08-10

A public origin — the external HTTPS address an app endpoint answers on — is one concept with three
implementations behind it. This plan makes it behave like one concept: one place to set it, one owner
per endpoint, and materialization that follows the active provider no matter what changed the
underlying port.

There is no `feature.md` here yet. What exists today is described across
[cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md) (the two Cloudflare providers) and
[automatic-runtime-app-ports/feature.md](../automatic-runtime-app-ports/feature.md) (the local port
each origin points at). This folder gets its `feature.md` in the PR that ships the work.

## Why the current shape is the defect

### Three surfaces for one question

An operator asking "what is the public address of this endpoint" has to know the active provider
first, because each provider answers somewhere else:

| Provider | Where the operator sets it | Shape |
| --- | --- | --- |
| `none` | `HOSTY_PUBLIC_ORIGIN_<KEY>` in the app's generic settings list ([settings.tsx:241](../../../apps/shell/src/app/shell/settings.tsx)) | full URL |
| `cloudflared` | `HOSTY_INGRESS_SUBDOMAIN` ([CloudflareIngress.cs:160](../../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs)) — a bare setting key with no control of its own | subdomain label |
| `cloudflare-remote` | a dedicated dialog on the endpoint row ([cloudflare-publish-control.tsx](../../../apps/shell/src/app/shell/pages/cloudflare-publish-control.tsx)) | subdomain label |

Two of the three take the same input — a label under a domain that comes from settings — and present
it completely differently; the third is effectively undiscoverable.

### Materialization is a property of the entry point, not of the system

`IIngressController` ([CloudflareIngress.cs:19](../../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs))
is already the provider abstraction, and its `ReconcileAsync` is already documented as "re-render the
whole config from the set of apps; declarative and idempotent; best-effort". Every path that can move
a port already calls it: install, operator reassignment, and boot.

But there is one implementation, `CloudflaredIngressController`, and it no-ops for every provider that
is not `cloudflared`. The API provider's materialization lives in `CloudflarePublicationService`,
reachable only from the publish HTTP endpoint — that is, only from an operator's explicit action.

The consequence is that a port moved by anything else leaves a public hostname pointing at a port
nothing listens on. This is not hypothetical: it already applies to the shipped operator reassignment
(`ReassignPortAsync` calls `ReconcileIngressAsync`, which does nothing under the API provider), and it
is why the automatic-port rehoming pass carries an interim guard that refuses to move a published
endpoint's port at all.

### The local config is state-dependent, and should not be

`CloudflaredIngressController.ReconcileAsync` builds routes only for apps that are up
([CloudflareIngress.cs:85](../../../apps/core/src/Haas.Hosty.Core/CloudflareIngress.cs)), so a stopped
app's hostname falls through to the catch-all `http_status:404`. That contradicts a model this
codebase already committed to: a port is reserved at install, an endpoint URL is projected onto a
**stopped** app, and `availability: "assigned"` exists precisely to say "stopped, but a durable target
exists". It also means every start and stop rewrites `config.yml` — the generated header says as much
("Regenerated on runtime app lifecycle changes") — and it forks the meaning of "desired state"
between the two providers, which is the single hardest part of putting them behind one contract.

## Target behavior

### One control per public endpoint

One dialog on the endpoint row owns the public origin, under every provider. It replaces the publish
dialog and the settings-list field, and gives the `cloudflared` subdomain override a home it never
had.

The form varies with the provider, the actions vary with reversibility:

- `none` — a full URL the operator types. Local write, instantly reversible, no confirmation.
- `cloudflared` — a subdomain label with the resulting hostname previewed from the base domain. Local
  write; the rendered `config.yml` follows on the next reconcile.
- `cloudflare-remote` — a subdomain label with the same preview. Applying pushes a tunnel route and a
  proxied CNAME; clearing **deletes a DNS record**, and adopting a pre-existing record stays an
  explicit choice that is never implied. Both keep their own confirmation step inside the shared
  dialog. A unified input must not turn "clear the field and save" into a silent remote deletion.

`HOSTY_PUBLIC_ORIGIN_*` is written under every provider, but as a projection, never as a second
source of truth. [`PublicOriginOwnership`](../../../apps/core/src/Haas.Hosty.Core/PublicOriginOwnership.cs)
remains the authority for who owns an endpoint's origin, and the `configure` guard stays. Treating the
stored setting as authoritative is what used to let derivation overwrite a published origin on every
start; the fix for that must not be undone by the merge.

### Both providers behind the same contract

`IIngressController` gains an implementation for `cloudflare-remote`, so materialization is chosen by
the provider rather than by whoever initiated the change. Every existing caller then does the right
thing for free — including callers that do not exist yet.

- `ReconcileAsync` takes every **installed** app rather than every running one, for both providers.
- The API implementation pushes only what actually differs: a publication stores the last written
  `serviceUrl`, so an unchanged route costs no API call. Without this, a boot that rehomes ten apps
  becomes ten tunnel-config PUTs.
- **It reconciles at boot**, like the local provider. That is what makes "who moved the port"
  genuinely irrelevant — the alternative, reconciling only on the change event, loses the change
  permanently if Core dies between the port move and the push, and nobody ever learns. Diffing keeps
  the steady-state cost at zero API calls, so boot only does work on the boot where something moved.
- A push that cannot happen — no connection, expired token, Cloudflare unreachable — records drift on
  the publication and surfaces it through the existing publication state machine and diagnostics
  endpoint. It does not retry on the startup path and it never stalls boot. Best-effort in the sense
  the contract already requires, with failure modes that are now "Cloudflare unreachable" rather than
  "file locked".
- An endpoint with no resolved URL is skipped by both providers, exactly as the local one already
  skips it. This is reachable but narrow: a port key appearing for the first time in an update, a
  runtime switch, or a live manifest gets no install-time reservation, so it carries no URL until the
  app's next start ([automatic-runtime-app-ports/feature.md](../automatic-runtime-app-ports/feature.md)).
  The route appears at that start; nothing special-cases it.
- The rehoming guard in
  [automatic-runtime-app-ports/feature.md](../automatic-runtime-app-ports/feature.md) is deleted in
  the same change: once a moved port re-points its own route, there is nothing to protect.

### The local config stops depending on runtime state

`cloudflared` renders a route for every installed app with a public endpoint and a resolved URL,
regardless of whether it is running. `config.yml` is then rewritten only by install, uninstall, a port
change, a subdomain change, or a public-origin change — not by every start and stop.

**Observable change:** a stopped app's hostname answers `502` from cloudflared (the route exists, the
local port does not) instead of `404` from the catch-all (no such hostname). This is the more honest
answer — "the address exists, the app is down" — but an external uptime check keyed on `404` will see
a different code, so it ships as a documented behavior change.

A route also appears at install, before the app has ever started, because the port reservation already
projects an endpoint URL there. This does not widen exposure: under `cloudflared` the operator owns
DNS, and the tunnel only routes what already resolves to it.

## Deliverables

- [ ] `ReconcileAsync` takes installed apps rather than running apps; `cloudflared` renders routes for
      stopped apps; catch-all behavior documented as changed.
- [ ] `IIngressController` implementation for `cloudflare-remote`, materializing publications as
      desired state, with per-endpoint diffing against the stored `serviceUrl`.
- [ ] Boot and lifecycle paths reconcile through the provider without special-casing it; a missing or
      invalid Cloudflare connection degrades without stalling, recording drift instead of retrying.
- [ ] Notify once when a port moves under provider `none`, naming the old and new local port.
- [ ] Remove the rehoming guard (`FindApiPublishedPortKeysAsync`) and its test, and the paragraph
      describing it in `automatic-runtime-app-ports/feature.md`.
- [ ] One public-origin dialog on the endpoint row, replacing `cloudflare-publish-control.tsx` and the
      settings-list field, with per-provider form and preview.
- [ ] Destructive and adoption paths keep explicit confirmation inside the unified dialog.
- [ ] `HOSTY_INGRESS_SUBDOMAIN` editable from that dialog under `cloudflared`.
- [ ] Ownership and the `configure` guard unchanged and re-tested through the new surface.
- [ ] `feature.md` for this folder; `cloudflare-ingress/feature.md` and
      `automatic-runtime-app-ports/feature.md` updated to point at it; docs index regenerated.
- [ ] Platform minor bump; `apps/shell` minor bump.
- [ ] Live verification against a real Cloudflare account (see Verification).

## Phases

### Phase 1 — One desired state

- [ ] `cloudflared` routes over installed apps.
- [ ] Reconcile-frequency and catch-all changes covered by tests.

### Phase 2 — The API provider behind the contract

- [ ] `cloudflare-remote` implementation, diffing, degradation on a missing connection.
- [ ] Guard removal in the ports feature.

### Phase 3 — One control

- [ ] Unified dialog, per-provider form, confirmations, subdomain override.
- [ ] Shell tests.

### Phase 4 — Documentation and verification

- [ ] `feature.md`, cross-links, index, version bumps.
- [ ] Live run.

## Deliberately not doing

- **Merging the two Cloudflare providers into one value.** Already decided in
  [cloudflare-ingress/plan.md](../cloudflare-ingress/plan.md): the tunnel's management mode is
  discoverable but the operator's intent is not. One dialog over three providers is the opposite of
  collapsing the providers themselves.
- **Making Core repair a `none`-provider origin after a port change.** Under `none` the URL points at
  the operator's own proxy, which Core does not configure and cannot inspect. A diagnostic is in
  scope; silently rewriting an operator's URL is not.

## Open questions

None. All three were settled on 2026-08-10:

- **Boot reconciliation for the API provider: yes**, with drift recorded rather than retried. Written
  into Target behavior above.
- **A moved port under `none`: a notification at the moment of the move, not a standing problem
  state.** Core cannot detect staleness there even in principle — an operator's manual origin is
  typically `https://app.example.com` with no port, pointing at their own reverse proxy, whose
  upstream Core neither writes nor can read. What Core does know is the event, so it says so once:
  "the local port of X moved from A to B; if you front it with your own proxy, update the upstream."
  A persistent badge would have to assert something Core cannot know.
- **A never-started endpoint with no URL: skipped**, same as today. Written into Target behavior.

## Verification

- `npm run core:build`, `npm run core:test`, `npm run shell:lint`, `npm run shell:test`,
  `npm run shell:build`, `npm run ci`
- `node scripts/docs-index.mjs --check`
- Unit: `cloudflared` renders a route for a stopped app and omits an uninstalled one; a start/stop
  cycle produces no config change; the API implementation pushes nothing when `serviceUrl` is
  unchanged and exactly one route when it moved; a missing connection yields no exception.
- Unit: ownership and the `configure` guard behave identically through the new surface, per provider.
- Live: move a port (operator reassignment and boot rehoming) under `cloudflare-remote` and confirm the
  hostname follows without an operator republish.
- Live: stop an app under `cloudflared` and confirm the hostname returns 502 rather than 404, and that
  starting it again needs no config rewrite.
- Live: clear a published origin from the unified dialog and confirm the DNS record is deleted only
  after explicit confirmation; adopt a pre-existing record from the same dialog.

## Links

- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — the two Cloudflare providers this unifies.
- [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md) — the local port an origin
  points at, and the rehoming guard this plan removes.
- [Core Public Origin](../core-public-origin/plan.md) — Core's own hostname, deliberately a separate
  feature.

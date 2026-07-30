# Core's Own Public Origin — Editable Where Every Other Origin Is

Status: Draft
Created: 2026-07-30
Updated: 2026-07-30

## Goal

Let an administrator set the address Core tells the world it lives at, from the surface that already
edits every other host setting, and publish it through Cloudflare the way an app endpoint is published.

The value is `HOSTY_CORE_PUBLIC_ORIGIN`. It is a CLI launch setting in `~/.hosty/config/launch.env`
([cli-bootstrap.md](../cli-bootstrap.md)) — a file Core neither owns nor holds a reference to. Shell shows
the resolved value read-only on the Dashboard, saying `not configured` when it is unset
([dashboard-page.tsx:489](../../../apps/shell/src/app/shell/pages/dashboard-page.tsx)); there is nowhere
in any UI to change it.

## Why this is its own feature

It arrived as a deliverable inside [cloudflare-ingress/plan.md](../cloudflare-ingress/plan.md) and was
moved out, because publishing the hostname is the easy half and not the risky one.

**This value is how an operator gets back in.** Its readers are the login pages
([HostyCoreApplication.cs:398](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)), the
bootstrap and invitation links
([AuthBootstrapService.cs:301](../../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs),
[UserManagementService.cs:490](../../../apps/core/src/Haas.Hosty.Core/UserManagementService.cs)), and the
environment of every runtime app
([RuntimeAppManifest.cs:2556](../../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs),
[LocalCommandRuntimeAdapter.cs:587](../../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs)).
A wrong value does not degrade a feature — it points the sign-in flow at a host that does not answer.
Every other live Core setting can be fixed from the UI it broke; this one can break that UI.

**The scope is one value, set once.** Nobody edits this weekly. The feature is not worth much complexity,
which is an argument for the smallest design that is safe, not for skipping it.

## Target behavior

A diff against [cli-bootstrap.md](../cli-bootstrap.md) and
[cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md).

**`HOSTY_CORE_PUBLIC_ORIGIN` becomes a live Core setting with the environment variable as its baseline**,
exactly the move the ingress provider already made: a persisted value wins over the env var, and clearing
it falls back. The CLI keeps writing `launch.env` and Core keeps reading it at startup — this adds an
override, it does not take ownership away.

Correcting the earlier claim in the ingress plan, which said this needs no restart because every reader
reads per request: **the app-environment readers do not.** `HOSTY_CORE_PUBLIC_ORIGIN` is injected into
each app's environment at container create / process start, so a change reaches running apps only when
they restart. The browser-facing readers (login, invitations) are per request and update immediately. So
a save takes effect in two stages, and the UI has to say so rather than imply the change is complete.

**Validation refuses what cannot work**: a value that is not an absolute `http`/`https` origin, one
carrying a path, query or userinfo, and the unspecified addresses. A loopback value is *accepted* — it is
the default state and the correct answer for a single-machine host.

**Recovery is designed before the setting ships.** Core keeps answering on its listen URL no matter what
this value says; the login page and the session cookie must keep working when reached over loopback even
while the setting names an unreachable public host. That property is what makes a wrong value survivable,
and it is the first thing to test rather than an afterthought.

**Publication through the Cloudflare workflow.** With the API provider connected, the operator publishes
Core's hostname under a label the same way an app endpoint is published: one proxied `CNAME`, one tunnel
rule to `http://localhost:{corePort}`, and the resulting origin written into this setting. The reconciler
already keys ownership on `(app id, endpoint key)`, so this needs a reserved id rather than a second store.
Unpublish reverses it and restores the previous value.

This replaces the read-only hint the ingress work shipped: diagnostics currently reports Core's address
with `not_configured` / `external` plus the CNAME target and service to create by hand
([cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md)). The hint stays for the `none` and
`cloudflared` providers, where nothing can publish it.

**Shell edits it where the other Core settings are edited** — the Settings → Core tab — with the two-stage
effect stated, and a publish affordance on the Ingress tab beside the app publications.

## Open questions

1. **Does publication belong in v1, or does the live setting ship alone?** The setting alone closes the
   "no UI for it" gap and leaves one manual DNS record. Publication removes the manual step but is the
   part that writes to Cloudflare on behalf of a value that can lock the operator out. Splitting is
   cheap; deciding to split late is not.
2. **What does an administrator see when they set an origin that does not resolve to this host?** A
   pre-save reachability probe is the obvious answer and it is not reliable — the address may only work
   from outside the host's own network. The alternative is to save it and make the loopback path
   obviously available. This question decides whether recovery is a designed flow or a documented one.
3. **Does `HOSTY_SHELL_PUBLIC_ORIGIN` follow?** It sits beside this one in `launch.env` and has the same
   shape. Answering "yes, identically" is fine; answering it late means doing this work twice.

## Deliverables

- [ ] Answer the open questions; the target behavior above is not final until question 1 is answered.
- [ ] `HOSTY_CORE_PUBLIC_ORIGIN` as a live Core setting: definition, group, validation, env baseline,
      persisted-wins-over-env, reset semantics, `/api/core/settings` exposure.
- [ ] Readers moved off the startup snapshot onto the live value, with the app-environment readers left
      explicitly on start-time injection and documented as such.
- [ ] Loopback recovery verified as a property: sign-in over the listen URL keeps working while the
      setting names an unreachable host.
- [ ] Two-stage effect surfaced in Shell: immediate for browser-facing links, on next start for apps.
- [ ] Shell field in the Settings → Core tab, replacing the read-only Dashboard display as the place to
      change it.
- [ ] Publication of Core's hostname through the Cloudflare API provider, with unpublish restoring the
      previous value (subject to question 1).
- [ ] The ingress diagnostics hint narrowed to the providers that cannot publish it.
- [ ] Platform minor bump; `apps/shell` minor bump.
- [ ] `feature.md` for this folder; `cli-bootstrap.md` updated to say the CLI setting is now a baseline;
      `cloudflare-ingress/feature.md` updated where the hint changes; docs index regenerated.

## Deliberately not doing

- **Taking `launch.env` away from the CLI.** Core gains an override, not ownership. The CLI still writes
  the file and Core still reads it at startup; inverting that split is a much larger change than this
  feature justifies.
- **Deriving the origin by probing interfaces or trusting the request `Host` header.** The header is
  chosen by the sender, and an allowlist derived from it lets a request name its own redirect target —
  recorded here because it is the obvious shortcut and it is not safe. See
  [advertised-app-origins/plan.md](../advertised-app-origins/plan.md), which rejected the same idea for
  the same reason.
- **A host-wide "public address" that both this and the advertised-app-origin setting derive from.** They
  answer different questions (one origin for Core versus a host address for LAN clients) and collapsing
  them would give one value two meanings.

## Verification

- `npm run core:build`, `npm run core:test`, `npm run shell:test`, `npm run shell:build`, `npm run ci`,
  `node scripts/docs-index.mjs --check`.
- Unit: env baseline versus persisted override and reset; validation refuses path/query/userinfo and the
  unspecified addresses while accepting loopback; invitation and login-page origins follow the live value.
- Live: set an origin, confirm a fresh invitation link carries it while a running app still reports the
  old one until restarted; set a deliberately unreachable origin and confirm sign-in over the listen URL
  still works and the setting can be cleared from there; with Cloudflare connected, publish and unpublish
  Core's hostname and confirm the previous value returns.

## Links

- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — where this deliverable came from, and the
  diagnostics hint it replaces.
- [CLI Bootstrap](../cli-bootstrap.md) — `launch.env` and the CLI settings this makes a baseline.
- [Advertised App Origins](../advertised-app-origins/plan.md) — the adjacent "what address do we tell
  clients" problem, for LAN endpoints rather than Core itself.
- [Auth And Gateway Model](../auth-gateway/feature.md) — the redirect allowlist and session rules a wrong
  origin would break.

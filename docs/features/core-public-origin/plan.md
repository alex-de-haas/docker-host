# Core's Own Public Origin — Editable Where Every Other Origin Is

Status: Draft
Created: 2026-07-30
Updated: 2026-09-01

## Goal

Let an administrator set the address Core tells the world it lives at, from the surface that already
edits every other host setting, and publish it through Cloudflare the way an app endpoint is published.

The value is `HOSTY_CORE_PUBLIC_ORIGIN`. It is a CLI launch setting in `~/.hosty/config/launch.env`
([cli-bootstrap.md](../cli-bootstrap.md)) — a file Core neither owns nor holds a reference to. Shell shows
the resolved value read-only on the Dashboard, saying `not configured` when it is unset
([dashboard-page.tsx:504](../../../apps/shell/src/app/shell/pages/dashboard-page.tsx)); there is nowhere
in any UI to change it.

## Why this is its own feature

It arrived as a deliverable inside [cloudflare-ingress/plan.md](../cloudflare-ingress/plan.md) and was
moved out, because publishing the hostname is the easy half and not the risky one.

**This value is how an operator gets back in.** Its readers are the login pages
([HostyCoreApplication.cs:543](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)), the
bootstrap and invitation links
([AuthBootstrapService.cs:301](../../../apps/core/src/Haas.Hosty.Core/AuthBootstrapService.cs),
[UserManagementService.cs:490](../../../apps/core/src/Haas.Hosty.Core/UserManagementService.cs)), and the
environment of every runtime app
([RuntimeAppManifest.cs:3035](../../../apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs),
[LocalCommandRuntimeAdapter.cs:687](../../../apps/core/src/Haas.Hosty.Core/LocalCommandRuntimeAdapter.cs)).
A wrong value does not degrade a feature — it points the sign-in flow at a host that does not answer.
Every other live Core setting can be fixed from the UI it broke; this one can break that UI.

Since this plan was written the reader list has grown — mcp-oauth and core-mcp made the value part of
the protocol contract with external clients, not just link material: it is the OAuth issuer and every
endpoint in `/.well-known/oauth-authorization-server`, the RFC 9728 protected-resource document for
`/api/mcp`, the `WWW-Authenticate` pointer on MCP 401s, and both app SDKs default their
authorization-server origin from it. A wrong value now also breaks flows the operator cannot see from
their own browser.

**The scope is one value, set once.** Nobody edits this weekly. The feature is not worth much complexity,
which is an argument for the smallest design that is safe, not for skipping it.

## Target behavior

A diff against [cli-bootstrap.md](../cli-bootstrap.md) and
[cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md).

**`HOSTY_CORE_PUBLIC_ORIGIN` becomes a live Core setting with the environment variable as its baseline**,
exactly the move the ingress provider already made: a persisted value wins over the env var, and clearing
it falls back. This adds an override; where the baseline env var comes from is not this plan's
concern — today the CLI writes it from `launch.env`, and once
[core-runtime-parameters](../core-runtime-parameters/plan.md) retires that file the variable remains
an ambient override with the same semantics. The two plans do not wait for each other.

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
and it is the first thing to test rather than an afterthought. It largely holds today by construction
rather than intent — the session cookie's `Secure` flag follows the request scheme
(`CreateSessionAsync`'s `secureCookie: request.IsHttps`), and OAuth resource resolution already accepts
both the public origin and the listen URL — so the work is to pin it with tests before a refactor
quietly unifies it away. The headless escape hatch is
`hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN`, owned by
[core-runtime-parameters](../core-runtime-parameters/plan.md).

**Publication through the Cloudflare workflow.** With the API provider connected, the operator publishes
Core's hostname under a label the same way an app endpoint is published: one proxied `CNAME`, one tunnel
rule to `http://localhost:{corePort}`, and the resulting origin written into this setting. The reconciler
already keys ownership on `(app id, endpoint key)`, so this needs a reserved pair (`hosty.core` plus an
endpoint key) rather than a second store — but no synthetic app record: the service layer forks (a
`PublishCoreAsync` beside the app path) and writes the result into the Core settings store instead of an
app's settings. The setting is written last, only after the reconciler's read-back confirms route and
DNS. Unpublish reverses it and restores the previous value, which the publication record itself
carries — but only while the current setting still equals the published origin: an administrator who
edited the value after publishing has made a newer choice, and unpublish must not overwrite it with a
stale one.

This replaces the read-only hint the ingress work shipped: diagnostics currently reports Core's address
with `not_configured` / `external` plus the CNAME target and service to create by hand
([cloudflare-ingress/feature.md](../cloudflare-ingress/feature.md)). The hint stays for the `none` and
`cloudflared` providers, where nothing can publish it.

**Shell edits it where the other Core settings are edited** — the Settings → Core tab — with the two-stage
effect stated, and a publish affordance on the Ingress tab beside the app publications.

## Decisions (owner, 2026-09-01)

The three original questions are answered:

1. **Publication ships in v1.** The setting alone would close the "no UI for it" gap but leave the
   manual DNS step this feature exists to remove. The design keeps the split cheap — every publication
   deliverable sits behind the setting ones — but both halves land in this iteration.
2. **Recovery is a designed flow, and every network judgment is advisory.** Validation refuses only
   what is wrong by form (see Target behavior); reachability is never a refusal — the same position the
   ingress locality check already records ("reported, never a refusal") — and is answered after save by
   the ingress diagnostics, which with publication in v1 gain real states (`active`, `route_missing`,
   `dns_missing`, `dns_foreign`) for Core's own hostname. No pre-save probe.
3. **`HOSTY_SHELL_PUBLIC_ORIGIN` does not follow — it no longer exists.** Shipped code moved Shell's
   origin into its app record as `HOSTY_PUBLIC_ORIGIN_WEB`, owned by the record and editable like any
   app's; the CLI launch-settings comment records the move. The question dissolved between this plan's
   writing and now.

## Open questions

1. **Does docker apps' `HOSTY_CORE_ORIGIN` decouple from this value?** Today
   `BuildDockerCoreOrigin(EffectiveCorePublicOrigin)` rewrites a loopback value to
   `host.docker.internal` but passes a non-loopback one through — so once an origin is set, containers
   dial Core by its public name (out through the tunnel and back), even though
   `--add-host host.docker.internal:host-gateway` keeps the direct path available. localCommand apps
   already use `ListenUrl` unconditionally. Recommended: derive the docker value from `ListenUrl` with
   the same loopback rewrite, making the public origin browser-only and shrinking a wrong value's blast
   radius to links and OAuth metadata. Must be decided before the setting goes live — publication in v1
   turns the current behavior into a silent side effect of one click — and needs a check that no app
   relies on dialing Core by its public name.

## Deliverables

- [x] Answer the original open questions — decided 2026-09-01, recorded above; the answer to the
      publication question makes the target behavior final.
- [ ] Decide the `HOSTY_CORE_ORIGIN` decoupling (open question 1) and implement whichever way it
      lands.
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
      previous value only while the setting still equals the published origin (a newer manual edit
      wins).
- [ ] The ingress diagnostics hint narrowed to the providers that cannot publish it.
- [ ] Platform minor bump; `apps/shell` minor bump.
- [ ] `feature.md` for this folder; `cli-bootstrap.md` updated to say the CLI setting is now a baseline;
      `cloudflare-ingress/feature.md` updated where the hint changes; docs index regenerated.

## Deliberately not doing

- **Taking `launch.env` away from the CLI — here.** Core gains an override, not ownership. Retiring
  `launch.env` itself is real and decided, but it belongs to
  [core-runtime-parameters](../core-runtime-parameters/plan.md); this plan works identically before and
  after it lands.
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
  Core's hostname and confirm the previous value returns; edit the setting after publishing, unpublish,
  and confirm the manual edit survives.

## Links

- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — where this deliverable came from, and the
  diagnostics hint it replaces.
- [CLI Bootstrap](../cli-bootstrap.md) — `launch.env` and the CLI settings this makes a baseline.
- [Core Runtime Parameters](../core-runtime-parameters/plan.md) — retires `launch.env` and supplies
  the `hosty core settings` recovery path decision 2 relies on.
- [Advertised App Origins](../advertised-app-origins/plan.md) — the adjacent "what address do we tell
  clients" problem, for LAN endpoints rather than Core itself.
- [Auth And Gateway Model](../auth-gateway/feature.md) — the redirect allowlist and session rules a wrong
  origin would break.

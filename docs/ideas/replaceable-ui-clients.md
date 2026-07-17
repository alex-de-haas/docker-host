# Replaceable UI Clients — The `ui-client` Role And Primary Selection

Status: Idea
Created: 2026-07-17
Updated: 2026-07-17

## Motivation

Hosty needs two things that look like they pull in opposite directions:

- A **bootstrap channel**: a way to get a UI onto a fresh host from the CLI, because without Shell
  there is no UI at all — and Marketplace itself renders inside Shell, so it cannot deliver the
  first UI by construction. This exists: the distribution list plus `hosty setup`.
- A **replaceability story**: Shell is *one* UI client, not *the* UI client. Third parties should be
  able to build their own shells (or narrower UIs — a telemetry-only dashboard, a mobile-first
  shell) and distribute them through Marketplace or plain manifest installs, using the exact
  lifecycle every other app gets. The official Shell should be listed in Marketplace like anything
  else, and uninstalling it should be allowed.

The tension is smaller than it looks, because most of the separation already shipped:

- Bootstrap installs produce **ordinary app records** — same manifest, same lifecycle, same
  reviewed update flow. Distribution origin is provenance, not privilege ([generic-bootstrap.md](generic-bootstrap.md),
  [capabilities are not lifecycle grants](core-extension-model.md)).
- Core already copes with **no UI client at all**: the Shell origin resolves from the installed app
  record, and a null origin is a valid answer every caller must handle
  (`ShellPublicOriginResolver`, shipped with "Shell config belongs to Shell").
- Uninstalling a distribution-origin app pins its bootstrap choice to `enabled=false`, so the boot
  reconcile does not resurrect it.
- A domain-specific UI already exists in-tree: `telemetry-ui` is a plain app with a `ui` service
  that renders one domain and never pretends to be the host UI.

What remains is exactly one hardcode and one unowned decision:

1. Core identifies "the UI" **by app id**: `ShellPublicOriginResolver.ReadAsync` calls
   `GetAppAsync(ShellBootstrap.AppId)` — literally `hosty.shell`
   (`apps/core/src/Haas.Hosty.Core/ShellPublicOriginResolver.cs:61`). A third-party shell under any
   other id is invisible to Core as a UI.
2. With more than one shell installed, nothing says **which one Core sends browsers to** when it has
   to pick without context (login continuation, bootstrap completion, deep links).

This document defines the model that closes both gaps. It complements
[core-extension-model.md](core-extension-model.md) (this is a concrete instance of a multi-instance
contract with a designated default) and [hosty-app-sdk.md](hosty-app-sdk.md) (whose embedder
contract is the behavioral half of what a shell must implement).

## Current Architecture Findings

- `provides` is an established manifest axis: a validated list of platform capability slots
  (`RuntimeAppManifest.ValidateProvides`, `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs:1138`).
  The telemetry app already declares `"provides": ["otlp-collector"]`. `PlatformCapabilities`
  (`apps/core/src/Haas.Hosty.Core/PlatformCapabilities.cs`) maps known slots to start priority and
  optional provisioning; unknown slots are ignored, so new slots are backward-compatible.
- `ShellPublicOriginResolver` resolves the UI origin from the installed record — the operator's
  `HOSTY_PUBLIC_ORIGIN_<endpoint>` setting, else the loopback URL Core assigned — preferring the
  `web` endpoint key, falling back to any public endpoint. Null means "no UI client installed."
  The only wrong thing about it is the lookup key.
- Its consumers split into two groups with **different cardinality needs**:
  - **Send-a-browser-somewhere (needs exactly one origin):** `/login` pages and
    `RedirectAfterLogin` when no `returnTo` was provided (`HostyCoreApplication.cs:171-215`),
    first-admin bootstrap and recovery completion `RedirectTo`
    (`AuthBootstrapEndpoints.cs:37,54`), the `/apps/{appId}` deep link handed to CLI/agents
    (`ControlIdentityEndpoints.cs:66-77`), and the origin surfaced in `core/status`
    (`HostyCoreApplication.cs:143-156`).
  - **Allow-a-browser-in (needs every UI origin):** the per-request CORS policy
    (`ShellCorsPolicyProvider.cs`). With two shells installed, both must be able to call Core from
    the browser; CORS keyed to a single "primary" would break whichever shell is not primary.
- The bootstrap side needs no changes: the distribution list is release-owned, choices are
  operator-owned intent, enabling installs immediately through the same code path as boot, and
  disabling keeps the app (`SystemAppBootstrapService`). Shell stays a `defaultEnabled` entry.
- `returnTo` exists and works for the flow it belongs to — "go back where you came from" after
  login. It cannot answer "where does a context-free browser go": bootstrap completion, links
  minted by Core (notifications, agent deep links), or a bare visit to Core have no referrer worth
  trusting.

## Decisions

1. **Bootstrap and Marketplace are two channels to the same record, and stay that way.** The
   distribution list's only unique job is the chicken-and-egg: delivering the first UI client when
   no UI exists to install one. Everything after that is ordinary app lifecycle. The official Shell
   is additionally listed in Marketplace — same manifest, same feed, second storefront. No new
   install semantics anywhere.

2. **`ui-client` becomes a `provides` slot, and Core resolves UIs by role, not id.** Any app —
   first-party or third-party — that implements the UI-client contract declares
   `"provides": ["ui-client"]`. `ShellPublicOriginResolver` (renamed accordingly) enumerates
   installed apps by this slot instead of calling `GetAppAsync("hosty.shell")`. Per-app origin
   resolution is unchanged: `web` endpoint key preferred, public-origin setting else assigned
   loopback URL.

3. **"Primary UI" is a pure resolution over state, not a stamp written at install time.** Core
   settings gain one nullable field, `primaryUiAppId`. Resolution:

   1. If `primaryUiAppId` names an installed app that provides `ui-client` → that app.
   2. Else if exactly one installed app provides `ui-client` → that app.
   3. Else if several → the earliest-installed one, ties broken by ordinal app id.
   4. Else → null ("no UI client", the already-valid state).

   The properties fall out without any install-time mutation: the first shell is automatically
   primary (rule 2), installing a second never steals primary (rule 3 preserves the incumbent),
   switching is an explicit operator action (rule 1), and uninstalling the chosen shell degrades
   gracefully (a dangling pointer falls through to rules 2–4 and self-heals if the app returns).
   The default-browser model: every installed shell works when opened directly at its own URL;
   primary only decides where *Core-initiated* navigation lands.

   Rule 3's tiebreak is not hypothetical hygiene: `AppRecord.InstalledAt` is non-nullable and the
   registry already normalizes a `default` value to "now" on write (`AppRegistryStore.cs:116`), so
   the timestamp is always present — but two records can still carry the same instant, and an
   unordered "earliest" would let the primary UI silently swap between boots. Ordinal app id is a
   total order over a set that is unique by construction.

   **The set is "installed", and deliberately not narrower.** Two tempting filters are both wrong:

   - *Bootstrap-choice `enabled`* is not an app state at all. It is the operator's intent about
     future boots (`SystemAppBootstrap.cs:14`), and disabling it explicitly **keeps the app
     installed and running** — that is the panel's own contract ("disabling stops future installs
     but keeps the app until you uninstall it"). A bootstrap-disabled shell serving traffic on its
     port is a fully working UI; excluding it would send browsers nowhere while the shell they are
     looking at keeps rendering. There is no `Enabled`/`Disabled` field on `AppRecord` — that flag
     exists only for *users* (`UserDirectoryStore.cs:60`). Uninstall is the only removal, and it
     drops the record, so resolution over installed apps already excludes it; the choice-pinning
     that accompanies uninstall is about the boot reconcile, not about resolution.
   - *Running* would make the answer flap with runtime state: a restarting shell would lose primary
     mid-restart, and login continuation would resolve differently depending on when it was asked.
     Resolution answers "which UI does this host present", which is a property of what is installed;
     whether it happens to be up is the browser's problem to discover, and Core's existing null case
     already covers "no UI at all".

4. **CORS admits every installed `ui-client`, not just the primary.** `ShellCorsPolicyProvider`
   extends from one origin to the set of origins of all installed `ui-client` apps — the same set as
   Decision 3, for the same reasons. Multiple shells coexisting on different URLs is a feature, not a
   conflict: each has its own record, port, and origin. Domain UIs (telemetry-ui) are *not* in this
   set — per the trust model they call their own backends, not Core, from the browser.

   Restricting the set to running apps would buy nothing and cost correctness. A stopped shell
   serves no page, so no browser can originate a request from its origin; the header would go
   unused. The "stale origin gets hijacked" worry needs an attacker who can bind that host port,
   and an attacker with local code execution can read Core's data root directly — CORS is not the
   boundary holding there. Meanwhile the restriction would break the real case: a shell coming up
   would be denied its own origin for as long as the policy lags its runtime state.

5. **Uninstalling Shell — including the last shell — is always allowed.** Core already treats "no
   UI client" as valid, and the uninstall path already pins the bootstrap choice so boot does not
   resurrect it. The install dialog warns: "This is the host's only UI client. You can reinstall it
   from the CLI with `hosty setup`." No hard block: the CLI is the recovery path and does not
   depend on any UI by construction.

6. **The UI-client contract is small and explicit.** Claiming `provides: ["ui-client"]` commits an
   app to:
   - a public web endpoint (key `web` preferred) — the origin Core resolves;
   - the **embedder contract** from [hosty-app-sdk.md](hosty-app-sdk.md): embedding app UIs,
     handling `hosty:auth-required`, launch modes;
   - two **well-known routes**, which are the only URL shapes Core ever mints:
     - `/` — landing target for login continuation without `returnTo` and for bootstrap completion;
     - `/apps/{appId}` — the deep link Core hands to CLI/agents to open an app.

   Nothing else is promised. A shell's internal routing, features, and design are its own. This is
   the `ui-client` contract in [core-extension-model.md](core-extension-model.md) terms:
   multi-instance cardinality with a designated default.

   **The contract is not enforced by manifest validation.** `ValidateProvides` is deliberately
   shape-only — kebab token, no blanks, no duplicates — and explicitly tolerates slot names a newer
   Core would understand (`RuntimeAppManifest.cs:1134`). Teaching it that `ui-client` implies a
   public endpoint would put per-slot knowledge into the one layer that is currently slot-agnostic,
   and `otlp-collector` sets the precedent for the alternative: its requirements live with the
   capability (`PlatformCapabilities`), not in manifest shape rules. It would also re-litigate #203,
   where declarations stopped gating lifecycle. A `ui-client` with no public endpoint is not a
   validation error but a resolution input: it never resolves to an origin, so it is never primary
   and never in the CORS set — the same null-shaped answer Core already handles. If install-time
   feedback proves worth it, the right surface is an install-review warning, not a rejected
   manifest.

7. **Domain-specific UIs stay out of this mechanism entirely.** A telemetry-only UI, an alternative
   metrics dashboard, or any single-domain frontend is a plain app with a `ui` service — it does
   not claim `ui-client`, does not participate in primary resolution, and needs nothing from this
   design. A full third-party *telemetry replacement* is likewise the other axis: a `provides`
   slot (`otlp-collector`), not a UI concern. The role split — "renders the whole host" vs.
   "renders one domain" vs. "provides a capability" — is what keeps this design one setting instead
   of a routing table.

## Surfaces

- **Core settings** (`core-settings` store + `GET/PUT /api/core/settings`): the `primaryUiAppId`
  field. Null/blank clears the override back to automatic resolution, matching the existing
  clear-to-default convention of the settings endpoint.
- **Shell Core-settings section**: a "Primary UI" dropdown listing installed `ui-client` apps,
  visible only when more than one is installed (with one shell there is nothing to choose).
- **`core/status`**: keeps surfacing the resolved UI origin (now "primary UI origin"), plus the
  resolved primary app id so operators can see *why* browsers land where they land.
- **Uninstall dialog**: the last-ui-client warning from Decision 5.

## Migration

- Shell's manifest adds `"provides": ["ui-client"]`; it reaches installed hosts through the normal
  reviewed update flow (boot never advances manifest content by design).
- Until that update lands, the resolver keeps a legacy shim: an installed `hosty.shell` counts as a
  `ui-client` even without the slot. The shim is removed once the Shell release with the slot has
  shipped.
- No settings migration: absent `primaryUiAppId` plus a sole installed shell resolves identically
  to today's behavior. Wire compatibility of `core/status` is preserved (field addition only).

## Deferred

- **Marketplace listing of the official Shell.** Depends only on publishing the feed entry; no code
  in this design blocks or requires it.
- **Per-shell start priority.** `PlatformCapabilities` could give `ui-client` a start-priority so
  shells come up early in the fleet; not needed for correctness.
- **Notification links.** The notifications design will mint URLs against the primary UI via the
  same resolver; nothing extra to decide here.
- **Capability-slot conflict UX.** What Marketplace shows when installing a second app for a
  single-instance slot is a [core-extension-model.md](core-extension-model.md) question;
  `ui-client` is multi-instance and does not hit it.

# Core Settings

Status: Implemented (v1 — auth lifetimes; v2 — cloudflared ingress)
Created: 2026-07-13

## Motivation

Runtime apps have an operator settings surface (the manifest `settings` block → `AppSettingSummary`
→ the `POST /api/apps/{id}/configure` form in Shell). **Core has no equivalent.** Its own behavior
knobs — starting with the auth session/grant lifetimes added in
[auth-session-lifecycle](../features/auth-session-lifecycle/feature.md) — were environment-variable-only, read once at
startup and immutable for the process. Changing a session timeout meant editing `launch.env` and
restarting the whole app fleet.

`hosty config` is deliberately kept to launch mechanics (data root, ports, public origins). Core's
behavior settings do not belong there (they are not launch parameters, and a session TTL should not
require a restart). They belong on a Core-owned settings surface, editable from the browser.

## Decision: emulate the settings *shape*, not app *identity*

Core is the kernel, not an installed app. The [Core Extension Model](core-extension-model.md) makes
this load-bearing: sessions/authorization are explicitly *never pluggable*, and
[core-dev-target.md](core-dev-target.md) already **rejected** giving Core an `app.0.1` manifest
(Decision 4) or an entry in the Installed Apps list (Decision 5 — an app card drags in
install/uninstall/assignment semantics). Its chosen home is the **platform panel** opened from the
sidebar version block.

So Core does not become an app. Instead it **reuses the settings contract shape and the Shell form
components**, without the app identity:

| Reused | Not reused |
| --- | --- |
| The settings summary shape (`key`/`type`/`value`/`label`/`description`) | `AppSummary` / a record in `AppRegistryStore` |
| The Shell `SettingInput` form components | `POST /api/apps/{id}/configure` under a fake app id |
| The platform panel as the home | An Installed Apps card, a manifest, lifecycle verbs |

This is forward-compatible: if a full "Core" card is ever wanted, the panel's data model is exactly
what it would display (per core-dev-target).

## Design (v1)

- **Store.** `CoreSettingsService` owns `settings.json` in the core data root (`CoreSettingsStore`,
  schema `core-settings.0.1`), holding per-key overrides in hours. Effective value =
  persisted override → env var → built-in default. Env stays an ambient dev/fork override; the store
  simply wins when present. The initial read is synchronous so the service can expose auth lifetimes
  with no async warm-up window; writes are atomic temp+rename via `JsonStorage`.
- **Live apply.** `AuthLifetimes` moved off the startup singleton: it is registered as a transient
  resolved from `CoreSettingsService`, so every consumer (endpoints, `AppIdentityService`) reads the
  current value. Idle windows apply immediately, including to existing sessions (idle is recomputed
  from `LastSeenAt` on every revalidation); absolute windows apply to sessions/grants issued after the
  change (the cap is baked in at issue time). The UI copy states this.
- **Endpoints.** `GET/PUT /api/core/settings`, host-admin + CSRF via `CoreSessionAuthorization`
  (same guard as the bootstrap endpoints). The payload mirrors the per-app settings shape plus a
  `group` and `default`, so Shell renders it with the shared form.
- **UI.** A "Core settings" section in the existing `PlatformDialog`, above Extensions. The auth
  lifetimes are grouped (Admin session / App sessions / System-app sessions / CLI diagnostic grants).
  Saving PUTs the changed keys; Core returns the fresh snapshot (no restart affordance).

## Scope and sequencing

- **v1: the seven auth lifetimes.** The motivating case and the only Core behavior that was both
  env-only and painful to change (restart-to-apply).
- **v2 (shipped): the cloudflared ingress block** — provider, base domain, tunnel ID, credentials
  file. These moved off `HostyCoreRuntimeConfig` into a live `IngressSettings` record owned by
  `CoreSettingsService`, alongside the auth overrides in the same `settings.json` (the `ingress`
  section; schema stays `core-settings.0.1`, an additive change). The single ingress controller reads
  the live values and a save re-renders `config.yml` immediately, so switching cloudflared on/off is a
  settings edit, not a restart. The provider renders as a `select`; the `config.yml` output path stays
  launch-only. See [Cloudflare ingress](../features/cloudflare-ingress/feature.md).
- **User-management retention (shipped): disabled-user retention window** — a single numeric
  `HOSTY_USERS_DISABLED_RETENTION_DAYS` setting (default 10, `0` = never) in a `users` section of the
  same `settings.json` (additive; schema stays `core-settings.0.1`). It backs the `UserRetentionScheduler`
  that permanently deletes aged disabled users. Modeled on the update-check interval setting. See
  [user management](../features/user-management.md).
- **Candidates for later phases:** the trusted-proxy secret is also env-only Core behavior. It is
  deferred — a secret needs a masked/secret editor and rotation semantics.

## Links

- [Auth session lifecycle](../features/auth-session-lifecycle/feature.md) — where the TTLs are defined.
- [Core Extension Model](core-extension-model.md) — why Core is the kernel, not an app.
- [Core Launch Target](core-dev-target.md) — the platform panel that hosts this, and the rejected
  Core-as-app-card alternative.

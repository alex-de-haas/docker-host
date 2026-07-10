# System App Pages

Status: Idea
Created: 2026-07-10
Updated: 2026-07-10

## Motivation

Runtime apps can already declare `ui.entrypoint` and `ui.navigation`; Shell renders their pages from the app's own origin inside an authenticated iframe. System apps are currently excluded from all app navigation and appear only as inventory rows in Installed Apps.

UI-capable system apps such as Marketplace need their own pages without hardcoding a new Shell route and React implementation for each system capability. The page model should reuse the runtime-app UI contract while preserving a clear administrator-only boundary.

## Confirmed Direction

- System apps may expose separate Shell pages, analogous to runtime app pages.
- Page metadata reuses `ui.entrypoint` and `ui.navigation`.
- Shell places system app pages in a separate System group, not in the normal Apps group.
- System app pages are administrator-only in the first version.
- Pages use the existing app-origin iframe, authorization-code exchange, and app-local session model.
- Page visibility does not grant lifecycle controls or Core privileges.

## Current Behavior

- Core returns system apps to `host.admin` and filters them out for `host.user`.
- Shell already splits `runtimeApps` and `systemApps`, but derives UI navigation only from `runtimeApps`.
- `getAppPageLinks` already normalizes `ui.navigation` and falls back to the declared UI entrypoint.
- `/workspace?app=<id>&path=<path>` and the embedded workspace renderer are technically app-kind agnostic.
- Shell documentation explicitly says system apps never appear in Apps navigation.
- Core requires an enabled `host.admin` in every app identity flow (code issuance, exchange, revalidation) when the target is a system app, refusing with `system_app_admin_required`.
- `ui` metadata is permissive: an invalid entrypoint endpoint may fall back to another endpoint rather than fail manifest validation.

## Possible Approaches

### Approach A: Put System Apps In The Existing Apps Group

Pros:

- Small Shell change.

Cons:

- Mixes administrator platform capabilities with user-assigned apps.
- Weakens the meaning of the existing Apps group and assignment model.
- Makes role mistakes harder to see.

Not recommended.

### Approach B: Hardcode One Shell Route Per System App

Pros:

- Each page can look native to Shell.

Cons:

- Repeats the current Marketplace coupling.
- Requires Shell releases for independently updated system apps.
- Prevents third-party or optional system apps from contributing pages generically.

Not recommended.

### Approach C: Separate System Group, Shared App Page Contract

Pros:

- Reuses the proven runtime-app page and SSO machinery.
- Keeps navigation and access boundaries explicit.
- Lets system apps own and version their UI.
- Requires no marketplace-specific manifest fields.

Cons:

- Requires a Core authorization fix and availability UX.
- Cross-origin system pages cannot use Core browser cookies directly.

Recommended.

## Navigation Model

Shell derives two page-bearing groups:

```text
uiRuntimeApps = runtimeApps with ui pages visible to the current user
uiSystemApps  = systemApps with ui pages visible to host.admin
```

The sidebar contains:

- Core management pages;
- System, visible only to `host.admin`;
- Apps, containing ordinary assigned/unrestricted runtime apps.

Within System, each app uses the same parent item and nested `ui.navigation` page links as a runtime app. A headless system app with no `ui` block contributes no page. `hosty.shell` does not recursively display itself unless it explicitly declares an external UI contract, which it should not in the first version.

The canonical deep link should be system-specific for authorization clarity, for example:

```text
/system-apps/<app-id>?path=/settings
```

It reuses the same workspace launch and iframe engine as `/workspace`. No physical Next.js route or native component is created per system app. The existing `/marketplace` route can temporarily redirect to the Marketplace system-app page.

## Manifest Contract

The page fields remain:

```json
{
  "ui": {
    "entrypoint": {
      "endpoint": "web",
      "path": "/"
    },
    "navigation": [
      { "label": "Overview", "path": "/" },
      { "label": "Settings", "path": "/settings" }
    ]
  }
}
```

System placement and access derive from the Core-approved system role, not from a page-controlled placement field. A system app cannot nominate itself into arbitrary Core navigation sections or lower its required Host role.

For a system-role app, Core should validate UI strictly:

- entrypoint endpoint exists and resolves to an HTTP(S) endpoint;
- paths are root-relative and contain no scheme, host, query, or fragment;
- duplicate page paths are rejected;
- the app has no silent fallback to the first unrelated endpoint.

Ordinary `app.0.1` UI behavior may retain permissive compatibility until a manifest-version migration is planned. Security-sensitive system role and UI semantics must fail closed on an unsupported older Core.

## Authentication And Authorization

Navigation hiding is not the security boundary. Core must enforce system-app access in every app identity flow:

1. Load the installed app record before issuing a launch/open code.
2. If the app is a system app, require a current enabled `host.admin`.
3. Repeat the check during code exchange and token revalidation so a role downgrade revokes access.
4. Keep the identity token audience bound to the system app id.
5. Require the system app backend to revalidate the token and enforce `host.admin` server-side.

The system app receives its app-scoped identity, not Core's session cookie or local control secret. Browser calls to Core remain Shell-owned; the app backend uses only explicitly supported app-service APIs.

## Availability And Recovery UX

An installed UI-capable system app should remain visible to administrators when it is stopped, unhealthy, or temporarily incompatible. Its page entry becomes disabled/status-marked instead of disappearing. Direct navigation renders a Shell-owned unavailable surface with:

- current runtime/health state;
- a link to the System Apps inventory;
- logs/repair guidance allowed by policy;
- no stale iframe launch attempt.

Runtime state alone may not be enough for a ready/not-ready decision. The implementation should expose or derive an explicit UI endpoint readiness result rather than treating every running process as ready.

## Relationship To Lifecycle Controls

System pages and system lifecycle actions are independent:

- exposing pages does not enable stop, remove, update, backup, or settings controls;
- Installed Apps remains the lifecycle/status inventory;
- each system action continues to follow system-app policy and Core authorization;
- safe reviewed system-app updates remain tracked separately.

## Migration

- Add `uiSystemApps` grouping in Shell using the existing page-link helper (shipped in Shell 0.26.0).
- Generalize runtime-app-named navigation components so both app kinds can use them (shipped in Shell 0.26.0).
- Add the System sidebar group and canonical system-app route (shipped in Shell 0.26.0: `/system-apps/<app-id>?path=...` over the shared workspace engine; the group hides when empty, stopped apps stay listed but disabled, non-admins are redirected).
- Enforce admin authorization in Core launch, exchange, and revalidation paths (shipped in platform 0.37.1).
- Add strict system UI validation (shipped in platform 0.39.1: `role: system` manifests with a `ui` block require an explicit entrypoint endpoint resolving to a declared http(s) endpoint, root-relative page paths without scheme/host/query/fragment, and unique page paths; ordinary manifests keep the permissive behavior).
- Move hardcoded Marketplace UI to `hosty.marketplace` and retain `/marketplace` as a temporary alias.
- Leave headless Shell and telemetry behavior unchanged (still true: neither declares `ui`, so the System group stays hidden until the first UI-capable system app installs).

## Conflicts With Existing Features

- [Core App Shell](../features/core-app-shell.md) says only non-system apps appear in app navigation. The new model preserves that Apps rule but adds a separate System group.
- [Shell Access And System Apps](../features/shell-access-and-system-apps.md) treats system apps as inventory-only. Pages revise visibility, not lifecycle restrictions.
- [Core Extension Model](core-extension-model.md) describes generic UI contribution points. Ordinary system-app pages should reuse `ui`, while native Shell contribution slots remain a separate future problem.
- [Marketplace As A System App](marketplace-system-app.md) depends on this model to remove the hardcoded Shell marketplace route.

## Risks

- **Authorization bypass.** A known system app id/origin must not let a non-admin mint an app session.
- **Native-looking phishing.** System app content is iframe content, not trusted Shell chrome. Preserve origin separation and avoid letting apps imitate Core dialogs outside their frame.
- **Navigation instability.** Hiding a stopped app makes recovery harder; keeping a stale live link creates confusing browser errors. Use a disabled/status state.
- **Role confusion.** Do not let a manifest choose its required Host role in the first version.
- **Contract drift.** Standardize on the implemented `ui.navigation` term; do not introduce parallel `ui.pages` vocabulary.

## Open Questions

- Question: Should the canonical route reuse `/workspace` or use `/system-apps/<id>`?
  - Current answer: both can use the same renderer, but a separate route makes admin guards and deep links clearer.
  - Recommendation: use `/system-apps/<id>?path=...` as canonical and keep one shared workspace engine.
- Question: Should stopped system app pages remain in navigation?
  - Current answer: disappearing pages hide the recovery path.
  - Recommendation: keep them visible but disabled with status and an Installed Apps link.
- Question: Can a future system app expose pages to ordinary users?
  - Current answer: no current assignment or authorization model supports that safely.
  - Recommendation: keep all system pages admin-only; add an explicit separate interface/role contract only when a concrete use case exists.
- Question: Does every system app UI require a new manifest schema?
  - Current answer: page metadata already exists, but system role/access must fail closed.
  - Recommendation: reuse `ui` fields while versioning the system-role contract or requiring a compatible Core version.

## Current Recommendation

Implement Approach C: a separate administrator-only System group backed by the existing app page, iframe, and SSO machinery. Use no app-specific Shell routes beyond temporary compatibility aliases.

Close the Core authorization gap before exposing the first system app page. Marketplace should be the first concrete consumer; Shell and telemetry remain headless unless their manifests explicitly add external UI.

## Links

- [Core Extension Model](core-extension-model.md) - system apps as the extension delivery mechanism.
- [Marketplace As A System App](marketplace-system-app.md) - first concrete UI-capable system app.
- [Core App Shell](../features/core-app-shell.md) - current runtime app navigation and iframe behavior.
- [Shell Access And System Apps](../features/shell-access-and-system-apps.md) - current administrator/system visibility policy.
- [Direct Origin Runtime App UI](../features/direct-origin-runtime-app-ui.md) - app-origin SSO and session flow.

## Notes

This document records the desired direction but does not authorize implementation.

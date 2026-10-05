# System App Pages

Status: Draft
Created: 2026-07-10
Updated: 2026-10-05

## Goal And Approval Boundary

Retain the originating proposal for UI-capable system apps to own Shell pages through the shared `ui.entrypoint`, `ui.navigation`, app-origin iframe, and app-local session contracts. The generic page foundation and Marketplace storefront have shipped; their current behavior belongs in the linked feature documents below.

The original proposal also called for a separate administrator-only System group. Current Shell navigation combines ordinary and system apps in one Apps group, and Core authorizes both through assignments. Restoring the original group or restricting all system pages to administrators would change that shipped policy. This Draft preserves the proposal for reconciliation and does not authorize that change or implementation of the remaining work.

## Originating Direction

- System apps may expose separate Shell pages, analogous to runtime app pages.
- Page metadata reuses `ui.entrypoint` and `ui.navigation`.
- The proposed placement is a separate System group, outside the normal Apps group.
- The original proposal limits system app pages to administrators; reconciling this with current assignment-based access is an open decision.
- Pages use the existing app-origin iframe, authorization-code exchange, and app-local session model.
- Page visibility does not grant lifecycle controls or Core privileges.

## Current Baseline And Ownership

- [Shell Navigation](../shell-navigation/feature.md) owns the current Apps group and canonical `/workspace` route; `/system-apps/<id>` is a compatibility route.
- [Shell Access And System Apps](../shell-access-and-system-apps/feature.md) owns the shared assignment rule and the separate checks for administrative authority.
- [Core App Shell](../core-app-shell/feature.md) owns the shared workspace renderer, stopped-app visibility, and app-owned authentication flow.
- [Runtime App Manifest](../runtime-app-manifest/feature.md) owns the existing system-role and UI validation contract.
- [Marketplace System App](../runtime-app-marketplace/feature.md) owns the shipped storefront. The originating runtime smoke gate remains in the [legacy vertical-slice plan](../../planning/marketplace-system-app.md); its MCP proposal stays in its [owning plan](../runtime-app-marketplace/plan.md).

The target sections below preserve the original page proposal. Navigation and authorization changes require an explicit owner decision against this baseline; they must not be treated as missing parts of the already shipped generic page foundation.

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

- Would reintroduce the Shell/Marketplace coupling removed by the extraction.
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

- Requires a decision on the navigation/access policy and an explicit availability UX.
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

Within the proposed System group, each app uses the same parent item and nested `ui.navigation` page links as a runtime app. A headless system app with no `ui` block contributes no page. `hosty.shell` does not recursively display itself unless it explicitly declares an external UI contract, which it should not in this proposal.

The canonical deep link should be system-specific for authorization clarity, for example:

```text
/system-apps/<app-id>?path=/settings
```

It would reuse the same workspace launch and iframe engine as `/workspace`. No physical Next.js route or native component is created per system app. Marketplace already owns its storefront; this proposal does not recreate the removed hardcoded `/marketplace` implementation.

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

Preserve the existing strict UI validation for a system-role app:

- entrypoint endpoint exists and resolves to an HTTP(S) endpoint;
- paths are root-relative and contain no scheme, host, query, or fragment;
- duplicate page paths are rejected;
- the app has no silent fallback to the first unrelated endpoint.

Preserve ordinary `app.0.1` UI compatibility within the existing manifest contract. Any newly approved security-sensitive system role or UI semantics must fail closed on an unsupported older Core.

## Authentication And Authorization

Navigation hiding is not the security boundary. If the owner approves the original administrator-only policy, Core would need to enforce that policy in every app identity flow. The checks below describe that conditional target; the current assignment-based policy remains the baseline until the owner decides:

1. Load the installed app record before issuing a launch/open code.
2. If the app is a system app, require a current enabled `host.admin`.
3. Repeat the check during code exchange and token revalidation so a role downgrade revokes access.
4. Keep the identity token audience bound to the system app id.
5. Require the system app backend to revalidate the token and enforce `host.admin` server-side.

The system app receives its app-scoped identity, not Core's session cookie or local control secret. Credentialed Core management calls remain in the authorized client/server boundary; the app backend uses only explicitly supported app-service APIs.

## Availability And Recovery UX

An installed UI-capable system app should remain visible to administrators when it is stopped, unhealthy, or temporarily incompatible. Its page entry becomes disabled/status-marked instead of disappearing. Direct navigation renders a Shell-owned unavailable surface with:

- current runtime/health state;
- a link to the Dashboard installed-apps inventory;
- logs/repair guidance allowed by policy;
- no stale iframe launch attempt.

Runtime state alone may not be enough for a ready/not-ready decision. The implementation should expose or derive an explicit UI endpoint readiness result rather than treating every running process as ready.

## Relationship To Lifecycle Controls

System pages and system lifecycle actions are independent:

- exposing pages does not enable stop, remove, update, backup, or settings controls;
- Dashboard remains the installed-app lifecycle/status inventory;
- each system action continues to follow system-app policy and Core authorization;
- safe reviewed system-app updates remain tracked separately.

## Remaining Deliverables

- [ ] Reconcile the original separate System group and administrator-only page policy with the current unified Apps group and assignment-based Core access; obtain explicit approval before changing either.
- [ ] Decide whether `/system-apps/<id>` should regain canonical status or remain a compatibility route over `/workspace`, while keeping one shared workspace engine.
- [ ] Specify and implement any missing UI endpoint readiness and unavailable-page behavior: retain stopped/unhealthy entries, show status and the inventory/repair path, and avoid stale iframe launches. Reuse [App Readiness](../app-readiness/feature.md) rather than duplicating its runtime-health contract.
- [ ] Define a compatibility requirement for any newly approved system-page semantics so unsupported older Core versions fail closed.
- [ ] Verify the resulting navigation, access, recovery, and headless-manifest cases below, and update the owning Shell/access/manifest feature documents with the shipped result.

The shared page-link helper, workspace renderer, system-role/UI validation, and Marketplace extraction are already shipped foundations, not pending deliverables here. Page participation follows each app's current `ui` metadata: Shell has no external page contract, while Telemetry declares UI pages. Do not make either headless through an app-specific rule.

## Conflicts With Existing Features

- [Shell Navigation](../shell-navigation/feature.md) places ordinary and system apps together in Apps and canonicalizes the old system-specific route to `/workspace`. The original proposal would revise both choices.
- [Shell Access And System Apps](../shell-access-and-system-apps/feature.md) uses assignments for ordinary users, including assigned system apps. An administrator-only system-page policy would require an explicitly approved access-model change.
- [Core App Shell](../core-app-shell/feature.md) owns generic app pages and their embedding. Reuse that engine rather than adding a second renderer.
- [Core Extension Model](../core-extension-model/plan.md) describes broader UI contribution points. Ordinary system-app pages reuse `ui`; native Shell contribution slots remain separately owned work.
- [Marketplace System App](../runtime-app-marketplace/feature.md) already uses generic app pages and Core-confirmed installation. This Draft grants no Marketplace lifecycle authority.

## Risks

- **Authorization bypass.** A known system app id/origin must not let a user bypass the approved app-access policy.
- **Native-looking phishing.** System app content is iframe content, not trusted Shell chrome. Preserve origin separation and avoid letting apps imitate Core dialogs outside their frame.
- **Navigation instability.** Hiding a stopped app makes recovery harder; keeping a stale live link creates confusing browser errors. Use a disabled/status state.
- **Role confusion.** Keep any approved system-page role policy Core-owned; a page-controlled field cannot weaken it.
- **Contract drift.** Standardize on the implemented `ui.navigation` term; do not introduce parallel `ui.pages` vocabulary.

## Open Questions

- Question: Should the original separate System group and administrator-only policy replace the shipped unified Apps group and assignment model?
  - Current answer: current navigation and access deliberately share one app model.
  - Decision needed: retain the original proposal only if the owner explicitly approves that policy change.
- Question: Should the canonical route reuse `/workspace` or use `/system-apps/<id>`?
  - Current answer: `/workspace` is canonical and `/system-apps/<id>` is a compatibility route.
  - Original recommendation: make `/system-apps/<id>?path=...` canonical over one shared engine; reconsider alongside the navigation decision.
- Question: Should stopped system app pages remain in navigation?
  - Current answer: disappearing pages hide the recovery path.
  - Recommendation: keep them visible but disabled with status and a Dashboard inventory link.
- Question: Can a system app expose pages to ordinary users?
  - Current answer: the shipped model permits explicitly assigned users; administrative operations keep their separate checks.
  - Original recommendation: keep all system pages admin-only. Reconcile that proposal with the current model before treating it as a requirement.
- Question: Does every system app UI require a new manifest schema?
  - Current answer: page metadata already exists, but system role/access must fail closed.
  - Recommendation: reuse `ui` fields while versioning the system-role contract or requiring a compatible Core version.

## Current Recommendation

Keep the shared app-page, iframe, and app-local session contracts. Resolve the navigation/access conflict before approving Approach C or changing Core authorization. Marketplace is already a concrete consumer, and page visibility must remain separate from lifecycle or administrative authority.

## Verification

- Cover administrator, assigned ordinary-user, and unassigned-user navigation and direct app entry under the explicitly approved access policy; recheck after assignment removal and role changes.
- Verify any canonical-route change has terminating compatibility redirects and preserves the app/path deep link through refresh.
- Exercise running, stopped, unhealthy, and incompatible UI endpoints; verify unavailable pages show a recovery path without a stale iframe launch.
- Keep headless manifests out of page navigation, prevent recursive Shell embedding, and derive Telemetry/other page links from their actual `ui` contracts.
- Preserve manifest UI validation, app-bound identity audience, and app-server authorization; showing a page must not add lifecycle permission.
- For this documentation migration, check local links, `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs`, and `git diff --check`. Runtime acceptance belongs to an explicitly approved implementation.

## Links

- [Core Extension Model](../core-extension-model/plan.md) - system apps as the extension delivery mechanism.
- [Marketplace System App](../runtime-app-marketplace/feature.md) - the shipped UI-capable system app and its current authority boundary.
- [Core App Shell](../core-app-shell/feature.md) - current runtime app navigation and iframe behavior.
- [Shell Access And System Apps](../shell-access-and-system-apps/feature.md) - current administrator/system visibility policy.
- [Direct Origin Runtime App UI](../direct-origin-runtime-app-ui/feature.md) - app-origin SSO and session flow.

## Notes

This Draft retains the originating intent and remaining decisions. It does not authorize implementation or override the current navigation/access model.

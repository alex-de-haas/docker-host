---
created: 2026-06-25
updated: 2026-10-22
summary: The optional Marketplace app that owns catalog discovery and requests Core-confirmed installations.
components: [apps/marketplace]
---

# Marketplace System App

The web UI uses the [shared Hosty visual foundations](../design-system/feature.md): local IBM Plex
Sans/JetBrains Mono fonts, ink surfaces, lime interaction states and its app chart accent.

## Description

Hosty Marketplace is the optional first-party `hosty.marketplace` system runtime app. It owns catalog discovery, renders the storefront on its own app origin, and prepares a Core-confirmed installation request when an administrator chooses Install.

Core has no Marketplace or catalog domain API. It understands runtime-app manifests and generic app-owned feed documents only. Marketplace declares `apps.install` to request installations. Core validates its app/user credentials and requires a separate administrator confirmation before executing a request.

## Ownership Boundary

| Concern | Owner |
| --- | --- |
| Catalog URL, fetch, schema, diagnostics, cards, and details | Marketplace app |
| Catalog entry metadata and `feedsUrl` | Catalog publisher |
| `feeds.json`, manifests, and runtime artifacts | Runtime app repository |
| Feed validation, install/update plans, apply, backups, and installed state | Core |
| Installation settings and preliminary review | Shared SDK dialog inside the initiating app |
| Final administrator confirmation | Core-origin page |

Marketplace failure affects discovery only. Direct installs and lifecycle operations for installed apps remain available.

## Catalog Source

Marketplace persists one HTTP(S) catalog URL in its app-owned settings file. Its `/settings` page
works standalone and as the manifest's `ui.settings` surface in Shell. `GET/PUT /api/settings`
requires an authenticated app administrator. Writes carry the previous source URL for stale-write
protection and reject non-HTTP(S) values and embedded credentials.

The file initializes once from the former `HOSTY_MARKETPLACE_SOURCE_URL` environment value or the
official catalog default. Atomic writes use owner-only permissions; corrupt existing storage is
reported rather than silently reset. Core preserves the retired value for migration but removes it
from the manifest editor. Multiple sources, federation and local host paths are not supported.

Marketplace requires catalog schema `marketplace.0.2`. Unsupported, malformed, oversized, or unreachable input is reported by the app and does not fall back to a Core catalog or an older schema.

## Catalog Entry Contract

The catalog index contains display-ready entries. Entry details remain catalog-owned and include publisher, category, tags, summary, icon, screenshots, description URL, signer identity, and an app-owned feed document URL.

```json
{
  "schemaVersion": "marketplace.0.2",
  "source": {
    "name": "Hosty Official Catalog",
    "url": "https://github.com/alex-de-haas/hosty-catalog"
  },
  "apps": [
    {
      "id": "com.example.notes",
      "name": "Notes",
      "publisher": {
        "name": "Example Co",
        "url": "https://example.invalid"
      },
      "category": "Productivity",
      "tags": ["notes"],
      "display": {
        "summary": "Take notes.",
        "icon": "https://example.invalid/catalog/notes/icon.png",
        "descriptionUrl": "https://example.invalid/catalog/notes/description.md"
      },
      "feedsUrl": "https://example.invalid/notes/feeds.json"
    }
  ]
}
```

Catalog entries do not contain inline `feeds[]`, resolved manifests, installed version, followed-feed state, health, or update availability. Marketplace may fetch `feedsUrl` to display its choices and diagnostics, but Core repeats authoritative feed and manifest validation during lifecycle planning and apply.

## App UI And Authentication

The Marketplace manifest declares a strict `ui.entrypoint` and administrator navigation. Shell lists it through the generic System Apps UI and opens it in the existing app-origin iframe flow. Core issues a one-time app authorization code; Marketplace exchanges it, creates its own HTTP-only app session, and revalidates identity using the standard runtime-app service token contract.

Marketplace catalog and installed-state API routes are gated on that identity: the shared authorization check requires an `active` session whose `hostRole` is `host.admin`, and it runs before the route resolves any data. A missing token is `401 app_identity_required`, an active non-admin is `403 system_app_admin_required`, and an unreachable or misconfigured Core is `503`. The gate covers the catalog routes and the two installed-state routes alike — the installed-app id roster and per-app update availability are host state, so they never leave the Marketplace origin without an administrator session, and an unauthorized request is refused before Marketplace spends its service token on Core.

The installed-list route calls Core's existing `GET /api/apps` with Marketplace's service credential
and the current app identity in `X-Hosty-App-Identity`. Core revalidates the actor and `apps.read`;
Marketplace forwards no Core session cookie. The server returns only display metadata and navigation
links, excluding settings, mounts and local source paths. Missing, revoked and unreachable authority
produces an explicit failure with Retry installed apps, rather than a successful empty list.
Per-app detail update probes retain their existing best-effort availability behavior.

Discover contains category chips, cards and search across names, IDs, publishers, categories,
summaries and tags. Installed lists every app returned by Core, including apps absent from the
configured catalog, with its installed name/version, recorded feed or direct/local source, runtime,
and last known update verdict. Desktop rows reserve a shared action-column width so installed
versions stay aligned when rows offer different actions. Narrow screens stack version and action
information beneath each app. Catalog membership does not determine provenance. Failed update
checks retain an explicit incomplete state. Running apps with UI entries have installation-bound
Core Open links; stopped apps show disabled Open and keep Manage. Manage targets the installed
Shell's public/browser endpoint and existing app management route; it does not guess a port.
Headless apps retain Manage without an invented UI destination. Catalog metadata enriches icons and
detail links without asserting installed permissions or footprint. Detail opens beside the catalog
in a sticky in-page pane on wide screens; narrow screens show the selected detail with Back to
catalog. The same mounted detail/feed choice survives resizing. It retains declared signer,
screenshots, description, feed choice, update probe and the existing installer. Installed version,
Open and Manage come from the authorized installed roster, including for out-of-catalog apps.
Missing footprint/permission facts are omitted. Source/settings, detail refresh, diagnostics, empty
states and session recovery remain available. Catalog responses contain catalog facts only; the client
joins the separate authorized installed-state response for display.

The standalone storefront and settings page hide the SDK navigation rail; their initial bootstrap
metadata declares the same chrome policy, avoiding a temporary single-entry sidebar. The storefront
starts with the catalog source rather than a repeated Marketplace heading and description. Settings
sits beside that source and remains available during loading or failure. There is no global Refresh
button or replacement polling. Catalog and installed-list failures retain explicit retry controls,
including when a transient catalog failure leaves cached cards visible. App details keeps its own
Refresh action.

Superseded detail requests are aborted and cannot replace a newer selection or reopen closed
content. A detail refresh failure keeps last-loaded content visible with Retry and disables its
install choices until successful recovery. HTTP 401/403 clears the catalog, detail and installed
roster and cancels pending reads. Detail/update loading and errors have separate accessible states;
unknown update evidence is not rendered as current. Closing returns focus to its opening control.
The shared Hosty loading mark and Marketplace empty mark follow reduced-motion preferences.

## Install Handoff

Marketplace mounts the shared SDK installation dialog with the selected feed URL and feed ID.
Its app-local server adapter calls Core using its service token and the user's app identity grant.
The approved `apps.install` permission and the user's current administrator role are both required.

The dialog prepares settings and opens Core's separate confirmation page. Only that page can approve
the frozen request. Marketplace polls request status and refreshes its installed badges on success.
The same flow works standalone or embedded; no Shell installation listener is involved. See
[App Installation SDK And Core Confirmation](../app-installation-sdk/feature.md) for the permission,
origin-isolation and migration requirements.

## Bootstrap

Core has a narrow first-party bootstrap descriptor for Marketplace, matching the explicit Shell and telemetry bootstrap style. The only switch is:

```text
HOSTY_MARKETPLACE_MANIFEST_PATH
```

When it is non-empty and `hosty.marketplace` is missing, Core installs that manifest using the manifest's normal default runtime and normal autostart default. On later startups, reconciliation preserves the operator-selected installed runtime and autostart value. An empty or absent path performs no Marketplace install, stop, or removal.

Installed CLI launches include the first-party Marketplace manifest URL in their managed launch settings. There is no `HOSTY_MARKETPLACE_RUNTIME`, Marketplace-specific autostart setting, or generic system-app bootstrap registry in this increment.

## Removed Legacy Surface

The direct cutover removes:

- Core catalog services, source persistence, catalog DTOs, `/api/catalog/*`, and `/control/v1/catalog/*`;
- `HOSTY_CATALOG_SOURCES` and Core catalog-source state;
- the hardcoded Shell `/marketplace` page and source-management dialogs;
- the `hosty catalog` CLI command.

There is no compatibility proxy or legacy schema/state migration. Catalog configuration belongs to the Marketplace app; runtime lifecycle belongs to Core.

## Distribution

Marketplace supports a Docker runtime and a Core-managed `dev` local-command runtime. Its manifest declares a source repository, app data, health endpoint, public UI endpoint, system role, and an app-owned settings surface. The repository CI builds/tests the Next.js app and publishes the Marketplace image independently from Core and Shell.

## Links

- [App feeds](../app-feeds/feature.md)
- [Runtime App Manifest](../runtime-app-manifest/feature.md)
- [Auth and gateway model](../auth-gateway/feature.md)
- [Shell Access And System Apps](../shell-access-and-system-apps/feature.md)

Marketplace uses the SDK identity bridge in both Docker and DEV runtimes. Its launch-code exchange
survives React development effect replay, so opening it through Shell establishes the administrator
session before the reloaded storefront reads the catalog.

The storefront renders through the SDK bridge's `renderState` callback. While identity recovers it
shows one session-loading state and sends no catalog requests. A terminal recovery failure shows one
message with a sign-in link or retry action. Once the session is active, catalog loading has its own
single indicator. Source metadata and diagnostics appear only after a real catalog response;
a fetch failure never fabricates an unconfigured source or an empty catalog. HTTP 401/403 responses
hide a previously loaded catalog, while a transient catalog-fetch error can retain the last loaded
cards. Retry after an expired session restarts identity recovery. A ready but empty catalog and a
search with no matches have distinct empty states.

The app exposes the SDK GET/POST adapter at `/api/hosty/ui/[...action]` behind the existing
administrator session gate. It supplies host verification, navigation metadata and tool resolution,
so Shell policy hides app navigation after reloads; the app also hides its redundant standalone
navigation rail.
These SDK routes reject missing identity with HTTP 401 and non-administrator identity with
HTTP 403 (`admin_required`) before requesting UI metadata from Core.

Loading states include visible labels; empty catalog and filtered results offer source or filter
recovery as appropriate. Narrow feed disclosures stay within the viewport and long feed identifiers
wrap. Closing details restores the originating control, or the search field if that control has
left the page.

A transient installed-list failure retains the last successful roster, labels it as last observed
and preserves its Open/Manage actions. An authorization failure clears protected content instead.
Settings distinguishes initial loading from a retryable load failure, validates the returned source,
and keeps an unsaved source after a rejected save. Pending saves disable edits and retain the
observed source used by the server's concurrency check.

## Testing Expectations

- SDK UI routes cover authenticated bootstrap/navigation/panels reads, same-origin navigation
  resolution, and rejection of anonymous, non-administrator and cross-origin requests.

- **Route authorization.** Every catalog and installed-state API route on the Marketplace origin is covered by a test that calls
  the handler without a session and asserts `401 app_identity_required`, and the installed-state
  routes additionally assert that no upstream Core call is attempted — the regression guard for the
  "it only proxies, so it needs no gate" class of mistake that left the installed-app roster and
  update-status routes open. An active non-admin identity must produce `403
  system_app_admin_required`, never data.
- **Identity resolution.** A missing cookie resolves without calling Core; a present cookie is
  revalidated with the app service token; an identity issued for another app fails closed. The
  app-code exchange establishes an HttpOnly app-origin cookie and switches to `SameSite=None;
  Secure` behind an HTTPS gateway.
- **Core response parsing.** Installed-app ids and update status are extracted strictly — non-string
  ids, non-boolean flags, and malformed payloads degrade to an empty roster and "no update" rather
  than propagating.
- **Catalog projection.** Catalog cards normalize and sort without installed-state projections, keep
  the first duplicate app id case-insensitively, and never resolve a feed to a manifest or call
  Core. An unconfigured, invalid, or unavailable source is reported, not thrown.
- **Untrusted input.** The source URL setting rejects local paths, non-HTTP schemes, and embedded
  credentials; description markdown resolves relative references against the description folder and
  rejects `javascript:`, `data:`, `file:`, and credential-bearing URLs; catalog fetches refuse hosts
  that resolve to private addresses.
- **Install handoff.** The intent message is the exact versioned shape, omits `feedId` rather than
  sending null, bounds the feed id, and posts only to the resolved embedding origin — never a
  wildcard, and never when unembedded. The remembered parent origin survives a self-reload that
  rewrites the referrer to Marketplace's own origin.

- Browser API tests preserve 401/403 status, non-JSON server failures, network errors and aborts,
  while distinguishing an actual empty response from a source configuration diagnostic.
- Verify the Core-managed DEV launch through Shell, including a populated catalog after identity
  recovery; SDK tests cover development effect replay and terminal recovery states.
- Rendered session-gate tests assert a single loading or terminal state and no premature catalog
  loading/source placeholders; active identity proceeds to the storefront loading state.
- Storefront and settings chrome tests cover hidden standalone navigation and matching initial
  bootstrap metadata. Verify the catalog-source Settings link during loading and failure, absence
  of the redundant storefront heading and global Refresh, explicit catalog/installed retries with
  and without cached content, and the retained detail Refresh action. Check the same controls in
  Shell and at narrow widths without changing identity or installation authority.

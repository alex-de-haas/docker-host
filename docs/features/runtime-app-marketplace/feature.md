# Marketplace System App

Created: 2026-06-25
Updated: 2026-07-25

## Description

Hosty Marketplace is the optional first-party `hosty.marketplace` system runtime app. It owns catalog discovery, renders the storefront on its own app origin, and hands an untrusted app feed URL to Shell when an administrator chooses Install.

Core has no Marketplace or catalog domain API. It understands runtime-app manifests and generic app-owned feed documents only. Marketplace has no lifecycle authority and cannot install, update, remove, or inspect installed apps.

## Ownership Boundary

| Concern | Owner |
| --- | --- |
| Catalog URL, fetch, schema, diagnostics, cards, and details | Marketplace app |
| Catalog entry metadata and `feedsUrl` | Catalog publisher |
| `feeds.json`, manifests, and runtime artifacts | Runtime app repository |
| Feed validation, install/update plans, apply, backups, and installed state | Core |
| User review and Marketplace-to-Core handoff | Shell |

Marketplace failure affects discovery only. Direct installs and lifecycle operations for installed apps remain available.

## Catalog Source

Marketplace reads one HTTP(S) catalog URL from its normal runtime-app setting:

```text
HOSTY_MARKETPLACE_SOURCE_URL
```

The first-party manifest supplies the official catalog URL as its default. An administrator changes the value through the ordinary system-app settings surface; Core persists and injects it like any other manifest setting. Multiple sources, federation, and local host paths are not supported.

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

Every Marketplace API route is gated on that identity: the shared authorization check requires an `active` session whose `hostRole` is `host.admin`, and it runs before the route resolves any data. A missing token is `401 app_identity_required`, an active non-admin is `403 system_app_admin_required`, and an unreachable or misconfigured Core is `503`. The gate covers the catalog routes and the two installed-state routes alike — the installed-app id roster and per-app update availability are host state, so they never leave the Marketplace origin without an administrator session, and an unauthorized request is refused before Marketplace spends its service token on Core.

Storefront clients treat those refusals as missing data rather than errors: an unauthorized installed-state response leaves the installed set empty and update availability at "no update", so the catalog still renders without install badges. This is the same degradation Marketplace applies when Core is unreachable.

The storefront supports search/filtering, catalog cards, detail metadata, feed choices, description rendering, source diagnostics, and install actions. It renders catalog facts only; it does not join Core registry state into its responses.

## Install Handoff

Marketplace sends this versioned message to its Shell parent after explicit user activation:

```json
{
  "type": "hosty:install-feed",
  "version": 1,
  "feedsUrl": "https://example.invalid/notes/feeds.json",
  "feedId": "main"
}
```

The optional `feedId` is omitted when Core should select the sole or explicit default feed. Marketplace targets the origin derived from its embedding referrer and reports an error when it is not embedded by Shell.

Shell treats the message as untrusted. It accepts it only from the active app iframe and exact resolved app origin, requires the known type and version, bounds string lengths, and permits only HTTP(S) feed URLs. A valid message opens the ordinary Core-owned install review. Shell then uses the administrator's Core session and CSRF token to create and apply a digest-bound generic feed install plan.

Marketplace receives no Core session cookie, control secret, or lifecycle capability through this flow.

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

Marketplace supports a Docker runtime and a Core-managed `dev` local-command runtime. Its manifest declares a source repository, app data, health endpoint, public UI endpoint, system role, and the source URL setting. The repository CI builds/tests the Next.js app and publishes the Marketplace image independently from Core and Shell.

## Links

- [Runtime App Repository Feeds](../catalog-hosted-app-feeds.md)
- [Runtime App Manifest](../runtime-app-manifest.md)
- [Direct-Origin Runtime App UI](../direct-origin-runtime-app-ui.md)
- [Shell Access And System Apps](../shell-access-and-system-apps.md)
- [Marketplace As A System App idea](../../ideas/marketplace-system-app.md)

## Testing Expectations

- **Route authorization.** Every API route on the Marketplace origin is covered by a test that calls
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

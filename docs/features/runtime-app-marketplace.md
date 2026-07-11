# Marketplace System App

Created: 2026-06-25
Updated: 2026-07-11

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

- [Runtime App Repository Feeds](catalog-hosted-app-feeds.md)
- [Runtime App Manifest](runtime-app-manifest.md)
- [Direct-Origin Runtime App UI](direct-origin-runtime-app-ui.md)
- [Shell Access And System Apps](shell-access-and-system-apps.md)
- [Marketplace As A System App idea](../ideas/marketplace-system-app.md)

# Feature: Runtime App Compact View

## Goal

Give administrators a compact, expandable Shell view of installed apps, their selected runtime, service-level runtime status, and assigned service endpoints. This makes it easier to see which local services are running and which local URLs Core assigned without opening logs or probing Core manually.

## Non-goals

- Add a new Core runtime map domain model.
- Replace the Installed Apps management tables.
- Add lifecycle controls inside the compact view.
- Persist port reservations across Core restarts.
- Show external gateway or ingress readiness.

## Current Behavior

Shell shows runtime apps and system apps in the Installed Apps tables with app-level runtime state, selected runtime, version, autostart, UI availability, and actions.

Core stores endpoint URLs after app start and exposes them through `GET /api/apps`. Endpoint summaries include `key`, `protocol`, local `url`, `public`, optional `service` and `port` metadata, and optional `publicOrigin` when an external origin is configured. Shell groups endpoint URLs by runtime service and displays local and public origins as separate adjacent URL blocks. Missing public origins show `not configured` with a configure shortcut instead of hiding the public-origin slot.

Service-level state exists through `GET /api/apps/{appId}/health`. Shell loads that state lazily when an installed app row is expanded.

## Proposed Behavior

The Installed Apps page makes each row in the Runtime Apps and System Apps tables expandable.

When an app row is expanded, the detail row uses the app table row as its header and shows only service details:

- service rows from Core health when available;
- endpoint rows grouped by service when endpoint metadata is available;
- assigned endpoint URL when Core has started the app.
- copy and open-in-new-tab controls for assigned endpoint URLs.
- service-level runtime state.

Endpoint keys such as `backend.http` and extracted port badges are not shown in the compact view. The assigned port is visible as part of the URL.

Stopped apps still show service groups from declared endpoint metadata when available. Missing assigned URLs render as `not assigned`.

## User/API Scenarios

- An administrator opens Installed Apps and expands a runtime app row. Running services show service status and assigned URLs such as `http://localhost:49152`.
- An administrator expands the Hosty Shell system app row. Shell services show their assigned endpoint URLs and service status.
- A stopped app with declared endpoints shows service/port metadata but no assigned URL.
- A multi-service app groups `api.http` and `web.http` under separate service names.
- A legacy installed app whose state was written before `service` and `port` metadata existed remains readable. Shell falls back to parsing endpoint keys such as `frontend.http`.
- If health loading fails for one app, that expanded app row still shows endpoint metadata from `GET /api/apps` and displays the health error locally.

## Technical Design

Core extends `AppEndpointContract` with optional `Service` and `Port` fields. Existing serialized app state remains compatible because the new fields are optional.

Core writes endpoint metadata from:

- manifest endpoints: `endpoint.service` and `endpoint.port`;
- generated endpoints: selected service key and runtime port key;
- runtime adapter start results: selected service key and runtime port key.

Core start/restart URL merging uses the current manifest-derived endpoint contracts as its base, so older installed app state gains service and port metadata after the next start or restart.

Shell extends `CoreEndpoint` with optional `service` and `port`, fetches `GET /api/apps/{appId}/health` when a runtime or system app row is expanded, and groups endpoints by their service key. If no service metadata exists, Shell falls back to splitting endpoint keys by the first dot.

## Data Model / API Changes

`GET /api/apps` endpoint objects gain optional fields:

- `service`: runtime service key associated with the endpoint;
- `port`: runtime port key associated with the endpoint.

The change is additive and backward compatible. Clients that ignore unknown fields continue to work.

## Edge Cases

- Endpoint URL is missing: show `not assigned` and retain service/port metadata.
- Health API is unavailable: show app-level state and the fetch error for that app.
- Endpoint has no service metadata and no dotted key: group under the only reported service when there is one, otherwise group under `endpoints`.
- Endpoint uses a non-HTTP protocol: preserve the assigned URL returned by Core.
- System apps use the same expandable service detail row when they are visible in the System Apps table.

## Testing Plan

- Unit test Core app installation preserves manifest endpoint `service` and `port`.
- Unit test Core local command start preserves generated endpoint service/port metadata and assigned URLs.
- Build Shell to verify TypeScript and component integration.
- Build and test Core.
- Manually validate through Core-managed Shell when a local Core/Shell runtime is running:
  - Runtime Apps rows expand and show service URLs, copy controls, open controls, and service status.
  - System Apps rows expand and show Shell service URLs, copy controls, open controls, and service status.

## Rollout / Migration Notes

No migration is required. Existing installed app state without endpoint service metadata remains valid. Metadata appears after reinstall/update/start, and Shell falls back to endpoint key parsing for older state.

## Open Questions

- Question: Should the compact view live on Dashboard, above Installed Apps, or inside each app row?
  Recommended answer: inside each app row on Installed Apps, because the app row already carries the app identity and lifecycle state.

- Question: Should Hosty add a separate runtime map domain object?
  Recommended answer: no. Runtime apps are the current Core domain model, and the requested view can be represented as a Shell projection.

- Question: Should Shell display URL or only port?
  Recommended answer: display the URL only. The URL is the authoritative Core-assigned endpoint, and the port is already visible inside it.

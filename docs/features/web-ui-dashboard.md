# Web UI Dashboard

The Hosty Web UI is the Core-managed Shell runtime app. The dashboard is a lightweight overview surface; app lifecycle, updates, backups, configuration, and removal live in the Shell Installed Apps view.

## Scope

The dashboard reads:

- Core status from `GET /api/core/status`;
- the current Core session from `GET /api/auth/session`;
- installed app summaries from `GET /api/apps`.

The dashboard shows aggregate runtime app counts, running state, attention indicators, Core health warnings, and a link into Installed Apps for detailed management.

## Installed Apps Management

The Installed Apps view is the implemented management surface for runtime apps. It uses Core app APIs:

- `POST /api/apps/install/plan`
- `POST /api/apps/install`
- `POST /api/apps/{appId}/start`
- `POST /api/apps/{appId}/stop`
- `POST /api/apps/{appId}/restart`
- `POST /api/apps/{appId}/configure`
- `POST /api/apps/{appId}/update/plan`
- `POST /api/apps/{appId}/update`
- `GET /api/apps/{appId}/logs`
- `GET /api/apps/{appId}/health`
- `GET /api/apps/{appId}/backups`
- `POST /api/apps/{appId}/backups`
- `POST /api/apps/{appId}/backups/{backupId}/restore`
- `DELETE /api/apps/{appId}/backups/{backupId}`
- `GET /api/apps/{appId}/backups/cleanup/plan`
- `POST /api/apps/{appId}/backups/cleanup`
- `POST /api/apps/{appId}/remove`

Shell renders install review, configuration, update, logs, backups, backup cleanup, restore, and removal flows with Core-generated plans and capability checks. Core remains the authority for app state and mutation validity.

```mermaid
flowchart TD
  A["Shell Dashboard"] --> B["GET /api/core/status"]
  A --> C["GET /api/apps"]
  A --> D["Installed Apps view"]
  D --> E["Core app lifecycle APIs"]
  D --> F["Core backup APIs"]
  D --> G["Core update/configuration APIs"]
  E --> H["apps.json"]
  F --> I["app data backups"]
  G --> H
```

## Empty and Recovery States

The empty state is shown when Core has no non-system runtime apps. The primary way to leave the empty state is the Installed Apps install dialog.

Failed apps remain visible with their last operation and error so administrators can choose the correct recovery path. Shell delegates retry, update, backup, and remove behavior to Core app endpoints.

## Gateway Boundary

Gateway exposure management and external ingress readiness were part of the retired Legacy Host UI. They are not current Shell dashboard features. Future gateway UX should be added as a Core-backed Shell view after Core or a Core-managed gateway runtime owns the underlying APIs.

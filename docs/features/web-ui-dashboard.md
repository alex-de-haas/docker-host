# Web UI dashboard

The Web UI is the primary daily interface for Docker Host module operations. The dashboard is centered on installed modules from the Host backend API instead of direct raw Docker container management.

## Scope

The dashboard reads installed modules from `GET /api/modules`, shows Host/Docker status cards, and uses module lifecycle routes for row actions:

- `POST /api/modules/{moduleId}/start`
- `POST /api/modules/{moduleId}/stop`
- `POST /api/modules/{moduleId}/restart`

The dashboard displays module metadata, image reference, operation status, Docker runtime state, container identity, timestamps, and any recorded module/runtime error. Rows can expand for details. Lifecycle actions are enabled only for modules in `operationStatus=installed`; failed or removing modules expose recovery actions instead.

Implemented module-management flows:

- Install uses the dedicated `/modules/install` route. It accepts a metadata URL, calls `POST /api/modules/install/plan`, renders the reviewed plan, collects setting values and external mount selections, shows a redacted payload preview, then submits `POST /api/modules/install`.
- Update uses the dedicated `/modules/{moduleId}/update` route. Dashboard rows link to it for installed modules. The route calls `POST /api/modules/{moduleId}/update/plan`, shows refreshed metadata changes and prompts, builds a redacted update request, then submits `POST /api/modules/{moduleId}/update`.
- Failed update rows expose `POST /api/modules/{moduleId}/update/retry` plus a link to review the update again.
- Failed install rows expose `POST /api/modules/{moduleId}/retry` and cleanup through a backend-generated confirmation dialog.
- Installed rows expose remove through a backend-generated confirmation dialog.
- Cleanup and remove dialogs call `POST /api/modules/{moduleId}/cleanup/plan` or `POST /api/modules/{moduleId}/remove/plan` before apply, default to preserving module-owned data, and only submit apply after explicit confirmation.
- The dashboard includes an external ingress readiness panel for gateway exposures. It calls `/api/ingress/exposures`, shows provider-neutral publish status, renders generated manual setup instructions, supports mark-ready/refresh/unlink actions, and keeps provider-specific DNS, tunnel, or identity-provider automation out of the Web UI.

```mermaid
flowchart TD
  A["Web UI dashboard"] --> B["GET /api/modules"]
  A --> C["Lifecycle row actions"]
  A --> D["/modules/install"]
  A --> E["/modules/{moduleId}/update"]
  A --> F["Recovery dialogs"]
  A --> Q["External ingress readiness panel"]
  C --> G["start/stop/restart API"]
  D --> H["install plan/apply API"]
  E --> I["update plan/apply API"]
  F --> J["retry/cleanup/remove API"]
  Q --> R["/api/ingress/exposures"]
  G --> K["Host backend"]
  H --> K
  I --> K
  J --> K
  R --> K
  K --> L["modules.json"]
  K --> M["local metadata.json"]
  K --> N["Docker daemon"]
```

## Empty and recovery states

The empty state is shown when the Host modules store has no installed module records. The primary way to leave the empty state is the install route.

Failed modules remain visible with their last operation error so administrators can choose the correct recovery path. Failed installs use install retry or cleanup. Failed updates use update retry or update review. Cleanup and remove previews list affected containers, metadata files, module directories, module-owned storage, external mount mappings, dependents, warnings, and conflicts before any destructive action runs.

## Open Questions

- What detail view should own module logs once diagnostics endpoints are added?

Resolved decision: module update uses a dedicated review route at `/modules/{moduleId}/update`, while reusing install review interaction patterns where practical.

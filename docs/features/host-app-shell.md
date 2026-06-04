# Host App Shell

The Host Web UI uses an authenticated admin shell for protected Host pages. The shell is the foundation for the module app portal while preserving the existing Host backend APIs and module lifecycle workflows.

## Scope

The Host app shell provides authenticated navigation, role-aware app discovery, embedded module UI hosting, gateway exposure management entry points, and local runtime app integration.

Protected admin pages:

- protected admin pages live under a Next.js route group and keep their public URLs stable;
- `/`, `/modules`, `/modules/install`, `/modules/{moduleId}/update`, `/ingress`, and `/settings/security` render inside the shared shell;
- `/login`, `/setup`, and `/recovery` remain standalone pages outside the shell;
- the route group layout enforces the existing `host.admin` page guard;
- the shell owns the persistent sidebar, compact sidebar toggle, account menu, logout action, and app navigation chrome.

App registry behavior:

- `GET /api/apps` returns app navigation data for the authenticated Host principal;
- `/api/apps` accepts any authenticated Host principal, not only `host.admin`;
- unauthenticated callers receive `401` and no app discovery data;
- app entries are built from explicit module `ui` metadata, installed module records, Host-owned module assignments, and runtime status;
- shell Apps do not support anonymous or `public` discovery;
- service/API gateway exposures are not inferred as shell Apps.

Module UI metadata behavior:

- module metadata supports an optional shell-only `ui` contract;
- `ui.entrypoint` selects the public runtime port and default module UI path for shell embedding;
- `ui.navigation` provides optional nested app navigation without runtime route probing;
- invalid `ui` metadata is rejected by metadata validation;
- the demo module declares `ui` metadata and exposes stable `/`, `/people`, and `/settings` routes.

Embedded app behavior:

- the Apps sidebar is populated from `/api/apps`, excluding system apps so Host-owned management surfaces do not appear as user app entries;
- app entries can show nested navigation from `ui.navigation`;
- `/apps/{moduleId}` opens a Host-owned app page without proxying that path to module containers;
- the Host app page embeds module UIs in an iframe using the direct module origin returned by `/api/apps`;
- the shell keeps Host-owned app navigation in the sidebar and shows app status markers next to app entries, including visible unavailable reason labels for administrator-visible app diagnostics;
- module UIs own their in-page headers, page actions, and internal navigation;
- Host authentication and app access checks happen before app registry data and identity tokens are issued;
- module identity for shell iframe traffic is delivered through a short-lived identity token endpoint and a `postMessage` bridge.

Gateway exposure behavior:

- `/ingress` combines service/API gateway exposure management with external ingress readiness;
- administrators can create, edit, enable/disable, and delete gateway exposure records from the Web UI;
- the exposure form uses a narrow admin-only `/api/gateway/options` endpoint for installed module, public runtime port, active Host user, UI-entrypoint hint, and gateway domain choices;
- service/API exposures are visibly labeled as separate from shell Apps and excluded from Apps navigation;
- selecting a runtime port that is also `ui.entrypoint.portKey` shows a warning instead of publishing the module browser UI as a standalone public subdomain;
- `assignedUsersOnly` exposure editing updates module-wide Host access assignments;
- deleting an exposure removes linked external ingress readiness state;
- creating an exposure leaves readiness unmanaged until an administrator explicitly plans ingress.

User portal behavior:

- authenticated `host.user` principals can load the Host shell;
- `/apps` is the default non-admin portal view;
- non-admin users who open `/` are routed to `/apps`;
- the sidebar is filtered by role, so non-admin users see Apps and account actions only;
- Host management pages render an access-denied shell state for non-admin users;
- module lifecycle, install/update/remove, gateway exposure management, external ingress management, security settings, and other Host management APIs remain `host.admin` only;
- the Apps portal includes empty states for no assigned apps, apps unavailable, login required, and access denied.

Local command runtime apps use the same Apps portal and Shell routes as Docker runtime apps. Their local origins are derived from the active runtime endpoints in the installed app record.

## Navigation

The sidebar combines static Host management navigation with dynamic Apps navigation from `/api/apps`.

- Host:
  - Dashboard (`/`)
  - Gateway exposures (`/ingress`)
  - Installed modules (`/modules`)
  - Install module (`/modules/install`)
- Apps:
  - loading, error, and empty states when app registry data is unavailable or empty
  - one entry for each visible shell App
  - nested app navigation when `ui.navigation` is present
- Settings:
  - Security (`/settings/security`)

For `host.user`, the sidebar is reduced to Apps navigation plus the account menu. Host and Settings navigation are hidden because those workflows remain administrative.

The sidebar is always visible. Users can switch it between an expanded mode with labels and nested app navigation, and a compact mode that keeps only the primary icons visible. The selected mode is stored locally in the browser. The mobile drawer was removed with the topbar because navigation no longer disappears below the desktop breakpoint.

When the Host runs in development runtime, the sidebar header shows a `DEV` marker next to `DOCKER HOST`. Compact mode keeps the same signal as a small marker on the Host icon.

```mermaid
flowchart TD
  A["Shell route group"] --> B["Authenticated shell guard"]
  B --> C["Shared Host shell"]
  C --> D["Dashboard"]
  C --> E["Installed modules"]
  C --> X["Install module"]
  C --> F["Update module"]
  C --> G["Gateway exposures and external ingress"]
  C --> H["Security settings"]
  C --> M["Apps sidebar"]
  C --> P["Apps portal"]
  P --> M
  M --> N["App shell route"]
  N --> O["Embedded module iframe"]
  I["Standalone auth pages"] --> J["Login"]
  I --> K["Setup"]
  I --> L["Recovery"]
```

## Responsive Behavior

The shell uses a persistent sidebar at every viewport size. Expanded mode gives the Host and Apps navigation enough space for labels, nested entries, and account details. Compact mode narrows the sidebar to an icon rail for workflows that need more horizontal room.

The shared topbar has been removed. Host management pages render any needed title, description, and page actions inside their own page content. Embedded module apps receive the main content area without Host page chrome above the iframe, so each module remains responsible for its own headers and page-level actions.

For embedded module apps, the sidebar remains Host-owned. The Host app route uses the selected app and nested navigation state to highlight sidebar entries, while the module UI renders its own internal header, navigation, and actions inside the iframe. Module-provided global shell actions are not part of the current `ui` contract; modules cannot directly control Host chrome at runtime.

## Page Integration

The dashboard remains focused on Host overview widgets and links into the dedicated `/modules` management page. The current Installed modules widget owns its own refresh status and quick health summary. Installed module lifecycle actions, recovery dialogs, and links into install/update flows live on `/modules`. Gateway exposure management and external ingress readiness live on the dedicated `/ingress` page and reuse the existing gateway and readiness APIs.

Install, update, and security pages keep their existing backend calls and form behavior. Their page headers and actions now live inside the page content instead of the shared shell.

Non-admin users do not receive Host management pages. Opening `/`, `/ingress`, `/modules`, `/modules/install`, `/modules/{moduleId}/update`, or `/settings/security` as `host.user` keeps the authenticated shell but routes the user to `/apps` or renders an access-denied state. The underlying management APIs continue to require `host.admin`.

`/apps` is the default portal page for `host.user`. It renders the current principal's app registry entries, lets users open available apps, shows unavailable reasons for administrator-visible diagnostics, and shows clear empty states when no apps are assigned, app registry data is unavailable, or the session needs login again.

## App Registry API

`GET /api/apps` returns a minimal, principal-filtered app registry for management views, sidebar rendering, and embedded app opening. The sidebar applies a client-side presentation filter for system apps; the `/apps` portal can still show those entries in its separate System apps section.

`host.admin` receives all shell-routable app entries, including unavailable entries with safe diagnostic status. `host.user` receives only available apps that are visible to all authenticated users or explicitly assigned to that user.

Shell App access modes are Host-owned:

- `allAuthenticated` - any signed-in Host user can discover the app;
- `assignedUsersOnly` - assigned Host users and `host.admin` can discover the app;
- no `public` or anonymous shell App mode exists.

The response intentionally returns direct app UI URLs resolved from manifest `ui` metadata and runtime endpoint URLs. It does not return Docker network aliases, container names, container ids, Docker network URLs, or service/API gateway exposure hostnames.

Runtime apps appear in the shell Apps sidebar only when their installed manifest includes an explicit `ui` contract. Public runtime ports are endpoint capability hints and do not create shell navigation by themselves.

The app registry keeps shell discovery responsive by avoiding Docker runtime reads for modules whose install/update operation state already makes them unavailable, and by reusing runtime status results for a short in-process TTL. The cache only affects `/api/apps` discovery; dedicated module management APIs still read fresh runtime details for lifecycle workflows.

Local command runtime profile visibility reuses the installed app access policy after Host authentication. Anonymous shell App discovery is still not supported.

## Embedded App Route

The selected embedded app page is shell client state. Shell renders Host-owned navigation around the selected app UI and uses the selected `ui.navigation[].path` to request the correct app launch URL.

The iframe uses a Core-issued launch redirect URL derived from the `embeddedUrl` returned by `/api/apps`, for example `http://app.localhost:3210/people`. Core validates the current principal before returning app registry entries and before issuing each launch code, but it does not proxy app HTML or rewrite app assets. The iframe is sandboxed and uses Host theme-aware background styling.

Apps backed by local runtime endpoints use the configured runtime public host, for example `app.localhost`, plus the assigned runtime port. Core resolves nested app navigation by applying each manifest path to that endpoint URL.

The Host shell opens apps through `/api/apps/{appId}/launch-code`. The app receives the short-lived code in its redirect URL and exchanges it with Core for app identity. Browser Shell launch always uses the active Core session user.

App UIs must serve their own routes, assets, cookies, and API calls from their own origin. The Host does not rewrite root-relative URLs, Next.js assets, App Router `_rsc` requests, or response headers. If an app blocks framing with `X-Frame-Options` or `Content-Security-Policy: frame-ancestors`, the browser blocks the iframe according to the app's own response policy.

Local command runtime app transport follows the same direct-origin pattern as Docker runtime app transport. It resolves the active runtime origin from the installed app state, applies Host app access rules before app discovery, and issues identity through the app identity endpoint.

## Module UI Metadata

The `ui` contract is shell-only. It describes how the Host lists and embeds a module UI; it does not create DNS, TLS, tunnel, reverse proxy, or service/API gateway exposure records. The actual iframe origin comes from the install-time public origin or the `http://localhost:{hostPort}` local fallback.

Supported fields:

- `ui.category` is optional and must be `Apps` when provided;
- `ui.icon` is optional and must be a non-empty lowercase icon key;
- `ui.entrypoint.endpoint` should reference a declared manifest endpoint key;
- `ui.entrypoint.path` should be a same-origin path beginning with `/`;
- `ui.navigation[]` is optional, preserves author-defined order, and declares page labels plus same-origin paths.

Missing `ui` metadata is valid. The app can still install and run, but it is not returned as a shell App. For older installed records, Core hydrates shell UI metadata from the stored manifest copy when listing `/api/apps`.

## Gateway Exposure UX

The `/ingress` admin page manages service/API gateway exposures and their external ingress readiness in one workflow.

Gateway exposures are Host-owned service/API publishing records. They contain:

- installed module id;
- public runtime port key;
- gateway hostname;
- exposure policy;
- module identity mode;
- enabled state.

When `HOST_GATEWAY_BASE_DOMAIN` is configured, the UI asks for a subdomain and previews the resulting full hostname. Without a base domain, administrators enter the full hostname directly.

The exposure form uses `/api/gateway/options` to load only the data needed by the form: installed modules with public runtime ports, UI-entrypoint hints, active Host users for assignment editing, and Host gateway domain settings. This avoids exposing raw Docker/container details through the client.

Exposure policy is the primary authorization control. Identity mode remains visible as an advanced control with defaults selected from the policy. Public exposures cannot use required identity mode.

For `assignedUsersOnly`, the editor updates module-wide Host assignments. Those assignments are shared by assigned-only service/API exposures and shell Apps for the same module.

Service/API exposure changes do not create shell Apps. If an administrator selects the same public runtime port used by `ui.entrypoint.portKey`, the form warns that browser UIs should remain inside the Host Apps shell.

External ingress readiness remains explicit. Creating an exposure does not create a readiness record automatically; administrators use the readiness section's Plan action. Disabling an exposure preserves readiness state, while deleting an exposure removes linked readiness records.

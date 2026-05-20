# Host App Shell

The Host Web UI uses an authenticated admin shell for protected Host pages. The shell is the foundation for the module app portal while preserving the existing Host backend APIs and module lifecycle workflows.

## Scope

The Host app shell provides authenticated navigation, role-aware app discovery, embedded module UI hosting, gateway exposure management entry points, and local developer app integration.

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

- the Apps sidebar is populated from `/api/apps`;
- app entries can show nested navigation from `ui.navigation`;
- `/apps/{moduleId}` opens a Host-owned app page without proxying that path to module containers;
- the Host app page embeds module UIs in an iframe using `/api/apps/{moduleId}/embed?path=...`;
- the shell keeps Host-owned app navigation in the sidebar and shows app status/developer markers next to app entries;
- module UIs own their in-page headers, page actions, and internal navigation;
- the embed route requires Host authentication, validates the selected shell App, proxies only the reserved embed path, injects module identity, strips Host-owned headers, and rewrites root-relative module links and assets through the reserved embed URL.

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

Developer app behavior:

- enabled module developer targets can appear in `/api/apps` when `HOST_MODULE_DEV_MODE=enabled`;
- developer app entries are hidden when developer mode is disabled or the individual target is disabled;
- developer targets remain local-only state and do not create production gateway exposure records;
- developer app ids are qualified as `dev:{targetId}` while module identity still uses the target's `moduleId`;
- developer apps open through `/apps/dev/{targetId}` and the same-origin embed transport `/api/apps/dev/{targetId}/embed`;
- developer embed transport uses the target's local URL and path prefix while preserving Host authentication, module identity token behavior, Host-owned header stripping, and scoped module cookies;
- the Apps sidebar and Apps portal mark developer entries with a compact `Dev` badge or marker.

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

Developer app entries use the same shell chrome and add a compact `Dev` marker next to the app entry. The marker identifies local developer targets without changing module access rules or production exposure state.

## Page Integration

The dashboard remains focused on Host overview widgets and links into the dedicated `/modules` management page. The current Installed modules widget owns its own refresh status and quick health summary. Installed module lifecycle actions, recovery dialogs, and links into install/update flows live on `/modules`. Gateway exposure management and external ingress readiness live on the dedicated `/ingress` page and reuse the existing gateway and readiness APIs.

Install, update, and security pages keep their existing backend calls and form behavior. Their page headers and actions now live inside the page content instead of the shared shell.

Non-admin users do not receive Host management pages. Opening `/`, `/ingress`, `/modules`, `/modules/install`, `/modules/{moduleId}/update`, or `/settings/security` as `host.user` keeps the authenticated shell but routes the user to `/apps` or renders an access-denied state. The underlying management APIs continue to require `host.admin`.

`/apps` is the default portal page for `host.user`. It renders the current principal's app registry entries, lets users open available apps, and shows clear empty states when no apps are assigned, app registry data is unavailable, or the session needs login again.

## App Registry API

`GET /api/apps` returns a minimal, principal-filtered app registry for sidebar rendering and embedded app opening.

`host.admin` receives all shell-routable app entries, including unavailable entries with safe diagnostic status. `host.user` receives only available apps that are visible to all authenticated users or explicitly assigned to that user.

Shell App access modes are Host-owned:

- `allAuthenticated` - any signed-in Host user can discover the app;
- `assignedUsersOnly` - assigned Host users and `host.admin` can discover the app;
- no `public` or anonymous shell App mode exists.

The response intentionally returns same-origin Host paths, such as `/apps/{moduleId}` and reserved embedded URLs under `/api/apps/{moduleId}/embed`. It does not return Docker network aliases, container names, container ids, raw container URLs, public module UI domains, or service/API gateway exposure hostnames.

Modules appear in the app registry only when local metadata includes an explicit `ui` contract. `runtime.ports[].public` is still only a capability hint and does not create an app entry by itself.

The app registry keeps shell discovery responsive by avoiding Docker runtime reads for modules whose install/update operation state already makes them unavailable, and by reusing runtime status results for a short in-process TTL. The cache only affects `/api/apps` discovery; dedicated module management APIs still read fresh runtime details for lifecycle workflows.

When module developer mode is enabled, `/api/apps` also reads enabled developer targets from local developer target state. A developer target appears as a shell App only when the target stores a valid shell app metadata snapshot. The response marks these entries with `source: "developer"` and `developerTargetId`, uses `/apps/dev/{targetId}` for shell navigation, and uses `/api/apps/dev/{targetId}/embed` for iframe transport.

Developer target visibility reuses the target exposure policy after Host authentication. `public` and `loginRequired` targets are visible to authenticated Host users. `assignedUsersOnly` targets use existing module access assignments. Anonymous shell App discovery is still not supported.

## Embedded App Route

`/apps/{moduleId}` is shell state. It renders the Host shell around the selected module UI and uses the optional `path` query parameter to select nested module navigation, for example `/apps/com.acme.reports?path=%2Fpeople`.

The iframe uses the reserved embedded transport URL returned by `/api/apps`: `/api/apps/{moduleId}/embed?path=...`. This endpoint requires Host authentication and validates the current principal against the app registry before proxying to a module. The iframe is sandboxed and uses Host theme-aware background styling. It does not publish module UIs as standalone public hostnames and does not turn `/apps/{moduleId}` into a direct module proxy.

The embed transport rewrites root-relative links and assets in HTML/CSS responses back through the reserved embed URL so module pages can load common assets while remaining inside the Host shell. Rewriting is limited to HTML tag attributes, style attributes, and style element CSS; inline script contents are preserved as-is. If a module response explicitly blocks framing with headers such as `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'`, the embed route returns a concise fallback page explaining that the module UI must support Host shell embedding.

Developer embed transport follows the same same-origin pattern under `/api/apps/dev/{targetId}/embed`. It resolves the local target URL and path prefix from developer target state, forwards through the Host shell, applies module access rules, injects module identity according to the target identity mode, strips Host-owned headers, and scopes module cookies to the developer embed route.

## Module UI Metadata

The `ui` contract is shell-only. It describes how the Host lists and embeds a module UI; it does not publish a module UI hostname and does not create a service/API gateway exposure.

Supported fields:

- `ui.category` is optional and must be `Apps` when provided;
- `ui.icon` is optional and must be a non-empty lowercase icon key;
- `ui.entrypoint.portKey` must reference a `runtime.ports[]` item marked `public: true`;
- `ui.entrypoint.path` must be a same-origin absolute path beginning with `/`;
- `ui.navigation[]` is optional, preserves author-defined order, and requires unique same-origin absolute paths.

Missing `ui` metadata is valid. The module can still install and run, but it is not returned as a shell App. Malformed `ui` metadata is rejected during install/update planning, and app registry compatibility checks keep invalid installed metadata hidden from `host.user` while returning safe diagnostics to `host.admin`.

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

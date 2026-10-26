---
created: 2026-10-26
updated: 2026-10-26
summary: Hosty Desktop provides movable application windows, a glass dock, personal appearance and role-aware app access beside the management Shell.
components: [apps/desktop]
---

# Desktop Shell

## Runtime And Access

`hosty.desktop` is a separate first-party runtime app in `apps/desktop`, with its own
`0.1.x` release line. The existing management Shell remains independent. Desktop runs
as a standalone browser surface and rejects embedding inside another shell to avoid
recursive desktops. Its manifest supplies a Docker production profile and a Core-managed
local development profile. Core assigns the port and supplies identity and transport configuration.

The SDK handles normal Core authentication, app-code exchange, session renewal and
embedded app identity. Desktop's server proxy accepts a small allowlist of session,
application, icon, event and lifecycle routes. Service credentials stay on the server;
Core evaluates the forwarded application identity and current user's permissions.
Mutations require the Desktop origin and a session-scoped double-submit CSRF token.

Administrators see all UI applications returned by Core, including stopped apps.
Ordinary users see only assigned, running UI applications. Headless services and Desktop
itself are excluded. Clicking an idle application as administrator opens a window and
starts its runtime, with pending/error feedback. Repeat clicks share the same operation.
Selected-page service readiness determines when to mount the application frame.

Closing a window only removes its browser view. Administrators can explicitly stop or
restart the shared runtime from the dock context menu or the menu bar's Window menu; the confirmation states that the operation affects
everyone. Ordinary users have no lifecycle controls, and Core remains the authorization boundary.

## Desktop Interaction

Windows support title-bar dragging, eight resize handles, minimize/restore, maximize,
left/right tiles and edge snapping. Focus changes their stacking order without moving
or replacing frame DOM nodes. A minimized frame remains mounted. Each app owns one window;
multiple manifest pages appear in its sidebar. The shared SDK registers a separate tool
workspace for each application window before mounting its frame.

The dock contains accessible apps, marks open windows, dims stopped apps for administrators,
and supports ordering and favorites. Its horizontal scroll area reserves space around enlarged
hover/focus icons and focus rings without changing the dock's visible size.
App-name tooltips render in the desktop overlay outside that scroll area, stay inside the
viewport and wrap long names. They follow their icon during scrolling and resizing, support
keyboard focus, and dismiss on Escape or interaction. Applications and Appearance are built-in windows.
Search is available from the menu bar and Command-K/Control-K. Window menus also expose
keyboard-accessible maximize and tile actions.

Window geometry, open/minimized state, dock preferences and appearance are saved in localStorage
under the Core user ID. Invalid stored data and inaccessible application IDs are discarded.
Layouts are clamped to the current viewport; narrow browser surfaces maximize windows.
Container queries keep a narrow tiled window's own controls usable.

Administrators share one Core event stream for app changes and refresh on reconnect.
Ordinary users refresh every 20 seconds while visible because the current Core domain stream
is administrator-only. Both refresh on visibility, focus and restored sessions. Refresh failures
retain the visible desktop and expose retry feedback; identity gating belongs to the SDK.

## Window Tools And Assistant Context

Window title bars show icons from Core's authorized panel catalog. The former overflow
menu and external-tab actions are absent; window actions remain in the dock and menu bar.
The application frame receives hidden navigation/tool-launcher hints, avoiding a duplicate
Tools button inside the document. Administrators can see unavailable tools with a hint to
start their app from the dock; ordinary users see available tools only.

Each application window registers an independent SDK workspace. Desktop renders panel
frames inside that window's DOM, so dragging, clipping, stacking and minimizing apply to
the document and its tools together. Tool switches and collapse retain mounted frames;
closing the owning window releases its presentations. Narrow windows overlay the panel
inside the same window. There are no external-tab links in Desktop's panel chrome.

Assistant interfaces and panel destinations come from Core declarations. Clicking an
assistant creates an empty draft with the owning application as its context, then opens
the provider-returned, installation-pinned panel route. Reopening the icon restores that
window's conversation. Different windows create distinct discussions. Desktop never sends
a prompt or starts agent execution from this entry point. Context is descriptive and does
not grant source, lifecycle or MCP access.

The assistant adapter requires the optional `providers.assistant` grant, the current
app identity, same-origin CSRF protection and current access to the context application.
Provider credentials remain server-side. Pending handoff request IDs survive uncertain
network results and are scoped to the actor, context installation and assistant installation.
The same ID is retained until presentation succeeds, so retries recover the discussion.

## Appearance

The Desktop mark follows the Hosty Style Guide: a square-cell frame with a mint green lit window (#34D399). The manifest declares the image in `catalogMetadata.icon` so Core serves it through the app asset endpoint; `ui.icon` retains a Lucide fallback. The catalog and browser tab use the dark ink tile; the menu bar and loading screen use the unboxed mark.

Light, dark and system preferences share one design. Glass title bars, sidebars and the dock
use backdrop blur with opaque content areas. Reduced-motion and reduced-transparency
preferences have explicit CSS fallbacks. Theme changes use SDK frame messages and preserve
the embedded document.

Built-in coastal wallpapers include daylight and blue-hour images. The coastal selection
follows the resolved theme; blue hour can also remain selected independently. JPEG, PNG and
WebP uploads up to 12 MB are stored per user in this browser's IndexedDB. Wallpapers and
layout preferences do not sync between browsers.

## Development And Verification

Run `npm run desktop:dev` through Core's local runtime profile. Development output uses
`.next-dev`; production builds use `.next`. Both development and production use webpack.
The manifest, npm package and first-party Docker image tag are checked together by
`scripts/check-versions.mjs`. CI selects the Desktop lint/test/build job for its source and
SDK changes. The image publication workflow uses the existing successful-main-CI gate.

The authorized local preview is configured to use the registered development worktree and the current Core.
The app is installed with autostart disabled. Its active workspace lease is retained while
that runtime uses the worktree. Build artifacts and visual QA evidence stay outside the PR.

`npm run test:integration -- desktop` builds Core, CLI and the manifest-matching Desktop Docker image, then creates a parent-managed child Core with separate test users. It verifies password login, administrator/member identity, assignment filtering and revocation, denied member lifecycle calls, and administrator start/stop through Desktop's proxy. `HOSTY_DESKTOP_BROWSER=1` retains that same environment for UI checks; the parent Finishes it after the completion marker.

The 2026-10-26 macOS acceptance also verifies dock launch/loading, closing without stopping, explicit shared stop, a resource-budget start refusal displayed in the window, hidden stopped/unassigned apps for members, removal of the embedded frame after access revocation, and user-specific uploaded wallpaper/theme restoration after switching accounts. Parent Finish removes the child resources, test credentials and data; the fixture confirms process and port cleanup. Provider credentials are not copied into the sandbox.

## Testing Expectations

- Run `npm run desktop:test`, `npm run desktop:lint` and `npm run desktop:build`.
- Verify role-based visibility, per-service readiness using Core's nullable string health readings (including unrelated starting/unhealthy services), URL validation, corrupted storage,
  per-user persistence and bounds. Component tests distinguish close from stop, preserve
  minimized documents, coalesce starts and require explicit shared-runtime actions.
- Proxy tests cover the route boundary, missing identity, cross-origin/malformed CSRF and
  propagation of Core's authorization refusal without forwarding caller-supplied authority.
- Verify per-window tool placement, retained frames, separate assistant context, actor-scoped
  retry identity, empty drafts, denied context and installation changes.
- Build `apps/desktop/Dockerfile`; run version, documentation and affected CI policy checks.
- Browser checks use normal Core login and Core-managed apps. Exercise both themes, overlapping
  and tiled windows, frame identity/theme continuity, search, upload and restored state.
- Complete live ordinary-user and lifecycle acceptance in an isolated Core-managed sandbox;
  a component mock or the current administrator's preview is not evidence for those cases.

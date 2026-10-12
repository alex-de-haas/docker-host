---
created: 2026-10-11
updated: 2026-10-12
summary: Explicit navigation and tool policy, manifest navigation, and retained tool instances shared by Shell, desktop hosts and standalone apps.
components: [packages/app-sdk, apps/core, apps/shell, apps/plans, apps/demo-app, apps/harness, apps/workspaces, apps/marketplace, apps/telemetry-ui, apps/shell-swift]
---

# SDK UI Composition

One top-level SDK coordinator composes app views, page navigation and retained tools. The current
Shell owns app navigation and its tool workspace. A desktop host can keep navigation inside each
app window while sharing a dock or tool window. Standalone apps use the same SDK navigation and
panel renderer. Framing decides transport, independently of presentation policy.

This extends the [SDK panel system](../sdk-panel-system/feature.md). Apps retain ownership of
conversations and domain actions. Plans finalizes its discussion before requesting placement;
opening or retrying a presentation neither submits a message nor creates another discussion.

Implementation approval: on 2026-10-11, after the contract refinement, the owner explicitly
instructed the implementation agent in chat to proceed. [Vision decision 33](../../vision.md)
records that approval. The earlier committed Draft describes the documentation-first stage;
it is not the latest owner instruction. Deliverables D1–D5 were implemented and verified before
the completed plan was retired with the implementation, as required by the documentation workflow.

## Policy And Defaults

| Context | App navigation | Tool launcher | Tool owner |
| --- | --- | --- | --- |
| Plain standalone | Show | Local rail and chooser | Local coordinator |
| Current Shell child | Hide | Hidden in child; Shell rail available | Shell |
| Desktop fixture app window | Show | Hidden in child; shared desktop controls | Desktop host |
| Tool frame | Hide | Hide | Existing top-level host |
| Shell dashboard/settings | Shell navigation | Shell rail | Shell |
| Native web view | Hide | Hide; tools disabled | Separate-opening recovery |

These are configurations, not consequences of a role or iframe. Root `chrome` defaults configure
`navigation: show | hide`, `tools.enabled: boolean` and `tools.launcher: show | hide` independently.
The SDK derives `tools.owner: local | host | unavailable`; callers cannot assert ownership.

Each leaf resolves from verified sparse host overrides, document URL hints, explicit app defaults,
then standalone defaults. A current document's explicit legacy `hosty_launch=embedded|native`
supplies navigation-hide below app defaults; `standalone` supplies show. Stored launch mode and
framing do not contribute visibility policy.

Hints are `hosty_navigation=show|hide`, `hosty_tools=enabled|disabled` and
`hosty_tool_launcher=show|hide`. Invalid or duplicated fields fall through independently.
`chromeBootstrapScript(defaults)` captures them before hydration and applies initial navigation
visibility. Mount with the same defaults. The root removes composition hints while preserving
router history state. They live only in the current document, without cookies or session storage.
SDK document navigation reattaches policy; separate opening starts a fresh standalone document.

`setViewChrome(viewId, overrides)` replaces sparse overrides, including removing them with `{}`.
It changes neither the iframe key nor its document. Policy revisions belong to the verified
connection generation. Chrome snapshots expose effective values, provenance, negotiated capability,
connection, monotonic local revision and the root gate.

Hiding the launcher leaves API requests and an open tool available. Disabling a child rejects its
new requests with `tools_disabled` and preserves shared tools. Disabling the root collapses all
workspaces, retains frames and blocks all sources. Re-enabling leaves workspaces collapsed.
Permission denial, disconnection, disabled tools and an empty catalog remain distinct states.
Presentation policy grants no server/API permissions and does not stop backend work.

## Manifest Navigation

Core projects only the caller's `ui.navigation`: ordered label/icon, effective endpoint, validated
route, availability/reason, pinned separate link, installation and metadata revision. Empty
declarations occupy no menu space; settings and panels are not synthesized into page navigation.
Icons use absolute Core browser URLs. A stable key hashes endpoint and normalized route within
the installation; duplicate destinations coalesce, retaining their first label. Relabeling or
reordering does not change the key. No manifest schema or global preference key is added.

The fixed app-bound adapter operations are `GET navigation` and `POST navigation/resolve` under
`/api/hosty/ui`; Core equivalents live below `/api/internal/apps/{callerAppId}/ui`.
Resolution accepts `{ appId, installationId, entryKey }`, never an arbitrary destination.
Reading/resolving own navigation requires ordinary app access, without catalog permissions.
A host resolving a child's entry needs its existing `apps.panels.read` or `apps.read` grant and
the actor's access to that target. The verified source registration pins app and installation.
Server adapters retain same-origin write checks, bounded bodies and server-only credentials.

Active matching requires the current endpoint. Exact normalized route wins, then the longest
path-segment ancestor; manifest order breaks ties. Declared query/fragment constraints must match,
and `/` matches only `/`. SDK launch, theme and composition fields do not affect matching.

Same-endpoint navigation uses cached validated entries and a router adapter without a Core round
trip. It remains usable during an outage while the app's normal access state permits interaction;
cached metadata grants no identity or API access. Cross-endpoint navigation always resolves again.
An embedded child replaces its existing app view through the host; its view ID and policy remain,
but the document generation changes. Shell updates its route model. Standalone replaces its own
document. Failure leaves the current page; modified clicks use the pinned separate link.
Actor/installation changes clear the navigation model. Refresh/retry recovers unavailable metadata.

## App Integration

`HostyOverlay` remains the single root. Its default `navigation={{ renderer: "standard" }}` mounts
a manifest menu beside content, or a navigation drawer below 900 CSS pixels. An unavailable model
shows retry without blocking the document. `navigation={{ renderer: "custom" }}` suppresses only
the automatic menu; the model and policy remain available.

Wrap custom navigation in `HostyNavigationBoundary`, or place `HostyNavigation` manually.
Hidden navigation leaves layout, tab order and the accessibility tree while retaining component
state. Hiding focused navigation moves focus to the content landmark. Document actions, identity
controls, project selectors and conversation controls stay outside this boundary. Standard menus
and tools have separate controls; modal coordination prevents competing drawers and restores focus.

`useHostyChrome()` and `useHostyNavigation()` subscribe to immutable snapshots. Framework-neutral
clients use `getChrome/subscribeChrome` and `getNavigation/subscribeNavigation`. Router adapters
provide `getRoute`, `subscribe` and `navigate`, with optional `endpoint` for ambiguous origins.
`@hosty-sdk/app/next` supplies `HostyNextOverlay` and `HostyNextNavigationBridge`; it uses Next's
router without patching global history. The plain SDK has no Next runtime dependency.

`ui.navigate(entryKey, { requestId, signal? })` and
`ui.openToolPicker({ requestId, signal? })` return `accepted` or a typed failure. Picker acceptance
means the chooser is visible, not that a tool or provider operation was selected. A visible child
launcher delegates to the host's chooser; it creates no nested catalog/rail. The delegated launcher
is hidden until composition support is negotiated, including with legacy hosts. A disconnected
previously negotiated host retains a disabled launcher. Replayed accepted
requests neither navigate twice nor reopen a dismissed chooser. IDs share generation-scoped
conflict and concurrency bounds with presentation requests. Timeout/abort after dispatch is
uncertain, not cancellation.

## Views, Workspaces And Instances

| Identity | Scope |
| --- | --- |
| `PanelRef` | Installed declaration: app, installation and panel ID |
| `viewId` | Host-issued app/tool view; document generation changes on reload |
| `workspaceId` | Host-local destination, such as a dock or tool window |
| `presentationId` | SDK-issued retained tool instance |
| `requestId` | Source-generation-scoped operation replay |

The default workspace is `default`, and the top-level view is `root`. These IDs are browser-local;
they are not Core records or credentials. Conversations remain in validated domain routes.

`openSurface(target, { placement: "side", requestId, signal?, reuse?: "exact" | "new" })` requests
a companion surface. `side` permits host-selected dock/window geometry. Exact reuse is the default:
same installation, declaration, resolved endpoint, current validated route and workspace reuse
the most recently focused match. Different routes retain separate frames and drafts. `new` creates
another instance even for the same route. A host may nominate an exact instance in another workspace;
mismatched targets or combining a preferred instance with `new` fail rather than retarget a chat.

Composition `opened` results include `presentationId`, separate from readiness. Replaying a request
returns its accepted identity even after closing; it does not resurrect that frame. Replay revalidates the original accepted destination and access
without confusing deliberate navigation of the live instance with a changed installation. This
destination revalidation also applies after the instance has closed; a moved origin, endpoint or
changed frame policy cannot replay an obsolete acceptance. Reopening needs
a new request ID. Current lifetime is visible in host snapshots. Current routes and readiness are
bound to the exact registered presentation, not merely the initial iframe URL or panel declaration.

`createUiHost` exposes:

- `registerWorkspace({ workspaceId, renderer })`, with one renderer per ID and a disposer that
  refuses a non-empty workspace and supersedes its pending requests before removing the renderer;
- `registerFrame(element, surface, onConnection?, view?)`, also used by `HostyAppFrame` with
  `view={{ viewId, workspaceId, chrome?, navigate? }}`;
- `setViewChrome`, `setPlacementResolver`, `focusPresentation`, `collapseWorkspace`,
  `movePresentation` and `closePresentation`;
- immutable snapshots, catalog selection, width control and the app-facing client methods.

Placement resolvers synchronously choose a registered workspace and optional preferred instance
from source metadata, target and current presentations. They cannot rewrite the target or bypass
Core resolution. Selection ordering is reserved before asynchronous work and superseded per
destination workspace. Collapse or a newer request prevents a late result from stealing selection.
Closing a source retires its unaccepted requests while preserving accepted shared tools. Manifest
navigation updates the retained presentation and React frame coordinator together, so the new
document uses its resolved origin and frame policy for messages and access-review requests. The
accepted panel surface remains separate from that live document: rail selection and catalog refresh
revalidate the panel declaration, while route/readiness reports use the host-resolved navigation root.
A verified manifest page outside the opening panel route survives collapse, refocus and refresh;
reports outside its resolved route tree remain unreported. Same-endpoint route reports include the
matching manifest entry key. The host resolves an unfamiliar root through Core, bound to the
registered app and installation, and accepts it only for the same origin, endpoint and frame policy.
Readiness waits for that validation; superseded reports and closed sources cannot apply late results.
The existing panel root remains valid on its original endpoint, so local back-navigation preserves
readiness and exact reuse. Local routing itself does not wait for this host metadata check.

Renderers implement `present`, `focus`, `collapse`, `release` and `showToolPicker`. An accepted
presentation requires a real attached destination, frame or explicit loading/unavailable state.
Refusal returns `presentation_unavailable`; a finalized discussion remains retryable. Collapsing a
React workspace also dismisses its picker, including when root policy disables tools. Its own picker
modal event does not supersede its opening request in a narrow workspace.
Host chrome overrides are stored by view ID for the host lifetime. Replacement documents inherit
them in both launch hints and handshake policy; explicit changes to a React view's chrome prop still
update that policy. `getViewChrome(viewId)` returns a copy of the effective per-view overrides.

Reopening a selected workspace calls its renderer's `focus`; successful movement of its selected
tool calls the source renderer's `collapse`. External renderers receive these visibility transitions
without a snapshot subscription. Suspending host activity also collapses every renderer-owned
workspace and chooser. Recovery under the same actor retains tools but leaves them collapsed until
explicitly reopened. Movement requires matching renderer `frameLayer` identity. One move per presentation runs at a time. Supersession, close and activity changes abort
the pending renderer operation; refusal or supersession restores the retained frame through its
current owning renderer before returning failure. Concurrent attention, readiness or catalog updates
do not cancel a retained presentation; movement checks its ID and workspace ownership, and commits
the latest metadata. A closed instance is released instead of restored.
If that renderer also refuses restoration, the inconsistent presentation is closed. Renderer release
operations must tolerate an already released ID when cleaning up a cancelled in-flight operation.
Rollback placement also observes source-workspace supersession. If cancellation prevents restoration,
cleanup does not invalidate the newer action. Exact openings exclude instances currently moving or
restoring, so a new opening does not inherit an instance whose placement is being retired.
Pending openings and tool pickers receive a renderer cancellation signal when a newer workspace
action, collapse, source loss or activity change supersedes them. A compliant renderer releases
its pending work on cancellation, allowing the next opening in the same panel queue to proceed.
While a renderer is pending, opening also revalidates the retained destination and availability; a
changed catalog cannot turn an invalidated frame into an accepted opening.
The React renderer keeps iframe containers in one stable DOM layer and positions them
over workspace viewports; movement, switching, collapse and resize never reparent the iframe.

`HostyPanelWorkspace` defaults to the `default` workspace, with `workspaceId` for additional areas.
`layout="responsive"` selects dock/drawer geometry; `layout="dock"` supports host-owned tool windows.
There is one rail entry per declaration and an instance switcher when several views exist.
The header has no close control or separate close status row. Its `minimizeControl` defaults to
`"always"`, exposing a minimize control (`−`, retaining its tool) with an accessible name and hover
description. Hosts using the standard renderer can limit this control to drawers with
`minimizeControl="drawer"`. Shell uses its own ReUI renderer: docked headers retain only the title
and Open separately action, the active rail icon toggles the panel, and narrow drawers provide
Return to document. Other host layouts can close a
view through `UiHost.closePresentation`, releasing only that frame, not the conversation or background work. Actor, Core,
installation and catalog-authority changes release every renderer-owned presentation before resetting
workspace state; disposing the host releases them as well. Escape identifies the selected retained
presentation even after its live route changes. After an acknowledged opening, an explicit Plans
retry uses a fresh presentation request and exact target reuse, allowing a closed tool to reopen
without repeating the discussion handoff. Uncertain openings keep their pending request ID. Separate opening
keeps the domain target without transferring unsent drafts. Catalog access/installation/destination
or frame-policy changes invalidate stale frames. Rail selection also revalidates before focusing.

Workspace colors accept `--hosty-panel-background`, `--hosty-panel-foreground`,
`--hosty-panel-muted` and `--hosty-panel-border` CSS properties. SDK light/dark colors remain the
fallback. Shell does not mount this standard workspace component. Its `ShellPanelWorkspace`
registers the default workspace through `UiHost.registerWorkspace`, retains tool frames using
`HostyAppFrame`, and owns the ReUI rail, picker, header, responsive drawer and bordered document
container. `ShellWorkspaceSplit` provides Shell resizing and preference persistence. This changes
presentation only: host verification, panel targets, context delivery and the authorization overlay
remain SDK-owned. Standalone keeps the standard SDK workspace.

Workspaces, Marketplace and Telemetry UI mount the SDK UI server adapter as well as the overlay.
Their `/api/hosty/ui/[...action]` GET/POST routes require an active administrator session and forward
only the bounded SDK operations to Core. This lets embedded clients accept live Shell policy and
standalone clients load navigation metadata.

## Negotiation And Migration

Wire envelope version 1 negotiates additive `ui.composition.v1` only after the existing exact
window/origin, installation, actor and generation checks. A UI role or URL asserts no capability.
New hosts preserve legacy `openSurface` response shapes. New children with old hosts can use
legacy openings without new options; explicit reuse, delegated navigation and chooser requests
return `unsupported_composition`. No fallback creates a nested host. Host loss retains stale
verified chrome, disables remote actions and offers recovery rather than changing ownership.
Silent renewal preserves same-actor frames; actual access/identity changes keep existing boundaries.

Plans, Marketplace and Workspaces use standard navigation. Shell, Demo, Harness and Telemetry use
custom boundaries. All seven roots use the optional Next adapter and before-paint bootstrap.
Demo's ordinary root explicitly disables local tools with `panelLayout="none"`; `/composition`
enables a two-window fixture and reviewed optional catalog access. Native Shell sends explicit
navigation/launcher-hide and tools-disabled hints plus its legacy native launch hint. Its
authentication transport remains unchanged. Legacy launch exports remain compatible, with
visibility use deprecated; remove old launch-based CSS when adopting composition boundaries.

[Default applications](../default-applications/plan.md) owns provider choice, not presentation.
[Replaceable UI clients](../replaceable-ui-clients/plan.md) owns client eligibility and launch
routing. [Panel visibility](../app-ui-surfaces/plan.md) owns persisted declaration preferences.
None of those features is required to use this contract. The fixture is not a production desktop
shell, and this API does not add context to an existing assistant conversation.

Shell shows recovery guidance when a retained presentation loses its allowed surface. Focus moves
to a selected tool after its frame mounts and returns to the document control on collapse.

## Testing Expectations

- Core tests cover own-navigation access without a catalog grant, foreign access and installation
  pinning, canonical destinations, stable keys, unavailable entries and absolute icon origins.
- SDK tests cover policy precedence/capture/history, copied legacy storage, immutable models,
  endpoint matching, local routing, old/new peers, generation-bound replay, renderer refusal,
  exact/new instances, workspace supersession, source closure and retained frame identity. Cross-endpoint
  navigation tests verify the updated surface, frame policy, theme, commands and permission-review
  routing for both app views and retained tools; messages from the previous origin are rejected.
  Replay tests retain the same instance after same-endpoint and cross-endpoint navigation, while
  actual destination replacement and revoked access still block the original request. The sequence
  includes route reports before readiness, collapse/rail selection, catalog refresh, rejected foreign
  routes, renewed readiness within the resolved navigation route tree and Escape dismissal. Non-React
  renderer fixtures verify frame release on actor/Core/installation changes, authority loss and disposal.
  Delayed-renderer tests cover move supersession/refusal/close, rollback, cancellation and concurrent
  movement rejection, plus successful movement during ordinary metadata refresh. External renderer
  visibility tests cover default/named workspace reopening and selected/non-selected tool movement.
  Opening and rail selection return current readiness after delayed placement/resolution; tests cover
  ready/auth-required reports received during the wait, including the opening event. Activity-loss
  tests verify both rendered tools and choosers hide across workspaces, remain collapsed on recovery
  under the same actor, and preserve retained presentations for explicit reopening. Pending opening
  and picker tests verify cancellation on collapse, newer opening/picker and activity changes,
  including progress of the next queued opening. Workspace removal during bootstrap/panel resolution
  prevents orphaned tools and stale openings after re-registration; pending pickers also retire.
  Catalog restoration supports repeated close/reopen cycles while collapse/reopen retains the same
  iframe and does not request another resolution. Closed-request replay still checks origin, endpoint
  and frame-policy changes. Delayed same-endpoint router tests cover deactivation, disposal and
  renewed request-ID reuse in both host and embedded clients; retired navigation cannot report success.
  Same-endpoint navigation covers manifest-key reports, delayed readiness, invalid destinations, stale
  validation, source closure, return to the panel root and exact reuse without frame navigation.
  Delayed custom navigation callbacks cannot update a retained tool after activity changes, source
  reconnection or closure; synchronous React navigation still updates its surface before replacement.
  Competing move/open/picker requests abort prior destination movement even before a snapshot changes.
  View overrides survive endpoint navigation and component remounting, while explicit prop changes apply.
  Pending new/reused openings cover declaration removal, origin/policy changes, unavailability and
  harmless attention changes. Rollback cancellation covers newer collapse/open/picker actions and
  confirms cleanup does not supersede the newer request. Picker tests at narrow/wide widths verify
  successful opening, collapse/policy dismissal and a fresh opening after restoring tool access.
  Custom frame navigation synchronizes registered authority after acceptance; endpoint replacement
  tests exercise fresh load/probe/accept cycles, current route/endpoint offers, old-origin rejection
  and retained-panel readiness with both unchanged and changed origins.
- Plans component tests use a real SDK host to close and reopen a finalized discussion through both
  visible actions, retain its conversation target and replay a later uncertain opening without
  repeating the assistant handoff.
- Launcher integration verifies the real embedded handshake: no control for a legacy host, working
  delegation after composition negotiation, and a disabled control after disconnection.
- Overlay integration tests cover focus return to the inner app-content landmark when hiding
  custom, standard and drawer navigation, bypassing the non-focusable authentication wrapper.
- Shell integration mounts workspace, settings and right-panel frames for the same app against a
  real SDK host, verifying distinct view IDs and stable frames across rerenders. Shell launch tests
  distinguish stopped/starting service refusal from accepted routing, and frame navigation propagates
  refusal instead of reporting success while staying on the old page.
- App and native tests cover explicit launch policy, route synchronization, notification routing
  by presentation ID, focus, responsive geometry and retained drafts. Version and docs checks
  cover all affected artifacts and feature links.
- Browser acceptance uses Core-managed apps on an isolated data root and normal password login.
  On 2026-10-11, Plans opened the exact finalized Harness discussion beside its document in Shell
  and standalone without another tab; attachment/context transfer, retry and drafts were verified.
  Shell Dashboard retained the same assistant frame after leaving Plans. Harness used its fake
  test provider; no model invocation was part of this presentation check.
- The two-window Demo fixture verified exact sharing, distinct routes, live policy, cross-endpoint
  navigation and source closure. Typed drafts, iframe element, parent and browsing context survived
  movement, collapse and resize. Separate opening preserved the session and restored standalone
  navigation. Narrow drawers and Escape focus return were exercised.
- Failure checks covered real optional permission denial, a stopped Harness, local routing while
  the isolated Core was stopped, and a browser-intercepted empty catalog. Empty-catalog evidence
  is a UI fixture, not a server authorization test. Core/SDK tests cover its server/model behavior.

Verification recorded on 2026-10-11:

| Command / scope | Result |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path "$PWD/build/ui-composition" --verbosity quiet` | 3,139 passed; 4 opt-in Docker/VPN integration tests skipped because their fixtures were not enabled |
| Core build and `UiPanelHttpTests` after the icon-origin fix | Build passed; 31 HTTP tests passed |
| `npm run core:aot` | Native AOT publish passed for osx-arm64 with no trim/AOT warnings |
| `npm test --workspace=@hosty-sdk/app` | 637 passed |
| `npm test` in Shell / Plans / Harness / Marketplace / Workspaces / Demo / Telemetry UI | 191 Node + 244 component / 117 / 536 / 111 / 7 / 4 / 10 passed |
| `npm run build --workspace=@hosty-sdk/app` and overlay upgrade contract script | Passed, including optional Next export and unchanged consumer compatibility |
| `npm run build -- --webpack` in all seven affected web apps | Passed; affected app lint checks passed with no errors |
| `swift test --scratch-path /tmp/hosty-ui-composition-swift` in `apps/shell-swift/HostyKit` | 183 passed; native launch helper coverage, without a WKWebView runtime session |
| `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check`, `git diff --check` | Passed |

Browser acceptance was repeated for Shell and standalone on the implementation builds. The later
review fixes were verified with component/host/overlay and Plans integration regressions, the full
SDK suite and the SDK build; the complete browser matrix was not repeated after those fixes. The test
Core and its apps were stopped afterward; the operator instance was not used for lifecycle changes.
Core restore reported NU1900 because the NuGet vulnerability feed was unavailable; package restore,
compilation, tests and native publish completed. This run does not establish a fresh dependency audit.

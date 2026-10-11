---
status: Draft
created: 2026-10-11
updated: 2026-10-11
summary: Explicit SDK navigation and tool policies with complete standalone defaults and host-owned placement across replaceable shells.
components: [packages/app-sdk, apps/core, apps/shell, apps/plans, apps/demo-app, apps/shell-swift]
---

# SDK UI Composition

## Goal And Approval Boundary

Owner direction, 2026-10-11: provide SDK mechanisms that let any shell choose how to compose apps,
navigation and tools. A desktop shell may keep navigation inside app windows and present an
assistant in a shared window or dock. The current Shell may render navigation itself. Apps must
also remain usable in a plain browser tab without launch parameters or any running shell.

This is a documentation proposal, not approval to implement panels or a desktop shell. The owner
requested publishing this plan together with continuous app access, then working on access first.
[Continuous app access](../continuous-app-access/feature.md) is implemented; this composition plan
remains deferred. Exact desktop placement and assistant conversation-selection UX
belong to the consuming shell/provider; they are not prerequisites or defaults imposed by this SDK.

## Baseline And Target Changes

The shipped [SDK panel system](../sdk-panel-system/feature.md) has one top-level coordinator and
one workspace slot, verified direct child frames, stable `PanelRef` identities and replayable
`openSurface` operations. Plans already opens a finalized discussion in Shell or the standalone
SDK workspace. This plan extends that implementation rather than creating another panel protocol.

Today `AppLaunchMode`, `hidesAppChrome` and `hosty-shell-chrome` couple navigation visibility to
embedded/native launch mode. `ui.navigation` exists, but there is no general SDK manifest-navigation
renderer. Split structural transport/authentication facts from explicit presentation policy.
Being inside an iframe must not, by itself, mean that the app should hide its navigation.

## Default Behavior And Policy

The proposed resolved policy has independent fields:

| Field | Meaning | Plain standalone default |
| --- | --- | --- |
| `navigation` | Show or hide the app's page navigation | `show` |
| `tools.enabled` | Allow tool discovery/open requests through this UI context | `true` |
| `tools.launcher` | Show or hide the standard tool chooser/rail entry point | `show` |
| `tools.owner` | The verified host, or this top-level SDK coordinator | `local` |

`tools.owner` is resolved by the SDK, not a caller assertion. A connected child delegates to its
host even when its navigation is visible. `tools.enabled=false` disables presentation in that
context without revoking API grants or stopping apps. Hiding the launcher only removes that
control; app actions may still request tools when enabled. The default launcher exposes the
actor-filtered catalog, initially with no tool forced open. Existing layout preferences may restore
an opening, but they do not select a provider or create a conversation.

Resolution order for each configurable field:

1. An explicit value from the current verified host's revisioned policy.
2. A valid explicit launch hint for this document.
3. The app's explicit SDK root configuration.
4. The standalone defaults above.

Proposed URL hints are `hosty_navigation=show|hide`, `hosty_tools=enabled|disabled` and
`hosty_tool_launcher=show|hide`. Reject duplicate or invalid values as unusable hints and use the
next policy source. They carry presentation preferences only: no host identity, permissions,
catalog entitlement or authentication authority. A hint cannot make a child a local host.
Absent parameters on a new top-level launch must not inherit a previous tab's hidden-navigation
policy. Preserve a resolved policy across that document's client-side routing; do not persist it
as an app-wide preference. Host layout preferences are a separate concern.

Standalone defaults express behavior within current authority. The root discovers tools only
when its app has `apps.panels.read` or the existing qualifying grant, and lists only panels the
user can access. Missing permission produces a clear unavailable state without hiding app content
or requesting broad management rights. D4 includes the minimal permission/adaptor integration for
the reference standalone app, so the default is demonstrably usable after ordinary install review.

## SDK Contract Proposal

Keep a framework-neutral observable model; React is an adapter. The proposed additions are:

- `ui.getChrome()` and `ui.subscribeChrome(listener)`: resolved policy, policy revision, policy
  source and host-connection state. A disconnected host is distinct from a disabled tool area.
- `ui.getNavigation()` and `ui.subscribeNavigation(listener)`: the current app's validated page
  entries, active route and loading/unavailable state. Navigation data comes through the existing
  app-bound server adapter from Core, not from an arbitrary manifest URL in the browser.
- `HostyNavigation`: the standard accessible manifest-driven page menu. It obeys the resolved
  visibility policy, provides active-item semantics and accepts the app's router/link adapter.
- `HostyNavigationBoundary` and `useHostyChrome()`: a custom top bar, styled menu or another
  navigation layout can obey the same policy without adopting the standard renderer. The boundary
  removes hidden navigation from layout, focus and the accessibility tree; contextual app controls
  such as a project picker remain outside it. Framework-neutral consumers receive equivalent
  state and documented DOM behavior.
- Root configuration supplies initial navigation/tool preferences. A host-side policy setter
  applies overrides to a registered app view and publishes monotonically increasing revisions;
  delayed policies from an old frame generation cannot hide or re-enable the current view's UI.

These names are proposed additions, not claims about existing exports. Preserve the current
`ui.openSurface`, `getPresentation`, readiness and `PanelRef` contract. Presentation hints must
remain separate from authentication state and provider invocation. Do not encode a conversation
ID in a panel ID or introduce a second assistant bridge.

The navigation projection preserves manifest order, labels, icons and declared endpoint/routes,
checks current actor access, and uses Core's validated destinations for cross-endpoint links.
The default view is page navigation for this app, not Shell's fleet/settings sidebar. Custom
navigation may contain app-specific entries, but remains responsible for their routing and server
authorization. Hiding an entry is never an access check.

## Host-Owned Placement And Lifetime

One top-level coordinator remains responsible for all registered direct frames, including tools
opened from the host's own pages. Extend it with opaque view/workspace scopes and a renderer adapter
so a shell can compose several app windows, a shared tool dock or a tool window. A scope describes
presentation lifetime, not a user, grant or assistant conversation.

An open request identifies the exact target and originating view. The host chooses where to place
it and whether to reuse an existing presentation; the SDK must not require one assistant per app
window, a global singleton assistant, or a specific dock/window design. A successful response means
the renderer accepted a concrete presentation; provider readiness remains separate. Preserve
request identity, target pinning, supersession and uncertain-result semantics across the adapter.

Shared panel identity does not imply that all conversations have one view. Permit multiple
presentation instances of one `PanelRef` with different validated routes, and intentional reuse
of an exact existing presentation. Closing the originating app must not implicitly close a shared
tool; the host owns that relationship. Closing a presentation does not delete its conversation or
stop backend work. Moving a retained frame within the same document should preserve its state;
opening another browser tab preserves the domain target but does not promise live unsent-draft
transfer. The SDK must not automatically open browser windows after an asynchronous response.

Keep direct-frame verification and one composition owner. A desktop app window with visible
navigation is still a hosted view; it must not create a nested independent coordinator. The host
may render a dock beside that view using its own workspace scope. Supporting arbitrary nested
embedders is outside this contract.

## Compatibility, Recovery And Related Ownership

Negotiate presentation-policy and multi-view capabilities explicitly. New hosts supply policies;
new apps retain a documented adapter for old explicit `hosty_launch` integrations, including the
native shell, until those consumers migrate. Structural frame detection continues to select the
correct authentication transport. It does not choose the new navigation policy. Never advertise
multi-view support for the shipped single-slot host without implementing the new contract.

Retain the existing distinction between an unsupported legacy host and a known host whose
verification fails. Neither permits silently creating a nested local host. Keep app navigation
usable in supported compatibility mode and expose explicit separate-opening recovery for unavailable
placement. Account mismatch still follows the SDK's protected-content boundary. Core/network
unavailability must not be misreported as a request to hide navigation; authentication and offline
content behavior are owned by [continuous app access](../continuous-app-access/feature.md).

[Default applications](../default-applications/plan.md) chooses an assistant for a new unbound
operation, not its view or conversation. This plan does not change Plans' new-discussion handoff
into an implicit append-to-current-chat operation. A later explicit domain contract would be
required for that behavior. [Replaceable UI clients](../replaceable-ui-clients/plan.md) owns full
client eligibility, launch routing and adoption of this composition contract. The
[panel visibility plan](../app-ui-surfaces/plan.md) retains persisted hide/restore preferences;
root launch defaults neither implement those preferences nor make them global across hosts.

## Deliverables

- [ ] D1. Finalize the policy/model and capability-negotiation contracts, including precedence, URL parsing, compatibility, host loss, independent navigation/tools and multiple presentation instances.
- [ ] D2. Implement Core's app-navigation projection, SDK adapter/model, standard navigation component and custom-navigation boundary/hook with explicit root/host policy support.
- [ ] D3. Extend the SDK coordinator with registered view scopes and a host renderer adapter while preserving target identity, actor verification, request replay, readiness and frame lifetime guarantees.
- [ ] D4. Migrate the current Shell and a standalone reference app to explicit policy; provide a small desktop-style conformance fixture with navigation inside app windows and shared host-owned tools, and cover the native launch compatibility path.
- [ ] D5. Verify the matrix below, document the shipped APIs and migration in the SDK README and feature documents, remove this plan at completion and regenerate the index.

## Verification

- Open the reference app directly with no query parameters and no Shell: standard navigation is
  visible, accessible panels can be discovered, and an explicit tool action uses the local SDK host.
- Exercise standard and custom navigation, app defaults, each URL hint, conflicting/duplicate hints,
  live host overrides and client-side routing. A fresh plain tab recovers standalone defaults.
- Render the same app with navigation hidden in current Shell and visible in the desktop fixture.
  Both send tool requests to their verified host. Host-only pages can open tools without a child.
- Open two app views and two conversations of the same assistant panel. Verify shared-view reuse,
  separate-instance identity, delayed completion, closing/moving views and exact-target readiness.
  Do not assert a particular desktop placement or conversation-selection UX.
- Test denied catalog permission, inaccessible panels, empty navigation, keyboard/focus behavior,
  actor changes, host disconnect, Core outage and explicit disabled/hidden controls separately.
- Run affected Core/SDK/Shell/reference-app tests and builds, browser checks in Shell and standalone,
  native compatibility checks, version checks and documentation validation. Implementation versions
  each affected artifact; publishing this Draft changes documentation only.

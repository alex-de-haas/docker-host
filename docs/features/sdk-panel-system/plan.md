---
status: Draft
created: 2026-10-10
updated: 2026-10-10
summary: Shared SDK panel hosting in Shell and standalone apps, starting with Plans opening its document discussion beside the document.
components: [packages/app-sdk, apps/core, apps/shell, apps/plans, apps/harness]
---

# Shared SDK Panel System

## Goal And Approval Boundary

Owner direction, 2026-10-10: provide one SDK panel system for Shell and standalone apps. The first
complete scenario is **Plans → assistant beside the document**, retaining the selected document as
conversation context. See [vision decision 27](../../vision.md). The owner approved this direction
and requested a separate plan coordinated with [Default applications](../default-applications/plan.md)
and [replaceable UI clients](../replaceable-ui-clients/plan.md). This Draft specifies the proposed
implementation boundary; it does not authorize implementation.

Design revision, 2026-10-10: the owner requested concrete answers for host trust, stable panel
identity and the SDK API. The contracts below replace the earlier open alternatives. There are no
remaining design questions in this draft; accepting these recommendations and marking it Ready
remain a separate owner decision.

One browser window has one composition owner. In Shell, Shell hosts the panels beside either an
embedded app or its own pages. A top-level standalone app hosts the same panels through the SDK.
Apps supply their own panel pages; SDK and Shell supply placement, switching and lifecycle.
Standalone means independent of Shell, not independent of Core, identity or network availability.

## Verified Baseline

Inspected on 2026-10-10:

- [App UI surfaces](../app-ui-surfaces/feature.md) already provide `ui.panels`, resolved metadata,
  icons, readiness and per-app access. Reuse this contribution point rather than creating another
  manifest surface kind or copying provider UI into Shell.
- [ShellRightPanel](../../../apps/shell/src/app/shell/surfaces/shell-right-panel.tsx) already provides
  a rail and embedded body. Collapse preserves the selected frame, but switching tools retains only
  one selected frame. [Panel resizing](../shell-panel-resize/feature.md) provides remembered width,
  keyboard resizing and reset. This is the extraction baseline, not yet a common SDK panel host.
- [Plans' browser action](../../../apps/plans/src/components/discuss-plan.tsx) reserves a new tab
  before its request. Its [server flow](../../../apps/plans/src/lib/discussion-server.ts) verifies
  the source version, prepares a handoff, uploads the complete document and finalizes it, then
  returns a Core app-open URL with forced standalone launch. Shell therefore never receives a
  presentation request for that finalized session.
- [Assistant handoffs](../../../packages/app-sdk/src/assistant.ts) already return a conversation
  ID and an endpoint-relative destination. `resolveAssistantDestination` checks that destination
  against the selected provider's declared UI. The panel system must preserve this contract.
- [Hosty Overlay](../hosty-overlay/feature.md) owns blocking authentication and required-permission
  recovery. It is not currently a docked workspace. The existing text-only
  [assistant entry point](../assistant-entry-points/plan.md) is also not a protocol for opening a
  completed handoff with attachments.
- [Surface contracts](../../../apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs) have no panel ID.
  [Shell's current keys](../../../apps/shell/src/app/shell/surfaces/app-surface-tabs.ts) use app ID
  plus array index, and assistant selection takes the first panel. Provider UI metadata currently
  merges panels, navigation and entrypoint without a kind. Stable IDs and typed projection are
  explicit additions here, not properties that can be assumed from the existing directory.

## Target Experience

| Starting point | Result of Discuss document |
| --- | --- |
| Plans embedded in Shell | The same Shell page keeps Plans in the main area and opens the chosen assistant's discussion in the right panel. Plans renders no second rail. |
| Plans opened standalone | The SDK around Plans opens the same assistant surface in a right panel, with no Shell navigation or Shell runtime dependency. |
| Shell dashboard or native settings | Shell's panel rail remains usable without a central app. A previously opened discussion remains available. |
| Narrow viewport | The shared host uses a dismissible drawer with an obvious return to the document; the desktop layout remains a resizable side-by-side dock. |
| Explicit Open separately | A new tab opens the same provider/session. The source view stays available; opening it performs no new handoff or model execution. |

On a sufficiently wide screen the operator can read the document, edit the assistant draft and
copy between them without dismissing a modal. Opening another central app or a Shell settings page
does not replace the discussion or silently add that page to its context. Context changes remain
explicit domain actions.

## Shared Host And App Integration

Put framework-neutral destination/protocol types and state transitions in the TypeScript SDK,
with a standard React host for the current apps. Extract the existing rail, resize behavior,
embedded-frame coordination, theme, attention and accessible focus behavior into reusable SDK
facilities. Shell retains navigation, its own pages and host-management actions. A standalone host
contains only the app workspace and tools, without reproducing Shell's app navigation or settings.

Keep `HostyOverlay` as the single React root integration, composing separate access recovery,
protocol coordination and panel layout. Embedded instances render no local panel chrome, including
when the embedded app is itself an assistant. Shell places the shared layout inside its own chrome
through a slot API below. Non-React clients can use the controller or implement the wire contract.

V1 supports a top-level composition owner and its directly mounted frames. Deeper cross-origin
relay chains return `unsupported_nesting`; they do not elect a second host or forward claimed
provenance. This deliberately replaces the earlier suggestion of arbitrary nested adapters. Both
required scenarios fit: Shell → Plans and Shell → assistant, or standalone Plans → assistant.

## Host Trust And Protocol V1

Use a **Core-verified, actor-bound presentation binding**, with `postMessage` as transport. The
binding confirms the installed apps, exact browser origins and same signed-in user on this Core.
It does not certify an app's code or grant API/embedding authority. An installed UI remains within
the operator's existing trust decision; this feature does not implement the held CSP designation.

### Bootstrap Without Referrer Trust

1. A host registers each iframe with metadata resolved from Core, its actual `contentWindow` and
   a fresh mount generation. A child generates a random 128-bit document nonce and sends
   `hosty:ui:probe` with versions `[1]` and that nonce to `window.parent`. This is the only message
   allowed to use `targetOrigin: "*"`; it contains no app/user identity, URL, binding or destination.
   Repeat at 250 ms and 1 s if needed; the host also initiates a probe request to the known child
   origin on load. No credential or destination is sent during discovery.
2. The parent checks the probe against a registered frame's window and exact current origin. Its
   own backend asks Core to create a binding for the real host/child installations and origins,
   host-window ID, mount generation and child nonce. Core derives the host actor from the host's
   app grant, verifies access to both apps and the host's panel-discovery authority. The host sends
   `hosty:ui:offer { version: 1, bindingId, childNonce }` to that exact child origin.
3. The child requires `event.source === window.parent`, a direct top-level parent and its current
   nonce. It sends the binding ID and observed parent origin to its own authenticated backend.
   Core accepts only the intended child installation, its current user matching the host user,
   the exact recorded origins and a still-live binding. Its response supplies the verified host
   window ID, mount generation and peer origins. The child needs no catalog permission to
   validate this one relationship. Referrer, URL flags and a claimed app ID are never evidence.
4. The child acknowledges to the now-verified exact parent origin. Before sending
   `hosty:ui:connected`, the host reads Core's binding state through its own backend and requires
   acceptance by the child. A forged acknowledgement is insufficient. Only then may either side
   exchange presentation requests or surface readiness.

Bindings are opaque random references to bounded, in-memory Core records, not bearer credentials:
all reads/acceptance require the appropriate app service token and that app's current user grant.
Use a 60-second pending lifetime and a 10-minute established lifetime, capped by both grants'
validity. Store grant references/hashes, never raw credentials in browser messages or binding
records. Expiry or Core restart requires a fresh handshake on the next operation, without
reloading the mounted app, refreshing user activity or rerunning a handoff. Idempotent binding
creation/acceptance uses the same host generation and child nonce on an uncertain retry.
Cap bindings at 128 per host-installation/user pair and 4096 per Core, pruning expired records
before returning a typed capacity error; never evict an active binding to admit another app.

Both origins must resolve unambiguously to the recorded installations through Core's current
browser-origin policy. Reject `null`/opaque origins, foreign Core instances, arbitrary forwarded
origins and origins shared by different app installations. Behind ingress, use configured trusted
proxy handling; do not accept caller-supplied Host/Origin as a new registry entry. Origin changes,
uninstall/reinstall, identity changes and revoked access invalidate the binding. On every open or
binding-status operation, Core rechecks both parties' live grants, actor equality, assignments,
installations and host permission. Client events invalidate eagerly but are not the access boundary.

### Message And Retry Rules

After connection, use namespaced `hosty:ui:open`, `hosty:ui:status`, `hosty:ui:result` and
`hosty:ui:surface-state` messages with `version`, `bindingId`, child nonce, mount generation and
request ID. The connected message associates a tool frame with its pending presentation ID and
expected route; the SDK carries that correlation for provider readiness reports. Verify window,
origin and generation on every message; use exact `targetOrigin`.
No prompt, document bytes, attachment content, app grant or service credential crosses this bridge.
Map provenance from the registered frame, never from the child's payload. Limit serialized
messages to 16 KiB, with at most 10 opens/minute and 4 concurrent requests per source document;
bound handshake attempts separately so invalid probes cannot cause unbounded Core calls.

The host serializes changes for a tool. Repeated IDs with the same canonical target recheck current
authority, reveal that target without redundant remounting and report its current state, so a
recoverable failure can become success; the same ID with a different target returns
`request_conflict`. Deduplication is scoped to actor, source installation/document and
host-window lifetime, surviving binding renewal. Bound the in-memory ledger to 256 entries per
source; an evicted or post-reload ID reports `unknown`, never fabricated success. Resource matching
still avoids remounting an already selected identical target when an explicit retry opens it again.

Allow 5 seconds for discovery and 10 seconds for an open/status response. An open deadline or abort
after dispatch returns `uncertain`, not cancellation. Query status or retry the same ID/target;
never create a new handoff, open a popup or elect a local host automatically. The source app owns
its completed business result independently of the presentation ledger. A known unsupported host
returns `unsupported` before dispatch; an embedded app never falls back to a nested dock.

Readiness is explicit: placement acknowledgement is `opened`, with `loading`, `auth-required`,
`ready` or `unreported` readiness. Iframe `load` and host acknowledgement do not mean that the
conversation rendered. The target SDK reports authentication state; the provider reports domain
readiness for the exact current route after its session/document has loaded. A wrong route or
stale mount report cannot complete another request. Old surfaces remain `unreported` rather than
blocking forever or claiming success; Harness must report actual readiness in the first scenario.

These browser checks follow the origin, payload-validation and rate-limit guidance in the
[HTML messaging standard](https://html.spec.whatwg.org/multipage/web-messaging.html#web-messaging).
Core binding, actor equality and presentation semantics above are Hosty's proposed contract.

The protocol does not replace `hosty:ask-assistant { text }`. Preserve supported text-entry
behavior through its existing handler; a finalized Plans discussion must never become a new ask.
Legacy wiring/origin work remains with [assistant entry points D4/D6](../assistant-entry-points/plan.md).

## Panel Identity And Destination Resolution

Add optional `ui.panels[].id`, unique within the app's panels, matching
`[a-z][a-z0-9-]{0,63}`; reserve the `legacy-` prefix. New first-party declarations use explicit IDs,
starting with Harness's `assistant`. Duplicate or malformed explicit IDs fail install/update review.
Existing manifests without IDs remain installable; this additive field keeps `schemaVersion: app.0.1`.
Project `panelId` and surface `kind` through the registry, catalog and provider metadata. Do not
continue treating navigation/entrypoint surfaces as implicit side panels.

The reference is `{ appId, installationId, panelId }`. `installationId` is Core's opaque projection
of the existing installation identity (`InstalledAt`), not a timestamp supplied or parsed by an app.
Scope browser preferences additionally by configured Core, user and host app installation. A
panel ID identifies a tool, never a conversation; an opened target adds a relative `route`.

| Change | Identity and navigation rule |
| --- | --- |
| Label, icon, order or public origin changes | Explicit panel identity stays; re-resolve metadata. Never key by display text, URL or array position. |
| Endpoint/base path changes with the same explicit ID | Keep tool selection/preferences, but validate the old route against the new surface. An invalid route becomes `destination_changed`; do not rewrite its session URL or open another session. |
| Explicit ID removed/renamed | Treat it as a different tool. No automatic preference transfer or substitution for a pending target. |
| App removed and reinstalled | A new installation reference invalidates old targets/preferences even with the same app and panel ID. |
| Identical labels or overlapping paths with distinct IDs | Valid separate tools; exact ID selects one. Path inference follows the rules below. |

For ID-less panels, Core derives `legacy-<sha256>` from the UTF-8 canonical JSON array of effective
endpoint key and normalized declared route, including query/fragment; labels/icons/order are
excluded. Core alone computes/projects it using the persisted effective surface contract. Legacy
route/endpoint changes mean a new identity. Identical legacy endpoint/routes collapse to one
catalog tool, using the first declaration only for display metadata; two tools at the same route
require explicit IDs. Conflicting data under the same computed hash is an error, not a merge.

When an update adds an explicit ID, Core records an installation-local alias only for an unambiguous
one-to-one match to the preceding ID-less endpoint/route. Preserve that alias through later updates
while its target ID exists; remove it with the installation. Do not infer a match when the path also
changes or multiple new IDs match. Shell's old `appId#index` preference is mapped once using its
then-current installed catalog, before discarding the index key; an invalid index resets selection.
No old index or alias authorizes a changed installation.

An exact panel target resolves its ID first, then validates its route against that surface's
endpoint and path boundary. Reject external/protocol-relative URLs, dot-segment traversal,
backslashes, control characters and ambiguous encoded separators; reuse and extend the existing
assistant destination validation. Preserve validated query/fragment rather than treating them as
permissions or instructions. With no route, open the current declared entry route.

For an assistant v1 result that has only endpoint/path, infer the panel only among that provider's
declared panels: require the same endpoint and choose the unique longest matching pathname prefix
at a segment boundary. Different panel IDs tied at that prefix return `ambiguous_surface`, including
query-only variants; do not choose by order or label. Add optional `panelId` to `AssistantDestination`
so an updated provider can disambiguate while retaining endpoint/path for old consumers. If supplied,
it must agree with the returned endpoint/path. A navigation-only provider returns `no_panel` plus
its same-session standalone link. Placement never changes the selected assistant.

## Core And Server Contract

Adopt `apps.panels.read` as an optional reviewed permission for a standalone panel host; existing
`apps.read` is sufficient for the same narrow operations. Neither permission grants invocation,
startup or target-app access. Plans declares the optional permission; Shell uses its existing
directory authority. A child can participate in its verified host without receiving this permission.

All following routes live under `/api/internal/apps/{callerAppId}/ui`. Require that app's service
token plus its current app-user grant, with Core deriving the actor rather than accepting a user ID.
All reads are `no-store`, include only actor-accessible metadata and recheck access at use.

| Route | Authority and response |
| --- | --- |
| `GET /bootstrap` | Any authenticated app; own installation, protocol version, host availability and own current browser origins only; no fleet inventory |
| `GET /panels` | `apps.panels.read` or `apps.read`; accessible panel references, labels/icons, declared endpoint/route, resolved origin, readiness and permitted host actions |
| `POST /panels/resolve` | Same host permission; revalidate a target and, for a child-originated open, its established binding; return current embedded destination and separate-open link |
| `POST /assistant-presentation` | `providers.assistant`; actor/consumer/provider installation, role, key and declared UI checks for the already finalized result; return a panel target or placement reason plus the validated separate-open link, with no new invocation |
| `POST /host-bindings` | Host permission; create/recover the pending relationship for this actor and registered child tuple |
| `POST /host-bindings/{id}/accept` | Only the intended child and matching actor; verify observed origin/nonce and record acceptance; no catalog grant required |
| `GET /host-bindings/{id}` | Only a bound participant with its matching actor; verify current binding and access, not an inventory API |

Browser code calls only its own app's `/api/hosty/ui` adapter via `appFetch`. The adapter exposes a
fixed set of bootstrap/catalog/resolve/binding operations, not an arbitrary Core proxy; it validates
same-origin JSON POSTs and the normal session/CSRF contract. Service and user credentials stay on
the app-to-Core leg. The assistant-presentation helper is server-only and called by the existing
Plans discussion handler after finalization, not exposed as an unauthenticated browser shortcut.

Return separate-open links through the existing Core app-open flow, adding an enforced expected
installation plus endpoint/relative-route reference. Core re-resolves and checks that tuple on
redemption, including after login; do not freeze a raw origin or silently accept reinstall. This
app-bound extension belongs here, while context-free primary-UI continuations belong to the UI-client
plan. A 404/unknown protocol becomes `unsupported_core`; no alternative cookie directory is created.
Denied local catalog access leaves the main app usable. Embedded Plans can still delegate to an
authorized Shell; standalone Plans explains the missing optional host permission and offers the
same-session separate link. Catalog access is not a required HostyOverlay gate.

## Public SDK API V1

These names and shapes are the proposed implementation contract, replacing the illustrative
`hosty.ui` spelling. They are not exports in the current SDK. Keep browser, host and server imports
separate; expose no ambient global and no provider-selection method in the presentation client.

```ts
// @hosty-sdk/app/ui — proposed .d.ts contract
export type PanelRef = { appId: string; installationId: string; panelId: string };
export type PanelTarget = { panel: PanelRef; route?: string };
export type UiEnvironment = {
  mode: "standalone" | "embedded";
  connection: "connecting" | "connected" | "unsupported" | "blocked";
};
export type PresentationResult =
  | { status: "opened"; requestId: string; target: PanelTarget;
      readiness: "loading" | "auth-required" | "ready" | "unreported" }
  | { status: "blocked" | "unsupported" | "rejected" | "uncertain" | "unknown";
      requestId: string; code: string };
export interface UiClient {
  getEnvironment(): UiEnvironment;
  openSurface(target: PanelTarget, options: {
    placement: "side"; requestId: string; signal?: AbortSignal;
  }): Promise<PresentationResult>;
  getPresentation(requestId: string, options?: { signal?: AbortSignal }): Promise<PresentationResult>;
  subscribe(listener: (event: { type: "environment"; value: UiEnvironment }
    | { type: "presentation"; value: PresentationResult }) => void): () => void;
  reportSurfaceState(state: { route: string; state: "ready" | "blocked";
    code?: string }): void;
}
export declare const ui: UiClient;
export declare function createPresentationRequestId(): string;
```

`requestId` is a random UUID generated once per presentation attempt and reused on uncertain
retries; it is separate from the assistant's durable handoff ID. Expected operational failures
return the union rather than throwing; `signal` cancels waiting, never a provider operation.
`subscribe` delivers an initial environment snapshot and later changes/results for this client
only. `reportSurfaceState` applies only to the sending app's mounted route, checked against the
current document location and host navigation generation. It cannot acknowledge another panel or
confer authority. Buffer the latest report during connection for the current document/route only;
discard it on navigation or actor change. `opened` commits the requested placement; readiness can
change via subscription.

| Export | Contract |
| --- | --- |
| `/react`: `HostyOverlay` | Existing props plus `uiPath?: string` (default `/api/hosty/ui`) and `panelLayout?: "auto" \| "slot" \| "none"` (default `auto`). All endpoint overrides remain same-origin. |
| `/ui/react`: `HostyPanelWorkspace` | `children` plus optional `onStartApp(ref: {appId, installationId}): Promise<void>`; standard dock/drawer and rail inside the existing root. The start control requires both a callback and server-reported authority; the callback uses the host's separately authorized lifecycle route. No renderer/theme overrides. |
| `/ui/react`: `useHostyUi()` | Returns `{ client: ui, environment }` with reactive environment state; no second client or host is created. |
| `/ui/react`: `useHostyUiHost()` | Returns the root's local host controller or `null`. Shell's existing `EmbeddedAppFrame` uses it to register central app/settings frames; the SDK workspace registers its own tool frames. |
| `/ui/host`: `createUiHost({ uiPath? })` | Framework-neutral browser controller with `getSnapshot`, `subscribe`, `openSurface`, `selectPanel`, `setExpanded`, `setWidth`, `registerFrame(iframe, resolvedSurface)` returning cleanup, and `dispose`. A second live controller in one document is an integration error. Registration is not authority. |
| `/ui/server`: `UiServerClient` | Core transport for the listed routes, including `resolveAssistantPresentation(providerRef, finalizedResult, actorToken)`. Derives caller service identity from server configuration. Returns `{ target: PanelTarget \| null, standaloneHref, reason? }`; provider key/conversation ID stay in the domain result. |
| `/ui/server`: `createHostyUiResponse(request, authenticatedContext, options)` | Framework-neutral Web Request/Response dispatcher over the fixed adapter operations; context contains a server-resolved session and its app grant, never caller-supplied user identity. |
| `/server`: `createHostyUiRouteHandler(config, { administratorOnly? })` | Next adapter matching existing session factories; resolves the app session and calls the framework-neutral dispatcher. Mount for GET/POST at `/api/hosty/ui/[[...action]]`. |

The host snapshot contains the accessible catalog, lazily opened tools, selected `PanelRef`,
expanded state and preferred body width. `subscribe` returns cleanup and emits that snapshot;
`selectPanel(ref)` resolves its declared entry route when unopened, otherwise restores its current
route; `setExpanded(boolean)` and `setWidth(cssPixels)` affect only layout. `openSurface` shares the
client's target/options/result contract. `registerFrame` takes an `HTMLIFrameElement` and
`{ appId, installationId, endpoint, route, origin }` resolved by the host's backend, and refreshes
the generation on document navigation. `dispose` releases listeners, bindings and controller state.

`auto` wraps the standalone protected children in the standard workspace only when the adapter
reports host support; no adapter on an older app means no new rail and no blocked app. `slot` owns
the same coordinator but renders layout only at exactly one `HostyPanelWorkspace`; duplicate slots
are an integration error. `none` disables local hosting while keeping embedded participation and
own-surface readiness. An embedded app suppresses local layout for all three values. Shell uses:

```tsx
<HostyOverlay panelLayout="slot">
  <ShellChrome>
    <HostyPanelWorkspace onStartApp={startAuthorizedApp}>
      {currentPageOrApp}
    </HostyPanelWorkspace>
  </ShellChrome>
</HostyOverlay>
```

Plans retains `<HostyOverlay>{children}</HostyOverlay>` and adds the standard UI route adapter.
After its server completes the discussion, the browser calls
`ui.openSurface(result.presentation.target, { placement: "side", requestId })` when the target is
present. The server result also contains the original provider/key, conversation ID and separate
link. Render **Open separately** as an explicit `target="_blank" rel="noopener"` link; do not add
an SDK method that asynchronously opens an unsolicited popup. A null target displays its placement
reason and that link without choosing another provider.

## Lifetime, Layout And Recovery

- Mount tools lazily. Keep opened tool frames mounted while collapsed, while another tool is
  selected and while Shell's central route changes. Hidden frames are inert and unfocusable. Use
  at most one frame per declared tool, not one per open request or conversation. Session switching
  within that tool uses its own navigation and draft retention. This intentionally extends Shell's
  current single-selected-frame lifecycle; no automatic eviction of unsaved tool state in v1.
- Use dock mode when the workspace's measured inner width, after outer Shell navigation/padding,
  is at least 900 CSS px; below that use a right drawer. The dock keeps a 48 px rail, 12 px gap,
  preferred 360 px body and 280–800 px body bounds, additionally reserving 480 px for the document.
  Constraining the body never overwrites its remembered width. The drawer body is at most 440 px
  and otherwise fits the available width beside its rail. Resizing, reset and rail keys retain
  their current semantics. Resizing across the breakpoint moves layout, not the mounted iframe.
  The drawer traps focus and makes the covered workspace inert only while open; Escape dismisses
  the drawer and returns focus without dismissing a panel's own authentication requirement.
  Since key events do not cross iframe documents, the target SDK forwards an unhandled Escape as
  `hosty:ui:dismiss` over its verified binding. The host honors it only for that currently selected
  drawer, never another frame or an access-recovery dialog. Native host controls use the same action.
- Opening the discussion moves focus into the selected tool after readiness; collapsing or closing
  the narrow-screen drawer restores focus to its opener. Announce loading/failure and expose the
  selected tool accessibly. Theme and attention use the existing SDK contracts.
- Authentication belongs to each app. A panel's sign-in/permission UI is scoped to its frame; it
  cannot make the document inert. Loss of the outer host's identity still blocks its protected
  composition through Hosty Overlay. Same-user recovery preserves mounted state; a user change
  clears previous actor-bound targets. Check portal/inert handling against the existing overlay.
- A transient readiness failure must not destroy an already mounted draft. Stop, removal, lost
  access or installation replacement invalidates the relevant target and shows a recovery state;
  no automatic provider substitution or app startup follows. Treat retained state as memory,
  not a durable/offline recovery guarantee.
- **Open separately** is an explicit user gesture using a validated same-session Core app-open link.
  It opens an additional view with no opener access; it does not detach or close the source frame.
  Provider-persisted handoff context is available there. Unsent composer edits are not promised to
  transfer between origins/tabs; preserve them in the source view and do not label this action Move.

General drag-and-drop docking, live DOM transfer between windows, cross-window draft synchronization,
arbitrary split-editor layouts and offline provider execution are outside this feature. They are
not prerequisites for its first scenario.

## First End-To-End Scenario: Plans To Assistant

1. The operator views a specific source/workspace version of a document and requests discussion.
   Use Plans' current explicit provider choice; this release does not depend on new shared defaults.
2. Plans retains its source/actor checks, content-hash validation, selected provider and request-ID
   replay behavior. It prepares, uploads the complete Markdown and finalizes through the existing
   assistant interface. The result retains the original provider and conversation.
3. Return a typed presentation target and validated standalone fallback, instead of only a URL
   forced to standalone mode. Freeze installation identity before the handoff and reject a changed
   installation when resolving its result. Retrying after finalization must recover that result
   without duplicating uploads, conversations or execution.
4. Call the SDK presentation API. In Shell it reveals the exact target in the shared right panel;
   top-level Plans uses its local SDK host. The document's route, scroll and selection stay intact.
   Do not reserve a blank popup for the normal path.
5. Show the attached document and prepared prompt under the provider's existing draft/review rules.
   Opening a panel does not send the draft or expand execution authority. A presentation failure
   retains the completed result and offers Retry opening and Open separately; neither restarts the
   business operation. Only an explicit new-discussion action creates a new request identity.

The first-party Harness surface must satisfy this flow in both contexts with normal app-owned
authentication. Use a second declared panel in a test fixture to prove that discovery, switching
and restoration are generic rather than an assistant-only container.

## Coordination And Delivery

| Owner | Boundary |
| --- | --- |
| This plan | Panel protocol, minimal discovery/validation, shared SDK host, Shell adoption, Plans presentation and full first-scenario verification |
| [Default applications](../default-applications/plan.md) | Selection policy/store/settings; later supplies the provider before a new handoff. It never chooses placement or reselects a completed result. |
| [Replaceable UI clients](../replaceable-ui-clients/plan.md) | Full UI role, primary navigation and Core recovery; alternative shells conform to this host protocol. A standalone panel host needs no `ui-client` role. |
| [Panel visibility](../app-ui-surfaces/plan.md) | Per-user hide/restore preferences and hidden-target policy; consumes shared surface identities and host hooks without duplicating the renderer |
| [Hosty Overlay](../hosty-overlay/feature.md) and [app sign-in](../embedded-app-sign-in/feature.md) | Existing readiness, identity and recovery guarantees; this plan owns composing panels with them |
| [Embedding restrictions](../app-embedding-restrictions/plan.md) | Deferred operator designation/CSP policy; must accommodate explicitly designated standalone hosts independently of full UI-client status |

The held embedding restriction's ordinary-app prohibition conflicts with Plans hosting an assistant
standalone unless Plans can be designated as an embedder. Keep that plan On Hold and record this
compatibility requirement there. Installing the SDK, declaring panels or declaring `ui-client`
must not implicitly grant embedding authority. Respect actual CSP and show explicit external-open
recovery where embedding is refused; do not weaken CSP to make a demo pass. This feature does not
activate or implement the held restriction.

Recommended dependency order: this complete panel feature first, Default applications' shared
selection second, replaceable UI clients consuming both third. Specification work can proceed
independently. The panel feature must work with today's explicitly chosen assistant and current
Shell, without either Draft dependency. Each feature has its own approval and complete PR; SDK,
Shell and Plans work here stays together rather than shipping one PR per implementation phase.

## Deliverables

- [ ] D1. Obtain owner approval of the specified Core-bound protocol, panel identities/migration, public API and responsive behavior, and set the plan Ready before implementation.
- [ ] D2. Implement Core's actor-bound presentation bindings, optional discovery permission, explicit/legacy panel IDs and aliases, typed metadata/resolution, installation-bound separate links and SDK server adapters.
- [ ] D3. Implement the SDK presentation protocol and shared host, compose it with Hosty Overlay, and cover single-owner negotiation, lazy frame lifetime, responsive layout, theme, attention and focus.
- [ ] D4. Adopt the shared host in Shell, including Shell-owned pages, preserving resize, readiness, app-owned authentication and existing assistant/shortcut entry points without duplicate rails.
- [ ] D5. Complete Plans → assistant in Shell and standalone, preserving source verification and handoff replay while opening the exact finalized session beside its document; give Harness its explicit assistant panel ID and exact-route readiness reporting.
- [ ] D6. Implement same-result presentation retry and explicit Open separately, with visible failure/compatibility states and no implicit new handoff, popup or draft-transfer claim.
- [ ] D7. Pass the verification matrix, update affected current feature/SDK integration documentation and artifact versions, create this feature's reality document, remove this plan only when complete and regenerate the index.

## Decisions Awaiting Approval

The recommendation is complete: online bilateral Core binding with exact window/origin checks,
direct-child protocol v1, explicit panel IDs with deterministic legacy migration, the separate
client/host/server SDK exports above, a single root with automatic or slotted layout, and a 900 px
workspace breakpoint. No design question is deferred to implementation or another feature.
The behavior and contract tests below verify the decisions; they do not choose between competing
designs. This remains Draft until the owner approves this revised proposal. D1 stays unchecked
because the earlier direction/planning approval is not approval of these new contracts.

## Verification

- Protocol/contract: positive round trips and negative wrong-window/origin/source/actor cases;
  unsupported versions, missing referrer, delayed/duplicate replies, frame replacement and timeout
  after successful placement. Test child acceptance before host acknowledgement, shared/opaque
  origins, forged acknowledgements, replayed document nonces, revoked grants, Core restart and
  binding expiry without activity renewal. Repeating a presentation ID never duplicates a handoff
  or tool frame; conflicting payloads fail, evicted IDs are unknown, abort is not cancellation.
- Resolution/access: two providers, multiple/overlapping panel surfaces, navigation-only provider,
  undeclared paths, inaccessible metadata, denied optional grants, stopped/uninstalled/reinstalled
  targets, changed endpoint origin and parent from a different Core. A UI role or capability hello
  grants nothing. Test actual CSP rejection with explicit recovery.
- Identity/migration: reorder/relabel panels; change the route with/without an explicit ID; duplicate
  explicit IDs fail; identical ID-less declarations coalesce; overlapping/tied path matches require
  an ID; unambiguous legacy aliases survive later updates but not reinstall. Test old index-cookie
  migration and older Core/SDK reading the additive manifest/provider fields.
- API composition: auto, slot and none layouts; one live host/root; exactly one slot; Shell's outer
  chrome stays outside the resizable workspace. A non-React fixture uses the same binding/protocol.
  An embedded consumer without a catalog grant can use an authorized host; a local host cannot
  enumerate without its grant. Separate-open redemption checks installation again after login.
- Business regression: stale document hash rejected; complete correct-version attachment arrives
  once; pending request resumes after lost prepare/upload/finalize response; changed defaults never
  replace the frozen owner. No model run is introduced by open, retry, focus or Open separately.
- Browser acceptance through Core-managed Shell/Plans/Harness and normal password login: document
  and its exact discussion visible together in both launch modes; no popup on the normal path;
  no nested rail; Shell dashboard/settings can open and retain tools without a central app.
- State/accessibility: preserve document scroll, selection and assistant draft through collapse,
  tool switch, central navigation and same-user recovery; invalidated actor cannot see old frames.
  Verify keyboard rail/resize, focus return, hidden inert content, light/dark themes, narrow drawer,
  delayed target authentication and outer-overlay portal blocking. An unopened tool does not mount.
  Exercise 899/900 px available workspace widths, long labels and zoom; breakpoint changes preserve
  frame identity. A provider must report the expected route before readiness becomes `ready`.
- Compatibility: old Shell/new SDK, new Shell/old app SDK, unsupported Core, iframe-cookie refusal,
  missing discovery grant and explicit separate opening. First-party compatible versions must pass
  the full side-panel scenario; fallback alone is not acceptance for those versions.
- Run affected Core/SDK/Shell/Plans/Harness tests and builds, Core AOT validation for changed
  contracts, version checks and docs validation. Version each changed release artifact under
  repository policy. Documentation-only planning requires no build, runtime restart or version bump.

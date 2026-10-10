---
created: 2026-10-10
updated: 2026-10-10
summary: Shared SDK panels compose app-owned tools beside documents in Shell and standalone, with verified peers and pinned presentation targets.
components: [packages/app-sdk, apps/core, apps/shell, apps/plans, apps/harness, apps/demo-app]
---

# SDK Panel System

Plans opens its completed assistant discussion beside the document. Shell owns the workspace when
Plans is embedded; top-level Plans uses the same workspace supplied by Hosty Overlay. Opening,
retrying, switching or focusing a tool does not submit its draft or start a model run. An explicit
Open separately link opens an additional view of the same conversation.

## Ownership And Identity

An application owns its domain operation, session, protected UI and readiness. The SDK owns panel
composition and the browser protocol. Core supplies installation metadata, access checks and
validated navigation; it stores no browser connection, frame lease or presentation ledger.

`PanelRef` contains `appId`, `installationId` and `panelId`. Installation identity is the opaque
installed-at value exposed by Core: updates retain it, reinstalling changes it. `PanelTarget` adds
an optional route within that panel's declared path. Conversation identity remains in the provider's
route and domain result, rather than becoming a panel ID.

Manifest panels optionally declare `id`: a lowercase letter followed by at most 63 lowercase letters,
digits or hyphens, unique within the app. The `legacy-` prefix is reserved. Core computes legacy IDs
from the effective endpoint and normalized route using SHA-256; identical legacy declarations
coalesce. Relabeling, icon changes and reordering preserve identity. Changing a legacy route or
adding an explicit ID changes identity without aliases or index migration. Explicit IDs survive
route changes, but an old deep link must still fit the newly declared route.

## Core And Server Adapters

The fixed internal routes are scoped to the caller app:

| Route below `/api/internal/apps/{callerAppId}/ui` | Result |
| --- | --- |
| `GET /bootstrap?parentOrigin=...` | Protocol version, own app/installation, actor, Core origin, hosting/pinned-open support and optional verified parent metadata |
| `GET /panels` | Actor-filtered declared tools, stable identities, availability and minimal frame policy |
| `POST /panels/resolve` | Revalidated target, concrete frame surface and pinned standalone link |

Every request requires the caller's own service credential and its current app-user grant. Bootstrap
does not require catalog access. Hosting/discovery requires the optional `apps.panels.read` grant;
existing `apps.read` also qualifies. A child without catalog permission can use an authorized host.
Capabilities, UI roles and browser messages grant no API authority.

Peer lookup accepts an exact non-opaque origin identifying one installed, accessible app with
hosting authority in the same Core. Unknown, ambiguous and inaccessible origins fail. A host can
be an ordinary app such as Plans; it needs no full UI-client role. The catalog exposes microphone
and popup-escape booleans derived from the target's granted permissions, not its full permission
inventory or the caller's grants. Service-specific health allows an operational UI during an
unrelated service outage; degraded surfaces show a warning.

`UiServerClient` and `createHostyUiResponse` implement these operations for Web Request/Response
servers. Next apps mount `createHostyUiRouteHandler` at `/api/hosty/ui/[...action]`; Harness uses
the same dispatcher with its own verified administrator session. The adapters resolve credentials
server-side, enforce same-origin JSON writes and bounded bodies, and expose no arbitrary proxy.
An older Core or missing adapter produces explicit unsupported behavior.

Core app-open links carry `installationId`, `endpoint` and `route`. Core checks the installation,
declared surface and user access at redemption, including after password login. The link retains
the provider-selected route and forces standalone launch. Readiness uses the matched surface service,
including navigation and entry surfaces, so an unrelated sidecar outage does not block opening.
Reinstalling never redirects a completed
discussion to the replacement installation.

## Browser Trust And Protocol

Only the top-level document hosts composition, with directly embedded children. A child begins
with a capability probe containing a version and random document nonce, without identity or target
data. It verifies the observed parent origin through its own authenticated server before sending
its actor/Core/installation metadata. The host independently binds the exact registered window,
origin and surface. Subsequent messages use the exact origin, host-window ID, frame generation and
child nonce. Navigation replaces the generation and invalidates that document's request ledger.

Cooperating SDK surfaces compare both Core and actor identity before mounting protected content.
An account mismatch blocks the child and offers reconnection. Target authentication stays inside
its frame; host authentication blocks the outer composition. An auth-required advisory carries no
credentials or authority. Same-user recovery rechecks the channel; actor/host-installation changes
clear old targets. Activity renewal suspends the embedded channel and discovery; inactive calls are
blocked without I/O. Unsent work is blocked, while already-dispatched work becomes uncertain.
Resumption uses a fresh nonce and verified handshake; stale replies or verification cannot restore
the old channel. A verified peer is an installed app, not a trusted implementation: this protocol
does not isolate the UI from a malicious embedder or replace each app's server authorization.
Legacy surfaces that do not negotiate cannot claim the cooperative account-matching guarantee.

Discovery and readiness are bounded. A known host whose verification times out remains blocked;
an unsupported legacy host permits compatibility rendering without a nested panel host. Readiness
is separate from successful placement: `loading`, `auth-required`, `ready` or `unreported`. Only a
matching declared installation, endpoint and exact route can report ready. A blank/CSP-refused or
older surface remains unreported and exposes explicit separate opening.

Presentation IDs are caller-generated UUIDs, distinct from handoff IDs. The host keeps a bounded
window-local ledger scoped to source document and serializes operations per tool. Matching replay
revalidates authority and reuses the frame; conflicting payloads fail. Status rechecks the target.
An aborted/timed-out wait is uncertain, not cancellation; retry/status uses the same ID. Message
size and concurrent-request limits bound work. Core restart requires no browser-lease restoration.
Immediate validation, conflict and concurrency refusals reach the embedded caller through the same
response path as successful placement. The child reserves a request ID and target before asynchronous
verification, coalesces identical in-flight calls and rejects conflicting targets locally. Status
queries share an existing opening; a later opening waits for an earlier status query to finish.
New accepted openings and explicit collapse supersede pending selection intents. An older resolution
returns `presentation_superseded` without replacing a newer selection or reopening the workspace.
An explicit retry revalidates and can open the same target.

## SDK Integration

`HostyOverlay` owns one coordinator. Its `panelLayout` modes are:

- `auto`: the standard standalone document/tool layout; embedded participation suppresses it.
- `slot`: composition at exactly one `HostyPanelWorkspace`, used inside Shell's outer chrome.
- `none`: no local panel layout, retaining embedded participation and readiness reporting.

The framework-neutral `ui` facade and `useHostyUi()` expose `getEnvironment`, `subscribe`,
`openSurface`, `getPresentation` and `reportSurfaceState`. `createUiHost` exposes the same client
contract plus catalog/tool snapshots, frame registration, selection and layout control. A second
live host or duplicate workspace slot is an integration error. Older app adapters receive no new
panel chrome. See the [SDK integration examples](../../../packages/app-sdk/README.md).

`resolveAssistantPresentation(provider, result, { expectedProvider })` is a pure mapper. It checks
the frozen app/installation/provider key and the declared endpoint/path. An explicit provider-returned
panel ID must match; otherwise the unique longest panel path wins. Ties require an ID. Navigation-only
results retain their validated separate destination and report `no_panel`; the mapper neither
chooses a provider nor performs I/O.

The shared `HostyAppFrame` applies sandbox and clipboard/microphone policy, theme messages,
attention, app-owned authentication and permission/MCP review. Reviews use the registered app
identity and canonical Core URL, ignoring child-supplied identity/URLs; a visible link remains when
popups are blocked. No delegated-token responder is installed. HTTPS hosts refuse HTTP frames with
explicit recovery. Shell forwards its existing standalone workspace URL and the declared settings
or legacy panel URL to that recovery link; the embedded launch URL is not reused. Actual CSP remains
authoritative.

## Layout And Lifetime

Standalone shows opened tools and Add tool; the chooser lists accessible declared panels before
any discussion. Shell uses the catalog rail, including on Dashboard/settings, and retains its icon
renderer and layout cookies. Neither layout adds provider defaults or fleet management to Plans.

Frames mount lazily, one per opened tool, and survive collapse, tool switching and central Shell
navigation. Hidden frames are inert. Document state and unsent composer state remain local to their
mounted views. Stop/removal, lost access, changed installation/origin/path or policy invalidate the
affected surface; transient readiness loss, including `starting` and `stopping`, retains the existing
frame until a completed stop or an independently invalidated identity, destination or policy. No automatic provider substitution or app
startup occurs. Reload clears the window-local tool selection; width/open preferences remain
host-scoped. Separate opening preserves provider-persisted context, without promising transfer of
unsent edits between windows.
Retained frames receive current availability and runtime metadata, so degradation warnings appear
and disappear with the catalog without navigating the iframe.

Shell restores an open panel by selecting the first available catalog tool after metadata arrives,
unless a tool is already selected or the operator has collapsed the workspace. A refused restoration
can retry on fresh catalog metadata, including metadata received while resolution was pending; it
does not loop on unrelated state updates. A notification's
assistant-session link takes precedence over this default restoration. Shell observes the independent
panel catalog and consumes the link only after successful placement; a refusal retains the link for
retry on refreshed metadata. Stale completion after leaving the link cannot consume a newer URL.
Shell chrome reads expansion from the host snapshot. Cookie or legacy localStorage preferences
initialize the host once; an explicit session link defers default expansion until its placement.
The top-strip toggle follows SDK changes and its first click acts on the actual host state.
The assistant keyboard shortcut waits for catalog metadata and selects its requested tool directly;
it does not concurrently expand a default tool. Repeating it on the visible assistant collapses it.
Shell retires obsolete or reinstallation-mismatched pending handoff records with an explicit error.
The next operator retry creates a new request for the current installation; it never moves the old
discussion. Completing an older request cannot erase the replacement's pending intent.

At 900 CSS pixels of inner workspace width the layout docks: a 48-pixel rail, 12-pixel gap, default
360-pixel body, 280–800 bounds and at least 480 pixels reserved for the document. Below that it uses
a drawer up to 440 pixels wide. Constraints do not overwrite the preferred width. Arrow keys resize
in 16-pixel steps; Home/double-click reset. Rail arrow/Home/End keys move focus. The drawer makes
covered content inert, traps focus and restores it on dismissal; an unhandled Escape inside a
cooperating child is forwarded through its verified channel. Breakpoints change CSS placement,
not iframe identity.

## Plans Discussion Flow

Plans freezes the selected provider installation before prepare/upload/finalize. Its existing actor,
source, content hash, attachment and handoff replay checks remain authoritative. The result contains
the finalized conversation, typed presentation target and pinned separate link. Browser state is
bound to the actor, document version and provider; persisted pending intent retains the original
request/installation across a lost response. Completed-result reuse also requires the selected provider
installation. After reinstall, the original pending intent is revalidated and refused; only the explicit
Start a new discussion action creates a handoff for the replacement.

The normal path calls `openSurface` with a presentation UUID. It opens Shell's panel when embedded
and the local SDK host when standalone, without reserving a popup. Plans distinguishes successful
placement from provider-reported readiness. Retry opening reuses the completed result; Open
separately is an explicit noopener link. Neither action repeats uploads/finalization or submits
the prepared draft. Harness reports readiness only after loading the exact requested session,
including requests delivered by Shell messages to the default assistant route. A failed or mismatched
session fetch cannot report a previously attached session as ready for that request.

## Related Features

[Default applications](../default-applications/plan.md) owns selection policy before a new operation;
it does not reselect finalized results. [Replaceable UI clients](../replaceable-ui-clients/plan.md)
owns full client roles/navigation and consumes this host protocol. [Panel visibility](../app-ui-surfaces/plan.md)
owns persisted hide/restore preferences. [Embedding restrictions](../app-embedding-restrictions/plan.md)
remains On Hold: a designated standalone embedder is distinct from a full UI client, and this
feature does not confer that deferred designation. Current CSP refusal has explicit recovery.

## Testing Expectations

- Core HTTP/contract tests cover caller/user credentials, optional grants, actor filtering,
  ambiguous origins, explicit/legacy IDs, reinstall, service health and app-open pinning after login.
  Separate-open tests cover panel/navigation/entry service readiness during a sidecar outage,
  degraded probes, stopped services and app transitions.
- SDK tests cover exact peers/generations, same-account negotiation, delayed verification, route
  readiness, replay/conflicts, uncertain waits, metadata/policy changes, fixed server adapters,
  inactive request refusal, uncertain dispatched work, renewed handshakes and stale verification,
  host ownership, Overlay gating and retained React frames across layout changes.
  Runtime-transition coverage preserves the actual iframe and unsent content through
  stopping/starting/recovery, while a completed stop or changed frame policy removes it.
  Degradation-warning tests cover appearance and recovery on the same retained frame.
  Concurrent-request tests exercise immediate embedded refusals, payload conflicts during
  verification, identical replay, independent aborts and status/open ordering. Selection tests cover
  collapse during bootstrap/resolve, out-of-order selections, queued routes and delayed restoration.
- Plans/Harness/Shell tests preserve source hashes, complete attachments, provider freezing,
  idempotent handoff recovery, review routing and existing assistant entry points. Plans tests cover
  completed results across provider reinstall, including navigation-only destinations and explicit
  replacement handoffs with the original document hash. Harness tests cover message-selected readiness
  before and after authentication, failed/mismatched session loads and exact URL-session reporting.
- Delayed-catalog tests cover restoring Shell's open preference, preserving an existing selection
  or collapse, and consuming assistant-session links only after successful panel placement.
  Restoration tests also cover transient refusals, bounded retries and catalog refresh during resolution.
  Shortcut tests verify that a non-assistant first catalog entry is never selected, including delayed
  metadata, and that toggling the selected assistant closed creates no new placement. Shell chrome
  tests cover delayed/refused links, cookie/legacy preference migration and the first toggle in both
  directions against the actual SDK workspace. HTTPS Shell frame tests preserve explicit standalone
  recovery for HTTP workspace, settings and legacy panel surfaces while continuing to embed HTTPS.
- Shell intent tests cover legacy/malformed storage, reinstallation recovery by explicit retry,
  actor isolation and stale completion after an intent is replaced.
- Browser acceptance uses Core-managed apps and normal password login in an isolated data root.
  Exercise Plans beside its finalized discussion in both modes, no implicit popup/nested rail,
  a non-assistant tool before discussion, retained drafts/document state, Shell-owned pages,
  keyboard/width/theme behavior, own-frame access recovery and explicit same-session opening.
- Exercise actual CSP refusal, permission/MCP review and microphone policy with browser fixtures;
  fake media is sufficient for capture/delegation checks. Never claim that a protocol fixture proves
  a real speech provider transcribed audio or a model executed a prompt.
- Build affected apps/SDK/Core, run their affected suites, validate Core Native AOT contracts, and
  run version and documentation-index checks. Versions start at Core 0.129.0, SDK 0.25.0,
  Shell 0.99.0, Plans 0.5.0, Harness 0.48.0 and Demo App 0.15.0.

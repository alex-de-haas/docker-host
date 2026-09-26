# Hosty Harness Swift Client

Status: Draft
Created: 2026-09-25
Updated: 2026-09-26

## Goal And Owner Direction

Build a dedicated native Swift client for **Hosty Harness**, focused on assistant sessions rather
than management of all installed Hosty apps. The owner selected this direction on 2026-09-25 after
considering sidebar/panel support in the existing Swift Shell. The primary scenario is using the
assistant from a phone while the agent and its workspaces run on a remote Hosty machine.

This is an early Draft. It captures the requested client, not approval to implement or a final
screen design. It is a separate application from `apps/shell-swift`. The existing
[Swift Shell](../swift-shell/feature.md) remains the full host-management client; this work does not
retire it or add generic app side panels to it. The web Shell remains available independently.

## Dependencies And Ownership

[Shared assistant development sessions](../assistant-development-sessions/plan.md) is the umbrella.
Its children own [AHP](../assistant-ahp/plan.md), [provider switching](../assistant-shared-history/plan.md),
[workspaces](../assistant-session-workspaces/plan.md), [PR lifecycle](../assistant-pr-lifecycle/plan.md),
[action summary](../assistant-action-summary/plan.md) and later
[timeline analysis](../assistant-timeline-analysis/plan.md). This client consumes their advertised
capabilities without implementing host-side policy or Git operations on the device.

`apps/shell-swift/HostyKit` already contains CoreClient, DeviceLogin, HostConnection, CoreEventStream
and HostNotification. Prefer reusing a shared Swift package, possibly relocating it after dependency
review, over an independently maintained copy. Decide the package/release boundary and app-specific
storage before implementation. Existing Core credentials still need correct Harness/AHP audience
and permission checks. Keep native app identity/versioning independent and choose bundle id, source
directory and Apple platforms before Ready; this is an operator-installed client without a runtime
app manifest.

## Target Experience

1. **Connect.** Add or select a Hosty environment, authenticate and discover its Harness endpoint
   and supported capabilities. Always show the environment so production and local sessions are
   not confused. Explain unavailable Harness or incompatible protocol versions explicitly.
2. **Open a session.** List existing sessions with titles, activity and pending input. Create a new
   session or open the same one used in the web client. Load history and current state from the host.
3. **Talk to the agent.** Send messages and supported attachments, stream responses/tool activity,
   and choose an available internal agent for subsequent work. Codex/Claude switching consumes the
   server's shared-history contract; no model-provider credentials or agent process are needed on
   the phone. The client can interrupt a turn using the server's supported operation.
4. **Respond to requests.** Present permission requests and agent questions with the actual target,
   proposed action and relevant input; submit a decision tied to the pending server request.
   Expired, already-resolved and revoked requests cannot be approved from a stale screen.
5. **Inspect the work.** Show contextual apps, repositories, changed files and readable diffs,
   distinguishing uncommitted changes from the complete session change set. Expose tool details,
   summary and timeline as their server capabilities become available, including coverage gaps.
6. **Use session actions.** Offer advertised, authorized actions to run the session's source for
   testing, open the app, publish changes and inspect PR/CI state. Keep Merge and Complete distinct
   and display the server's eligibility/blocker information. All operations execute on the host;
   the device does not need a local clone or local filesystem access to server paths.
7. **Return later.** Closing, suspending or disconnecting the client does not cancel server work.
   Reconnect and restore current history, diffs and pending requests without resubmitting commands.

These are assistant-specific native screens, not a requirement to embed arbitrary app panel iframes.
Opening a tested application can use its authorized web surface; the exact presentation remains a
design choice. The initial client need not expose full app installation, lifecycle administration,
the feedback-triage inbox or an unrestricted remote terminal to satisfy this experience.

## Phone-First Navigation Proposal

On a compact phone, prefer a session list leading to the conversation, with clear routes or sheets
for Changes, Activity and pending decisions. A diff/file view can occupy the screen instead of
squeezing it into a permanently visible desktop sidebar. Keep the environment/session identifiable
and preserve the draft and reading position when opening details or answering a question.

For larger Apple displays, consider a split view with session navigation, conversation and optional
detail pane. These are proposals to validate with the owner, not a commitment to ship iPadOS/macOS
in the first release. Include keyboard avoidance, readable long diffs, Dynamic Type and VoiceOver
in native design/verification rather than copying the web Shell layout pixel for pixel.

## Protocol And State Contract

Use AHP as the primary conversation/state transport: session discovery, subscriptions/snapshots,
history, streamed responses, tool calls, approvals/questions and changesets. An official Swift
package exists in the inspected [upstream snapshot](https://github.com/microsoft/agent-host-protocol/blob/296b25e7b698a4a84a0ee5a28d9573e70048a0bf/Package.swift),
with AgentHostProtocol and AgentHostProtocolClient products. Pin and test its transport, channel,
authentication and deployment-target compatibility; package existence is not end-to-end verification.

Owner decision, 2026-09-26: build the native client on the official Swift AHP SDK after the
AHP foundation is verified. REST/SSE is not a selected native delivery path. Internal-agent
switching and optional workspace/PR views arrive through their separately advertised server
capabilities; they do not require the native client to invent another session transport.

Hosty-specific actions such as source selection and PR completion consume the server's advertised
extension/API contract. The spike must choose their native mapping and authorization route; do not
pretend they are universal AHP methods or bypass policy with direct GitHub/SSH calls from the phone.

Use stable session/turn/request ids and server ordering. After disconnect, reconcile snapshots and
replay; an uncertain send/approval must be resolved by operation identity/state, not blindly resent.
Define unsent-draft versus accepted-message UI. Handle agent switching on another client and remote
approval resolution without duplicate submissions. Authorization remains server-enforced regardless
of a button's visibility. Store credentials per environment in Keychain and handle revocation.

Do not rely on a continuously running mobile connection for background work or monitoring. The host
owns execution; the client resynchronizes on return. A foreground-only first version cannot notify
a suspended iPhone that approval is needed; the operator must reopen it. Decide explicitly whether
that is acceptable for the first release or whether remote notification delivery is a prerequisite.

## Notifications And Session Links

[Background sessions](../agent-background-sessions/feature.md) already emits waiting-session
notifications with `?assistantSession=` links into Shell; Swift Shell can show macOS banners. Reuse
their stable notification/session identity. Define web fallback and authenticated native routing
when Harness is installed, including environment selection and revoked/deleted session handling.
Choose an explicit receiving-app preference and deduplication ownership when both native clients
are present, so one notification does not produce duplicate OS banners. Opening a link never
answers an approval automatically.

[Notifications](../notifications/plan.md) owns the proposed web/mobile push delivery channel;
this plan owns client registration, native deep-link handling and foreground/background behavior
when that channel exists. APNs/background alert delivery is a dependency or separately approved
later slice, not provided by AHP reconnect or a foreground event stream. Select and document that
release boundary before Ready.


## Deliverables

- [ ] Decide first Apple platforms, deployment target, bundle/source identity, independent version
      source and release/distribution route; review a phone navigation proposal before Ready.
- [ ] Reuse HostyKit through the selected shared-package boundary and validate app-specific credentials/storage.
- [ ] Verify the pinned official AHP Swift client against the AHP foundation contracts, including host
      selection, sign-in, reconnection and unsupported-version handling.
- [ ] Implement session notification routing, web fallback and dual-client banner deduplication;
      define the notification release boundary and integrate device registration if push is selected.
- [ ] Implement native session list/history/composer, streamed activity, supported attachments and
      internal-agent selection with preserved drafts and server-authoritative state.
- [ ] Implement permission/question presentation and replies, cancellation, stale-request handling
      and consistent state when another client resolves the same request.
- [ ] Implement repository/file/diff views and advertised session actions/status; reuse server
      evidence for PR/CI, source selection, summary/timeline and Merge/Complete eligibility.
- [ ] Verify the end-to-end remote phone workflow and failure cases below, document shipped behavior
      in `feature.md`, remove this plan when complete and regenerate the index. Add the native
      artifact's version policy when implementation ships; documentation alone needs no version bump.

## Open Questions And Sequence

Resolve authentication/discovery and AHP feature coverage with the server plan first. Then validate
compact navigation, implement conversation and approvals, add changes/actions, and verify real remote
use. One feature PR for the approved scope; phases are not separate PRs. This plan has its own Ready
approval and does not inherit implementation approval from the server's Draft.

Open questions: iOS-first or broader Apple support; minimum OS; exact app/bundle/source naming;
native AHP dependency and its supported channels; server action mapping; sign-in/discovery route;
attachment limits/access; device-local history/cache retention; testing-app presentation; signing,
distribution and component reuse boundaries with Swift Shell; foreground-only versus push-dependent
first release, native-link ownership and coexistence with Swift Shell notifications.

## Verification

- From a phone, connect to a remote Hosty, open an existing session, read history, send a request,
  inspect changed files/diffs, answer an agent question and approve/deny a concrete pending action.
- Plan with Codex, review with Claude and return to Codex in one server session; observe the same
  conversation from the web client and verify the phone shows current provider/activity.
- Start work, background/disconnect the client, then return: server execution continues, history
  catches up, and uncertain sends/decisions do not execute twice. Test an approval resolved on web.
- Exercise unavailable host, incompatible protocol, missing optional capability, expired/revoked
  credentials and two environments with distinct credentials/session ids. Do not silently redirect
  an action to another environment or broaden authority.
- Run session source through the server, open its app surface and observe PR/CI and Merge/Complete
  blockers. Read-only credentials or unsupported operations never gain write access through the UI.
- Check compact-screen navigation, long diffs, keyboard/draft retention and accessibility on the
  approved platforms. No local agent, source checkout or changes to full Shell Swift are required.

- Verify a waiting-session notification opens the correct environment/session, including a web
  fallback, two installed clients and a revoked session. Verify banner deduplication. Background a
  phone and demonstrate the selected delivery guarantee; foreground-only builds must not claim APNs.

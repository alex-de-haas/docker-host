---
status: In Progress
created: 2026-10-12
updated: 2026-10-24
summary: Remaining Hosty design implementation, acceptance gates and separately reviewed Core/SDK contracts, with stable deliverable IDs.
components: [apps/shell, apps/shell-swift, packages/app-sdk, apps/core, apps/harness, assets/hosty-brand, apps/plans, apps/telemetry, apps/telemetry-ui, apps/demo-app, apps/marketplace, apps/whisper]
---

# Design System

## Goal

Give Hosty one visual language that reads as calm and corporate without being grey and gloomy,
and apply it to Shell. Chrome stays ink and white; color is spent on what is alive on a host — app
tiles, status and data. The same rules must hold from a wide desktop to a Shell window squeezed
beside an agent and to a phone.

## Implementation Approval And Review Workspace (2026-10-21)

The owner approved incremental implementation against the supplied design, with Shell, Harness and
Marketplace using the registered redesign workspace on the current Core for live review. The initial review kept changes uncommitted while the owner clarified the result. The owner
authorized a checkpoint commit on 2026-10-23; later implementation remains separately reviewable. Match the artboards closely,
but preserve every supported capability and action: relocation into a menu, dialog or another
appropriate surface is allowed; removal is not. A rare exception requires an explicit owner decision,
not an inference from missing mockup content. Unsettled interactions stay open and retain their
existing working controls until resolved.

The current implementation adopts shared visual foundations, Dashboard rows, top-strip tools,
in-page Settings navigation, complete Manage section composition, Harness session/workspace cards
and Marketplace views. The remaining deliverables stay open until their own verification passes.
The live trial is explicitly authorized; it does not replace isolated acceptance or authorize Core
restarts, source cleanup, commits or publication.

### Functional Inventory For The Current Batches

| Surface | Actions and states retained during adoption |
| --- | --- |
| Dashboard | Search and combined state filters; fleet/per-app update checks and review; install; start/stop/restart/autostart; package/source/workspace selection and Return; service state/health/resources and addressable Logs in Manage; Dashboard Logs and More > Console logs entries; configuration, app settings, permissions, backup/restore, removal; addresses/ports/public origins; resources/history and unavailable data; Core source/restart/update controls; environment creation/progress/setup/resume/lifecycle. |
| Shell chrome and forms | Navigation and current routes, role/permission restrictions, theme and notifications, tools and retained frames, keyboard/focus, unsaved settings and confirmation flows; Apps Open/Standalone and administrator-only Uninstall through Core. |
| Harness | Sessions, provider/account/model selection, transcript and composer, attachments/speech, approvals, workspace and runtime controls, previews, source/diff/Git/PR/CI/review operations, external workspaces and settings. Workspace/title/app search and activity chips preserve the flat list, ordering and identity; the Sessions heading carries icon-only Create app, Continue building and New session actions with no separate app selector; pinned decisions navigate to the existing card; workspace hiding preserves the mounted context. |
| Marketplace | Catalog source/settings, refresh/diagnostics, search/category filters, app detail/screenshots/description, feed choice, installed/update states, installation confirmation/cancellation/retry and session-expiry recovery. |

### Remaining Work And Acceptance Boundary

The current implementation is documented in [feature.md](feature.md). Prior batch commands and
limitations are preserved in the [verification evidence archive](../../reviews/2026-10-22-design-adoption-evidence.md).
This plan no longer treats those chronological results as the current verification state.

The deliverables below separate work that still needs code, acceptance of existing behavior, and
Core/SDK contracts or unresolved design decisions. A missing checkbox does not mean that a whole
screen is unimplemented. Acceptance remains open until its own evidence passes; this cleanup
checks off no additional deliverables and approves no code, runtime change or new contract.
Existing IDs remain stable. D33–D39 extract remaining obligations from the earlier combined items;
they do not add unrelated features or silently approve previously unresolved scope. The owner's
2026-10-22 compact Bound applications refinement is explicitly approved as D40, using existing Core
app-management contracts without a new Core/SDK/manifest or permission change.

| Work class | Deliverables | Boundary |
| --- | --- | --- |
| Remaining implementation using established contracts | D3–D6, D8, D10, D14, D18, D19, D38 | Completed foundations, seven runtime icons and existing screen layouts are not repeated. D4/D14 depend on D39; D18 depends on its role-data owner; D38 retains the scope decision below. |
| Contracts and dependent work | D15, D34–D37, D39 | Record timing, data, identity and authority semantics before dependent implementation; preserve explicit unavailable/refused states meanwhile. |
| Acceptance of implemented behavior | D7, D12, D13, D16, D17, D20–D30 | Verify the existing surfaces and their recovery/permission/device matrix. D17's cross-device part depends on D15; D23/D25 retain the limits owned by D36/D37. |
| Remaining design references | D32 | Prepare and review the missing variants; new page implementation requires concrete scope. |
| Implemented and verified baseline | D1, D2, D5, D9, D11, D31, D33, D40–D48 | Keep the recorded foundations, scoped SDK chrome, credential grid and compact bound-app refinement; broader functional, provider and device acceptance remains in its own deliverables. |

The remaining acceptance baseline includes Core-managed Shell embedding, normal password identity,
light/dark and narrow layouts, protected-flow recovery, real mobile keyboards and the required
provider workflows. Standalone screenshots, fixtures and local tests do not replace those gates.
The existing authorized live trial does not establish isolated sandbox acceptance.

## Accepted Refinements And Backlog Reconciliation (2026-10-23)

Keep the implemented refinements recorded in [feature.md](feature.md) and the owning Harness,
workspace lifecycle and Core development documents. They are constraints on the remaining work,
not new implementation tasks or evidence that whole-screen acceptance has passed:

- Keep flat, single-line session/external-workspace navigation, workspace hammers/names, right-side
  activity indicators and icon-only creation controls; no app grouping, idle subtitle or external task ID.
- Keep independent Changes/Tool calls disclosure, repository-only edit headings, bounded tool/command
  output, authoritative failure totals and single-line truncated sidebar branches. Generated branch
  naming has not changed.
- Keep the standalone full-width Changes screen with retained Back/Ask state and hidden composer
  when Core fences new turns. Reasoning-only changes retain context usage and native thread identity.
- Keep compact application state/target rows, exact-worktree switching, conditional short group
  actions and stable successful refreshes. D40's focused evidence does not replace a real per-app
  switch or wider provider/device acceptance under D20/D21/D26.
- Keep physical Delete/Discard semantics, stale-lease recovery without the old agent, honest pending
  versus refused/uncertain actions, separated destructive confirmation controls and animated loading.
- Keep direct Core workspace-to-workspace switching, same-target restart ownership continuity,
  original-baseline Return, factual success and understandable confirmation/progress. One metadata
  GET supplies the menu; reopening refreshes it, with recovery entries only when needed.

D41 resolves the linked-PR summary problem reported for #631, with display-only branch handling. It is separate from
D36's historical original-source review extension and does not authorize weaker mutation evidence.
Existing unchecked screen items still require their stated acceptance; the completed local/macOS
checks are not evidence for the full provider/mobile/platform matrix. Full SDK isolation and generic
Core/UI/provider contracts stay in their separately owned plans, with their existing approval status.

## Real GitHub Acceptance And Demo Adoption (Owner Direction, 2026-10-24)

The owner authorizes real-provider Harness acceptance on a separate disposable GitHub PR and
fixes for demonstrated problems. The test may create its own fixture branches and commits,
open a draft PR and exercise new review comments, replies and resolution. These test-only
operations do not authorize publishing or committing the aggregate redesign, merging the test PR,
copying provider credentials into another Core or changing unrelated live applications.

Demo App adoption is reopened under D4/D5/D6/D19: apply the approved shared web theme, local
fonts, app chart accents, navigation artwork and controls while preserving all existing SDK
identity, role, settings, panel/overlay and composition examples. Verify in a Core-managed child
with separate normal setup/login and data. Swift/native, Plans, Shell structure and Dashboard
remain frozen. Earlier Demo deferrals below describe the preceding batches only.

## Resumed Real GitHub Acceptance (Owner Direction, 2026-10-24)

The owner requests completion of the remaining Harness checks against a disposable real GitHub PR,
with Swift/native, Plans, Shell structure and Dashboard frozen. The owner separately approves
reopening draft PR #649 and closing it again without merge after the tests. Preserve all previous
acceptance evidence, existing selected GitHub credentials and exact workspace/source ownership.
Do not transfer an external workspace into an arbitrary conversation to enable Ask. A genuinely
Harness-owned fixture is required for enabled Ask acceptance. The owner also approves using Chrome
for embedded interaction checks and creating one additional Harness-owned disposable workspace/draft
PR, with one bounded test model request for synthetic README edits. Close that PR after acceptance,
without merge or publishing the aggregate redesign. Use ordinary Chrome sign-in; do not transfer
browser credentials from the in-app browser.


Source review identifies a fresh-authority gap in reply/resolution: local role/source binding can
change while provider reads are pending, but those commands do not repeat new-comment's admission
check immediately before mutation. Correct this race under D49 with isolated saved-state revocation
regressions and preserved durable command recovery. Ordinary GitHub connections, app grants and
operator roles are not revoked for live QA. D37's mixed-account source validation remains separately
tracked; this correction does not weaken its current explicit refusal. Apply any Core fix to the
ordinary instance only after exact-project builds/tests and separately authorized lifecycle action.

The resumed #649 browser checks confirm unsent comment text survives Close, Back, scope changes and a full reload,
and external-workspace Ask remains disabled. Explicit Close loses keyboard focus to the page body;
the scoped correction restores the New comment trigger only for dismissal, verified through the live UI, preserving confirmed-post
Ask focus and late-confirmation guards. A red regression reproduces the loss; 53 affected Harness
UI tests, targeted ESLint and web TypeScript pass. Harness advances 0.67.2 → 0.67.3; Core's separate
D49 correction advances 0.152.0 → 0.152.1. The tested Harness 0.67.3 static export is applied with its served HTML hash verified. Core 0.152.1 is applied after the owner's explicit restart consent, from the same registered project/data root with --keep-apps. The first detached replacement disappeared after its launch command ended; recovery keeps its launch session alive. Instance 3734:639284359092728250 is ready and five previously running apps remain running. The CLI's fresh isolated builds report four existing warnings; the earlier affected-test build reported none.

The new Harness-owned fixture exposes a Codex adapter defect: file-change approval parameters omit the proposal, which arrives in the preceding item event. Harness currently persists null changes and cannot show the exact patch. D50 retains scoped proposals before approval persistence; no wider authority or approval bypass is allowed. The particular pending fixture patch was independently verified as README-only from its own native rollout before any approval.

### Resumed Provider Evidence (2026-10-24)

The authorized bounded model turn creates draft PR #650 from its own registered Harness session
68fdc829-6815-45ea-8df0-6cfe2b008502 and tree a8eccefa9158befa69ff17223f3c9e957d069a67ce59112ebea1b5e0d96214da.
The public head 00b4ee4942bf9788819b7ed4cd1e669a8af3d6ec changes only README.md: two replacement hunks,
six additions/four deletions with 83 unchanged lines between locations. The fixture run stops idle
and releases its lease; no aggregate redesign is committed or published.

Normal Chrome Core sign-in and the Shell preview support actual embedded Harness controls after
Core replacement and reopening the app. A full Shell reload reproduces a blank embedded Harness frame; normal navigation to another app
and back restores the same authenticated session without another Core restart. Marketplace also
reaches silent sign-in staging or the explicit sign-in card, so this is not proven to be the Harness
review transport. Keep interrupted silent sign-in/frame reload recovery open under D21; no SDK
staging fix, browser-tool cause or permission bypass is claimed.

- PR #650: CI 22/22 (five passed, seventeen skipped); PR #649: CI 42/42 (ten passed, thirty-two skipped).
- Same-side LEFT 29–30 posts in Unified; RIGHT 29–31 posts in Split. Cross-side and cross-hunk
  posting is disabled with a clear reason. Both root comments and the single reply retain exact
  author/time/link metadata and appear once on GitHub.
- Back restores the review entry's focus. Viewed survives reopening. Unsent comment text survives
  Close, Back, scope changes and reload; reply text survives Close/reopening.
- Ask appends a structured mixed-side reference to existing conversation text, returns and focuses
  the composer without sending. Optional Ask after confirmed comment appends its thread reference
  to that same retained draft and does not start another model turn.
- Reply and both Resolve actions succeed through Core 0.152.1. Independent GitHub reads confirm
  two resolved threads, three comments and exact LEFT/RIGHT start/end coordinates.
- A reversible local-only README marker in the separately owned #649 tree is striped against its
  exact published head in Unified and Split; working coordinates cannot be posted. Its original
  bytes and clean tree are restored, HEAD is unchanged and the temporary lease is released.
- PRs #649 and #650 are closed without merge. Test source branches remain preserved.
- Closed PR refresh disables comment/reply actions while retaining readable resolved threads.
  GitHub's retained draft flag exposed two misleading labels: review scope and compact Publication.
  Both now prefer confirmed closed/merged state; open draft and outcome/release wording are preserved.
  Red regressions reproduce the cases; 74 related review tests and seven compact-workspace tests pass.
- The fixture owner's normal compact UI confirms an empty Uncommitted changes view and No active
  leases at the unchanged #650 head. External MCP ownership was not bypassed to inspect that tree.

D50 reproduces both the real missing-proposal protocol shape and late duplicate revival as red
tests. The final correction passes 66 affected tests, then all 1,483 final Harness tests across 144 files,
full Harness lint/TypeScript, the Next.js production export and version/diff checks. The final served
HTML SHA-256 matches the verified export; both corrected Closed labels are confirmed through Chrome. API listener and fixture idle state are
unchanged by source edits. The owner separately authorizes a Harness-only restart and one additional proposal-only model turn.
The new Harness API listener is 16146 (previously 78193), health is ready and the Core instance
3734:639284359092728250 remains unchanged. The real approval now shows the exact fixture README
path and unified A3 replacement hunk. Its durable receipt retains that same proposal before any
decision. The operator explicitly denies it; the model stops without tool execution, retries or
fallback writes. Worker exit is confirmed, the session returns idle and actual workspace leases
are empty. The owner's fresh Uncommitted changes view is empty; Git HEAD and the original README
A3 line remain unchanged. PR #650 remains closed/unmerged at its original head. This completes D50. D21–D25 retain their broader
historical-source, mixed-account, device and permission coverage; this scoped pass does not
silently close those umbrella gates.

## Marketplace And App Details Acceptance (Owner Direction, 2026-10-24)

The owner approves final acceptance of the implemented Marketplace and App Details under D28/D30,
including fixes for reproduced defects. Preserve Shell navigation/structure and Dashboard, native
apps/Swift and Plans. Keep current page layouts and supported capabilities; no new role, activity,
source, lifecycle or observation contract is authorized by this pass. Verify normal Core-managed
embedding and standalone entry, light/dark/narrow layouts, keyboard/focus, independent unsaved
forms, stale/error/expiry/revocation recovery and reviewed installation/configuration operations
with disposable users, catalog data, app data and folders. Do not copy ordinary provider credentials.

Investigate deferred Install discovery after authority loss, catalog-source conflict recovery,
App Details draft reconciliation, app-scoped secret reveal and late cancellation of protected
reviews. Reproduce each accepted finding before fixing it and retain separate save/read errors.
A stale response must neither reveal another app's value nor settle a newer review or clear a
newer draft. Existing server authority and Core confirmation remain required.

The ordinary Core was stopped at entry. The owner separately approves starting the same dev Core
from this registered worktree with `/Users/haas/.hosty`; its retained launch session is independent
of the disposable acceptance parent. This does not approve restarting ordinary Shell/Marketplace,
changing their source or applying the eventual candidate to ordinary data without review.

The accepted candidate is Shell 0.112.1 and Marketplace 0.12.2 with unchanged SDK 0.34.1.
Both production Docker builds run in the same source child Core after normal reviewed updates,
with normal administrator and invited ordinary-user password login. Native Chrome checks cover
Core-managed embedding and standalone Marketplace, real public Solitaire 0.3.1 installation left
stopped, authoritative Installed metadata and legacy Manage migration. Slow, unavailable, invalid
and private-feed fixtures retain source-adjacent Settings and factual installed-app information.
The real source-conflict flow preserves the draft through explicit reload and subsequent Save.
Light/dark 400-to-1200-to-400 responsive checks retain the selected app and public main feed.
Public feeds in this pass expose only main; the nondefault-feed handoff is component-tested.

The baseline reproduces an unsaved parameter being overwritten by an unrelated SSE update. The
candidate retains that draft while refreshing the pristine field, saves only explicitly, clears the
accepted artificial-secret draft, and requires manual restart. Native Folders Cancel/Retry/Approve,
Network endpoint facts, permission review and source/account refusal, Updates failure, Logs deep
link/Refresh and keyboard section navigation pass. Ordinary-user Logs has a Home breadcrumb,
Core's administrator-only read refusal and no management controls; Marketplace denies access.
Backup creation includes only primary data, excludes the attached fixture folder and resumes the
app. Stop/Restore creates a pre-restore backup, restores the original marker digest and leaves the
external marker unchanged; explicit Start recovers readiness. Cleanup preview and Delete/Cancel
remain reachable, with keyboard focus returning to the opener.

Revoking only the disposable browser credential cascades to its Shell/Marketplace grants. A later
settings Save displays the normal sign-in boundary; password reauthentication returns to the same
unsaved URL. An independent read confirms the saved catalog did not change, so recovery does not
replay the mutation. Deferred/closed-response races, stale secret reads, approved-versus-succeeded
cancellation and prior-app callbacks have focused regression tests rather than timing-dependent
native claims. Full suites pass: Shell 206 Node tests plus 716 component tests; Marketplace 157
tests. TypeScript and production builds pass; Shell lint retains three existing warnings and no
errors, Marketplace lint is clean. Independent review's readonly Network fallback regression is
fixed and included in the final build. Version and documentation checks pass.

Owner Finish confirms removal of the child, its Docker containers/networks/volumes, private test
data and credentials, parent process and reserved ports. Ordinary Core remains on the approved
dev project and data root; ordinary Shell/Marketplace are not restarted by this acceptance. The
registered source workspace and its active consumers are retained. D28/D30 are complete; physical
mobile and measured accessibility remain with D26/D16, and no provider credentials, release update,
new resource/backup contract, native/Plans work or frozen Shell/Dashboard structure is included.

## Working Application And Visual Polish (Owner Direction, 2026-10-24)

The owner authorizes applying the verified Shell 0.112.1 and Marketplace 0.12.2 source candidates
on their existing ordinary-data Hosty redesign selections. Keep their data, settings, automatic
startup, installed-package baseline and Return path; neither a release publication nor a Core
restart is part of this application. The earlier isolated acceptance remains the prerequisite.

Continue D6/D10/D19 only in app-owned Harness and Telemetry controls: distinguish preview working
and failure shapes, show initial tool-catalog discovery, use failure severity for unavailable
queries, and keep retained results' source/query provenance visible while filters change. Reproduce
concrete defects and preserve caches, drafts, authorization and existing refresh behavior. Shared
Core/SDK contracts, new polling, native/Swift and Plans, Shell structure and Dashboard are excluded.
This scoped pass does not close the broader remaining implementation or device/contrast gates.

## Harness Connection And Identity Recovery (Owner Direction, 2026-10-24)

The owner approves completing the focused connection-loss, expired-login and explicit Retry matrix,
including fixes for reproduced bugs. Preserve composer text, pending/uploaded attachments, selected
conversation and review drafts. Recovery refreshes authenticated reads and resumes the durable event
cursor; it never replays a message, approval or GitHub write automatically. An uncertain message send
retains one explicit request identity and its immutable content until server evidence settles it.
Reusing that identity with different content is refused; a fresh intentional message is distinct.

Verify transient transport failure separately from recoverable 401, terminal 403 and confirmed
session deletion. Exercise ordinary password authentication in a new Core-managed test child with
separate data, no copied provider credentials and no ordinary-instance auth revocation. Keep the
browser debugger detached for native reload checks. Swift, Plans, Shell navigation/structure and
Dashboard remain frozen. This batch owns D51; D21's broader provider/device gates remain separate.

## Embedded Harness Reload Verification (2026-10-24)

The owner requested a focused investigation of an empty Harness iframe after a full Shell reload,
without changes to Swift, Plans, Shell navigation/structure or Dashboard. With browser automation
attached, the live trial reproduced an initial `about:blank` child and a pending document navigation.
Native Chrome controls exposed the same empty state. Disconnecting the browser debugging attachment
immediately released the pending navigation with source, authentication and session unchanged.
Three subsequent native toolbar reloads and one hard reload loaded Harness, its three sessions,
the selected conversation and the retained unsent draft. No app or Core restart was needed.

This establishes an automation-dependent navigation stall in this observed case; the exact debugger
mechanism is unverified. Initial-source timing, eager loading, source reassignment and bounded frame
recreation experiments did not recover the attached-debugger case and were removed byte-for-byte.
No application-code workaround ships. Future browser acceptance compares a stalled automation frame
with a native-only reload before treating it as a product defect. D21 remains open for the broader
provider, recovery, authority and device matrix; this result does not complete isolated acceptance.

## Empty Workspace Preview Section (Owner Refinement, 2026-10-24)

The owner requests no empty Previews section in workspace details. A successful inventory with
no retained child environments or non-disposed app sandboxes renders no section or heading.
The component remains subscribed to its existing observations, so a later preview reappears.
Initial loading and read errors retain their visible status and retry. The existing focused
workspace preview/detail suites pass 55 tests, Harness lint/types and the static production build
pass, and the export is applied to the authorized live Harness trial. No Core change is needed
for this presentation refinement. Broader D10/D21/D27 acceptance remains separate.

## Harness Review Recovery Regression (2026-10-24)

The separate real-GitHub fixture is draft PR #649 on its own registered workspace/branch and
contains only a synthetic README marker. It is not the redesign publication. Core unit regressions
reproduce definitive stale-head reply and resolution failures against the old implementation.
The fix returns each already-persisted failed receipt instead of turning that known rejection into
an uncertain browser outcome. Source/account/owner and fingerprint admission checks remain;
unknown remote results retain the original request and block competing commands.

The focused Core review/comment suite passes 36 tests, the provider subset passes 15 and the HTTP
authority case passes. Harness review-action/thread coverage passes 22 tests. The exact Core project
builds in an isolated artifacts directory with zero warnings/errors, and independent source review
finds no blocker. The owner authorizes applying the fix to the existing dev Core with `--keep-apps`.
The final managed generation builds with zero errors and four existing compiler/platform warnings.
Recovery starts the expected redesign project under a new process identity, with the five live local
service trees retained. The replacement reports the expected dev project and no pending restart.

Real GitHub acceptance on draft [PR #649](https://github.com/alex-de-haas/docker-host/pull/649)
confirms a published RIGHT-line comment, author/time/link metadata, a reply and explicit resolution.
Advancing only the disposable fixture branch rejects a reply and resolution from the old head;
the reply body stays editable, no remote mutation occurs, and refreshing the comparison permits
a new explicit command. Independent GitHub reads confirm exactly one comment, one reply and a
resolved thread. Published head/base, thread totals and Unified/Split rendering agree with GitHub.
This scoped pass does not complete the broader embedding, revocation and recovery matrix in D21-D25.

A separate fixture proves that identity readiness waits on an unrelated conversation credential
queue. Harness now coalesces background refresh per actor, retries failed sessions on later probes,
and retains synchronous admission for the explicitly selected conversation. The old regression fails;
63 focused gateway/recovery tests and the final 1,392-test Harness suite pass, as does API TypeScript.
This is an independently verified stall path, not an attribution of every earlier live valid-cookie
hang. After Core recovery, a fresh standalone Harness tab loads the workspace and real provider
review successfully. A separate Shell-embedded probe displays host-identity connection recovery;
its cause is investigated independently instead of treating standalone success as embedding evidence.

This provider pass also reproduces two presentation defects. CI availability incorrectly uses
publication completion, so a draft's five successful and sixteen skipped checks report unknown.
The header now follows check evidence independently; failed, pending, skipped-only, stale and
unknown safeguards remain. Four affected suites pass 28 tests. Viewed marks disappear after Back;
tab-local, authenticated-viewer/source-scoped progress fixes remount loss without marking changed
revisions as reviewed. Its two affected suites pass 41 tests, including storage failure and isolation.
Both fixes pass ESLint/TypeScript and the combined Next.js 16.4.1 production export is applied to
the authorized live Harness trial. The final complete Harness suite passes 1,406 tests across 142
files after both fixes. Final browser checks confirm CI passed with five successful/sixteen skipped
checks, retained Viewed after Back/reopening the same published comparison, disabled mutations on
the closed PR and no empty Previews section. The disposable PR is closed without merge, its test
activity lease is released, and its clean worktree/branch remain available for inspection. The
redesign workspace's lease remains with its active source consumers.

The final browser pass catches an export-selection mistake in the live application step: Next.js
16.4.1 writes this custom static export to the `outDirectory` in `.next/export-detail.json`, not
necessarily `out`. The successful current candidate is applied from that recorded destination;
served development HTML matches its exact digest and references the current chunk. Earlier live
observations against the stale `out` export are not evidence for the final implementation.

Read-only diagnostic identity probes confirm session readiness and embedded bootstrap with the
exact Shell parent origin return 200 in 4-15 ms. They do not validate the existing browser grant.
A single normally authenticated Shell iframe renders the current Harness conversation and workspace
successfully. Frame-scoped locators find its controls, but both keyboard and click actions fail in
the browser bridge; this limits interaction evidence rather than proving an app-control defect.
The earlier concurrent standalone/embedded probe shows connection failures and pending navigation;
closing the second view and using normal Retry restores the standalone view. The six observed browser
sockets alone do not identify active requests or prove the failure cause. The later isolated D48
regression reproduces a fourth-view navigation timeout and verifies the corrected browser event
transport with eight concurrent conversations. D21/D24 retain their broader provider, interaction,
revocation and recovery acceptance; no actor, origin, credential or authority checks are bypassed.

## Harness Concurrent Views Recovery (Owner Direction, 2026-10-24)

The owner explicitly authorizes diagnosis and correction of Harness hangs with multiple open tabs.
Swift/native, Plans, Shell structure and Dashboard remain frozen. Preserve separate app/user
credentials, current authority checks, session drafts and durable event replay. Do not share one
view's credentials with another view or treat a connection-count observation as proof of a leak.

Source review identifies a session SSE that remains open in hidden documents and lacks explicit
reader cleanup. A deterministic held-subscription probe separately reproduces server subscription
and heartbeat retention when the response closes before subscription admission completes. Pausing
hidden-document streams and disposing late subscriptions fixes those defects, but isolated browser
acceptance still reproduces a fourth-view navigation timeout with two standalone conversations and
one embedded conversation. Those documents all report visible; backend probes with eight open
streams still complete finite reads in 2–30 ms. The reproduced browser stall clears when the other
views close, establishing that visibility cleanup alone does not complete this deliverable.

The scoped correction carries browser event frames over same-origin WebSockets instead of retaining
HTTP/1 event responses. A short-lived, single-use ticket is minted through each view's existing
authenticated app transport and revalidated at upgrade. No app credential is placed in a URL or
shared between documents. Preserve the durable cursor, workspace invalidations, expiry, revocation,
origin checks, bounded buffering and disconnect cleanup. Keep legacy SSE for direct clients;
unsupported WebSocket transport must remain explicitly unavailable rather than silently recreating
HTTP connection starvation. D48 owns implementation and the concurrent-view regression; D21/D24
retain their wider acceptance matrix.

The verified D48 candidate passes all 1,460 Harness tests, complete Harness ESLint/TypeScript and
the Next.js production export. An isolated Core-managed child with normal password sign-in runs
six standalone conversations and two Shell-embedded conversations concurrently. All eight receive
an additional app-context event without reload; standalone/embedded reload, tab closure and a fresh
replacement view remain responsive, with the draft retained. A separate authenticated probe keeps
eight session and four workspace sockets open while identity/list/runtime/workspace reads complete
in 3–4 ms, and verifies missed-event replay and authority refusals. No provider credentials are copied
and no model turn is sent. Frozen Swift/native, Plans, Shell structure and Dashboard files remain
unchanged. This completes the scoped concurrency regression, not the wider D21/D24 acceptance. The
verified static export is applied to the already authorized dev Harness; its served HTML and event
transport chunk match the candidate, and the existing operator conversation renders normally.
The child is finished through its owner and its containers, networks, volumes, root, test credentials,
image tags and ports are removed; the private test parent is stopped. The primary Core process,
registered source and live activity lease remain intact.



## Verified Demo Web Adoption (2026-10-24)

Demo App adopts the shared local fonts, light/dark theme, lime controls, magenta chart lead,
neutral external navigation icons, semantic status shapes and labelled loading/error/empty states.
All existing page routes and SDK identity/roles/settings/panel/composition examples remain.
Role saves preserve unrelated users' drafts; a refused update retains its attempted selection.
The independent Demo artifact changes from 0.17.3 to 0.18.0, including its runtime image declarations,
Docker build argument, fallback config and root workspace lock metadata. Next.js declarations are
unchanged by this adoption.

Verification passes ten Demo tests, ESLint, TypeScript, native Turbopack and webpack production
builds, and the final Docker image. Both actual service containers use the verified final image.
A Core-managed source child uses separate normal setup/password login, accounts and data.
Core Open/PKCE and SDK app identity, admin/viewer permissions, invalid role refusal, assignment
revocation and fresh sign-in recovery pass ten API checks. Browser checks confirm Shell embedding
and standalone pages, actual IBM Plex Sans, dark/light colors, People, Roles, Settings, keyboard
Radix selection, Save/Reset and protected JSON inspection. A settled 480 px standalone view has
480 px document/scroll width in both themes and no console errors. These are desktop viewport
checks, not physical mobile-device acceptance. Embedded interaction automation is limited by the
browser bridge; embedded rendering and standalone interactions are recorded separately.

The composition fixture truthfully reports unavailable optional panel access in this child. No new
optional access was granted, and retained two-view tool composition is not claimed by this pass.
D4/D6/D19 remain open for their other consumers and acceptance obligations; D5's Demo/Telemetry
external navigation artwork is verified. Swift/native, Plans and frozen Shell/Dashboard source stay
unchanged. No aggregate redesign commit or publication is authorized by this verification.

A final independent review finds and fixes clean-row reconciliation: a concurrently changed clean
role row adopts the returned server assignment, while a genuinely edited unrelated draft remains.
The old behavior fails its regression; the final ten-test suite, lint, TypeScript, webpack build
and version checks pass. Docker/browser evidence above precedes this final role-logic fix; it is
not attributed to a rebuilt final image. Owner Finish removes the child root, labelled Docker
resources and private credentials; the owned parent stops and all five allocated ports close.

## Current Batch Scope (Owner Direction, 2026-10-23)

The owner accepted the current Dashboard and Shell navigation/structure and requested a checkpoint
before more implementation. Commit `5b7349fe` preserves those refinements. Do not redesign Dashboard,
change Shell navigation, or alter route/layout ownership in this batch. Internal content of existing
settings tabs may be completed; Tokens & devices (D9) is the concrete settings scope.

Start with all SDK-owned web chrome under D31, then complete Telemetry's theme, chart, control,
navigation-icon and loading/empty-state adoption under D4/D5/D6/D19. Keep SDK styling scoped to its
own controls; the SDK style-isolation Draft does not select a new composition architecture. Preserve
app-owned styles, authentication, retained frames/drafts and existing installation/recovery behavior.

All native applications, including Swift, are deferred. Plans and Demo App adoption is deferred
because their products will be reconsidered separately. Their obligations in D3/D4/D5/D19 remain
unchecked and are not part of this implementation batch. Other unresolved contracts, missing design
references and broad device/provider acceptance remain with their existing deliverables; narrowing
this batch does not complete or retire them. D8 is frozen with Dashboard pending another owner
request. No publication, push or additional commit is implied by the checkpoint permission.

The owner subsequently approved Host settings content refinement as D42: use Core information as
the visual reference for Updates, Network, Shared folders and Core source while keeping the accepted
navigation and all existing operations. This does not reopen Dashboard or expand Core lifecycle.

The owner also approved D43: align Background app access with the Tokens & devices table and
move the existing account-wide revocation action to the top of the personal tab. Its administrator
restriction, own-account scope and protected Core confirmation remain unchanged.

The owner approves D44 as a Shell-wide form-control consistency pass: replace remaining visible
native selects and bespoke inputs with the existing shadcn/Radix primitives used alongside ReUI
frames. Preserve values, labels, drafts, disabled states, submission and authority; Dashboard
structure and navigation stay unchanged.

The owner approves D45: remove the Apps overview and its sidebar catalog links. An ordinary user's
unselected home renders no central page and retains accessible app rows; administrators keep Dashboard.
Retired `/apps` links resolve to the role-appropriate home. The phone Apps control opens only the
app sidebar. Personal profile/token access and existing embedded-app authorization stay unchanged.

The owner approves D46: use one primary contextual action for application and Core rows. Pending
operations remain guarded; Restart required takes precedence over diagnostics, configuration and
update offers, followed by factual runtime-health Logs and normal controls. Core uses the same title
badge and gains an administrator/CSRF-protected, instance-bound light-stop request that preserves
running apps. Stopping explains that the host CLI is required to start Core again. No lifecycle
operation on the operator's Core is part of this implementation or verification.

### Harness And Web Polish Batch (Owner Direction, 2026-10-23)

The owner approves D41 first, Harness filter/status/control and truthful loader/empty-state
refinements under D33/D6/D19/D10, then the remaining web branding portion of D3. Keep the
checkpoint and every accepted refinement. Swift/native assets, Plans and Demo App remain deferred;
Shell and Dashboard structure stay frozen. Read-only external PR metadata may use the bound PR's
actual branch, while review, merge, completion and source cleanup retain exact-workspace evidence.
Contract-dependent activity, timing, missing observations and historical/mixed-account review work
remain separately scoped under D15/D34–D39. This batch does not implicitly approve those contracts.

### Framework Patch And Remaining Web Polish (Owner Direction, 2026-10-23)

The owner approves Next.js 16.4.1 and matching ESLint tooling for Harness, Shell, Marketplace
and Telemetry UI before further remaining visual work. Preserve the existing React/ReactDOM
versions and declarations, frozen native/Swift/Plans/Demo sources, Shell navigation/structure
and Dashboard structure. Shared compatible lock resolution is not a redesign of frozen apps.
After the four builds pass, resume bounded D6/D10/D19 presentation fixes and their existing
acceptance gates; contract-dependent work remains separately reviewed under D15/D34–D39.

### Verified Bounded Visual Acceptance (2026-10-23)

The owner-approved Harness/Telemetry pass fixes demonstrated residuals under D6/D10/D19. Harness
uses destructive foregrounds for error text/icons and app-local reduced-motion transitions;
Jump to latest follows the live motion preference with hydration-safe instant scrolling. Telemetry
separates filtered no-match responses, strengthens row chevrons/light amber and waterfall labels,
and transfers/restores trace keyboard focus without losing filters or stealing focus on refresh.

- Harness: 1,387 tests in 142 files, full lint/TypeScript, isolated native export and final Docker build pass. Actual primitive scrolling tests cover live reduced motion, caller cancellation, retained draft, subscription cleanup and SSR hydration.
- Telemetry: 32 tests in five files, lint/TypeScript, isolated native build and final Docker build pass. Tests cover search/error/whitespace priority, Enter/Space focus transfer and return, refresh without focus theft and missing-row fallback.
- A retained Core-managed child uses normal password identity and separate test data. Shell embedding and Core Open authenticate. Final images are healthy; browser checks confirm real local validation, dialog/menu Escape and retained input, filtered no-match responses and trace Enter/Back with the original query. A synthetic near-end 1 ms span retains its bar and readable duration. Harness's settled 480 px dialog fits without page overflow; Telemetry's final desktop light/dark states are verified. The viewport control did not resize the existing Telemetry tab, so no new narrow Telemetry result is inferred from that attempt.
- Measured actual color pairs: Harness errors 6.53:1 light / 7.39:1 dark; Telemetry row chevrons 5.50:1 / 6.00:1, light amber mark 5.02:1, and inside duration labels 17.28:1 / 14.06:1. Shared tokens, all Shell/Dashboard and deferred native/Plans/Demo source hashes remain unchanged. Independent source review finds no blocker.
- Owner Finish confirms child data-root and labelled container/network/volume removal; the task parent stops and all five preview ports close. Private test data/credentials are removed. The registered live workspace and activity lease are retained. The verified Harness export is applied to its existing authorized live app and its served providers HTML matches the exact build digest; the operator Telemetry remains stopped. No Core restart, commit or publication occurs.
- Full OS-level reduced-motion switching, grayscale/assistive technology, real mobile keyboards and provider mutation acceptance remain open. The live media/scroll behavior is covered by component tests; the browser keeps its existing OS preference. D16 retains the explicit lime-focus contrast decision; these scoped results do not close broad conformance gates or approve D15/D34–D39 contracts.

### Verified Harness And Telemetry Polish (2026-10-23)

The owner's further bounded D6/D10/D19 pass preserves Swift/native, Plans, Demo and all
Shell/Dashboard source. The checkpoint, prior refinements and independent artifact version outcomes
are retained. No new backend contract, commit or publication is included.

Harness runtime discovery distinguishes pending reads, failed first reads and last-confirmed worker
observations. Credential recovery uses the shared destructive Alert and focused Retry without draft
loss; embedded workspace file controls use shared wrapping Buttons. Telemetry resource controls and
full technical attribute keys/values wrap, including multiline values and stacked phone attribute
rows. Metric search reports no matches only for a nonempty filter and a populated selectable catalog;
pinned infrastructure, selected charts and stored choices remain intact.

- `npm run harness:test`: 1,385 tests in 141 files pass, including two new failure/recovery/draft regressions. `npm run harness:lint`, focused ESLint and web TypeScript checks pass. A first lint run scans the generated alternate export; moving that verification output outside source restores the full source gate without lint-rule changes.
- `npm run telemetry-ui:test`: 28 tests in five files pass, including three search/selection/catalog cases. `npm run telemetry-ui:lint` and TypeScript checks pass. Search cases preserve pinned infrastructure and selected charts through a missing/whitespace query and avoid false no-match states for empty or pinned-only catalogs.
- `HOSTY_HARNESS_WEB_OUTPUT=out-build-polish npm run harness:build-web` and `NEXT_DIST_DIR=.next/verify-polish npm run telemetry-ui:build` pass. Exact final production Docker builds pass for both apps; generated verification outputs/type paths are removed/restored. Existing version bumps remain with the aggregate uncommitted redesign batch.
- Independent source review finds no blocker. Browser QA finds and fixes a genuine intermediate-width Metrics header defect: a long resource label reduces the heading to zero at 680 px. The final header wraps its actions and reserves a preferred title width; repeated 680/480 px measurements retain the heading and produce no page/header overflow. Both final native/Docker builds and Telemetry checks pass after that correction.
- A Core-managed child with separate normal password setup runs Shell, Harness API/Worker and Telemetry collector/backend/UI. Ordinary Shell embedding and Core Open authenticate; Harness worker discovery/Refresh succeeds. Synthetic logs, traces and a selectable metric enter only that child's owned loopback collector. Full long keys/multiline values and metric search/selection are verified at 480 px; the existing log table retains horizontal scrolling for wide source labels. Light/dark and desktop/680/480 layouts pass. Test-only long app naming changes no product manifest.
- Cleanup: owner Finish confirms child data-root and labelled container/network/volume removal. The task parent stops, all five preview ports close, and private test credentials/data plus six test image tags are removed. The live workspace and its lease are retained.
- The final Harness export is applied to the already authorized live workspace and its served providers-page HTML matches the exact build digest. No Core restart, ordinary app configuration or Shell/Dashboard source change occurs. Telemetry's final image is verified in the child; the operator's stopped Telemetry is not switched to a live-data trial by this batch.

These scoped results do not complete the umbrella deliverables. Real provider credential-loss/review
workflows, real mobile keyboards, full contrast/reduced-motion/device acceptance and D15/D34–D39
contracts remain with their existing unchecked deliverables. Browser iframe controls are not reliable
in this automation, so interactive checks use normal Core Open after confirming embedding; no wider
embedded-control acceptance is inferred.

### Verified Framework Patch And Web States (2026-10-23)

D47 is verified for Harness web, Shell, Marketplace and Telemetry UI: exact Next.js and
`eslint-config-next` 16.4.1, unchanged React/ReactDOM declarations and resolutions. Initial npm
resolution attempts fail on the existing React/ReactDOM range mismatch; no force/legacy-peer
flags or React changes are used. The narrowly migrated lockfile passes a clean isolated
`npm ci --ignore-scripts --no-audit --no-fund`, a complete `npm ls` dependency check and all four
Docker installs/builds. Plans/Demo workspace declarations and their exact lint tooling are retained.
Marketplace advances 0.12.0 to 0.12.1, including its first-party image tag; the other previously
updated artifact versions remain intact. No additional commit, push or publication is made.

The bounded D6/D10/D19 continuation adds honest workspace-inventory, preview-recipe,
diff-highlighter and sandbox-action progress in Harness. Telemetry distinguishes initial/debounced
loading, failed first reads, confirmed empty and transient refresh failures. Shared folders keeps
its accepted Frame/table/actions while making first/transient/authority failures and Retry factual.
Actor/Core changes clear protected data/editor drafts. Three new regression cases reproduce and
fix stale full-refresh invalidation and save/delete receipts arriving after another refresh; the
independent review confirms both findings resolved. These scoped refinements do not complete the
umbrella deliverables or approve their outstanding data contracts.

- Production builds: `NEXT_DIST_DIR=.next/verify-next1641 npm run shell:build`, `HOSTY_HARNESS_WEB_OUTPUT=out-build-next1641 npm run harness:build-web`, `NEXT_DIST_DIR=.next/verify-next1641 npm run marketplace:build`, and `NEXT_DIST_DIR=.next/verify-next1641 npm run telemetry-ui:build` all pass on 16.4.1. After subsequent UI edits, the final native Shell/Harness exports and exact final Shell/Harness/Telemetry production Docker builds also pass. Separate verification outputs are removed; generated TypeScript path changes are restored. The earlier 16.4.0 security-notice result below is historical, not the current build outcome.
- Tests: `npm run harness:test` passes 1,383 tests in 141 files; `npm run shell:test` passes 688 component tests in 63 files and the existing Node suites; `npm run marketplace:test` passes 152 tests in 18 files; `npm run telemetry-ui:test` passes 25 tests in five files; `npm run sdk:test` passes 686 tests in 35 files. Affected lint and TypeScript checks pass with zero errors; Shell retains three existing navigation warnings. No frozen navigation changes are made to silence them.
- Managed integration: one owned source child with isolated normal password setup runs all seven services of Shell, Harness, Marketplace and Telemetry from the verified Docker images. Normal Core/Shell identity, app embedding, anonymous API denial, actual child telemetry metrics, light/dark presentation and a 480 px breakpoint pass. Core Open verifies standalone selectors, installed-app roster and empty log/trace results without copying provider credentials or installing frozen apps.
- Recovery/resources: the first default child refuses the third app at its declared application capacity. Its owner Finish removes its root and labelled resources; the replacement declares 8 GiB/4 CPU for the four-app test within the existing pool. Final owner Finish removes the replacement root, containers, networks and volumes; its parent stops, all six preview ports close, and task credentials, temporary dependency copies and eight image tags are removed. Operator data and its live workspace lease are retained.
- Authorized live review: the exact final Harness static export is served with a matching HTML digest. Shell and Marketplace restart through the existing local app lifecycle from the same registered workspace, log 16.4.1 and become healthy. The operator Core retains PID 25546 and its source generation; unrelated apps and source selection are unchanged. Telemetry is verified in the child and remains stopped on the operator Core.
- Scope/limits: source hashes preserve Swift/native, Plans, Demo, Dashboard, navigation and layout. The sole frozen-route-file difference is settings-only mount-status prop plumbing, with no route/structure change. Iframe control automation cannot reliably target embedded controls, so interactive checks use normal Core Open after confirming embedding. Real mobile keyboards, full reduced-motion/contrast/provider matrices and the absent live #631 card remain open in their existing acceptance deliverables. No CI/PR run or cross-platform acceptance is claimed.

### Verified Harness And Web Polish (2026-10-23)

D41 uses a dedicated display-only provider observation for linked PRs from another branch.
Selected-account, owner, repository, canonical URL, head-repository and target checks remain;
fresh and legacy metadata strip completion/review-body evidence. Strict review, merge, completion
and cleanup checks still refuse another source branch. GitHub's read-only metadata confirms #631
is accessible and merged; provider fixtures cover that exact title/number and branch mismatch.

D33 passes mixed-state count/search/order coverage. Harness's share of D6/D10/D19 also includes
semantic approval/answer selection, labelled inventory/provider/roster/request loading, honest
empty/unavailable states, shared form controls and reduced-motion-safe indicators. Those combined
deliverables remain open for their other consumers and broader acceptance. D3's web source/assets
and outlined wordmark are generated and visually inspected; native outputs remain deferred.

- Core: `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path /tmp/hosty-d41-pr-metadata-artifacts --filter 'FullyQualifiedName~Publication|FullyQualifiedName~WorkspaceInspection' --nologo --verbosity minimal` passes 189 tests, with no skips. The exact final Core project build passes with zero errors/warnings.
- Harness: `npm run harness:test` passes 1,377 tests in 141 files; `npm run harness:lint` and the production Docker build pass. Existing control suites cover exact source/provider IDs, empty/unknown selections, stale diff replies, confirmation identity, retention drafts/payloads and handoff refusal/retry.
- Native Harness export: `HOSTY_HARNESS_WEB_OUTPUT=.next npx --no-install next build` from `apps/harness/web` compiles, type-checks and exports all nine routes. The initial attempt exits 1 after export with a Next.js security notice; the exact retry completes with exit 0, with the original notice retained in the build log. Next.js remains 16.4.0; no dependency or security-check changes are included. This records successful build/export separately from the production Docker build.
- SDK: `npm run build --workspace @hosty-sdk/app` and `npm run sdk:test` pass, including 686 tests after canonical geometry extraction.
- Shell: four existing affected settings/control suites pass 26 tests; `npm run shell:lint` passes with three existing navigation warnings and zero errors; the production Docker build passes. The only new Shell source change is its shared selected-field token; structure/navigation/Dashboard are unchanged.
- `node assets/hosty-brand/build-assets.mjs --web-only` produces valid SVG/PNG/ICO assets; lockups contain outlined glyphs and no live text. The SDK build includes the geometry module. Native/Plans/Demo paths have no changes from this batch.

Core-managed browser verification uses a disposable parent/source child Core, normal setup/password
login and independently built Docker Harness/Shell. It preserves the child account/session across
the reviewed final image update. Core/Shell embedding and standalone Core Open are checked in
light/dark and a 480 px desktop viewport. The browser's iframe input bridge cannot dispatch clicks;
standalone Core Open and existing flow tests verify interactions instead. This is not actual
iOS/Android, a full reduced-motion/contrast audit or real provider-mutation acceptance. No parent
provider credentials or ordinary app data are copied. D12–D30 keep their broader acceptance gates.

The parent confirms Finish for this managed QA child. Its data root and owned Docker resources
and preview listeners are removed; the dedicated parent process and its ports are stopped.
Disposable fixture credentials and private test secrets are removed. The registered redesign
workspace and its retained activity lease remain because the operator Core/apps still consume them.

The owner-authorized operator application runs Core 0.152.0 from the same registered redesign
project and data root, with a new process/start identity. The background CLI replacement does not
remain alive after its tool session; the supported foreground CLI restores the same source target.
Its prepared-generation build has zero errors and four existing warnings. Five local service
process trees are adopted and the existing Workspaces Docker service remains running; the same
five applications are ready afterward. The operator Harness serves the successfully built static
export, verified against its HTML digest. The original workspace containing #631 is absent from
the current external-workspace list, so its actual live card is not reproduced; D22 keeps that
provider-card acceptance separate from D41's passing display/authorization regressions.

Versions remain Platform 0.151.0 → 0.152.0, Shell 0.111.0 → 0.112.0 and SDK 0.33.1 → 0.34.0
with their existing uncommitted batch. Harness advances 0.67.0 → 0.67.1, including both service
images and worker/package lock sources. No additional commit, push or publication is implied.

### Verified Web Batch (2026-10-23)

D9 and D31 pass their scoped implementation checks. The independent artifact versions are
SDK `0.33.1 → 0.34.0`, Shell `0.111.0 → 0.112.0` and Telemetry `0.15.2 → 0.16.0`.
During this earlier SDK/Telemetry/credential sub-batch, Dashboard and Shell navigation remained
unchanged after the checkpoint; later D45/D46 refinements are recorded separately. Native/Plans/Demo
sources remain deferred. Telemetry adoption completes this sub-batch's share of D4/D5/D6/D19; those combined deliverables
remain unchecked because their other consumers and acceptance obligations remain open.

- `npm test --workspace @hosty-sdk/app`: 686 tests in 35 files pass. The SDK build and
  `node packages/app-sdk/scripts/check-overlay-upgrade.mjs` pass, including an unchanged
  published consumer and a separately bundled browser hydration fixture. SSR contains no
  machine-local font paths; hydration retains app input, reports no hydration error and owns
  one replay-safe font sheet with six browser font URLs.
- `npm test --workspace @haas/hosty-shell`: 201 Node tests and 570 component tests pass.
  Scoped lint, TypeScript and the final production Docker build pass. The grid covers actor
  changes, failed reads, rename drafts, pagination/selection and protected sequential bulk
  recovery, including distinct OAuth client IDs with the same display name.
- Telemetry's 15 tests, lint, TypeScript and production builds pass. Final chart layout and
  navigation assets retain readable labels and icons in both adopted themes. Marketplace's
  existing 152 component tests and its production image build pass against the new SDK.
- A disposable parent-managed source Core with normal password setup/login runs Docker Shell,
  Telemetry and Marketplace against isolated data. Actual Shell and Marketplace SDK chrome use
  emitted font URLs. Shell installation of a local fixture with automatic startup disabled
  completes as Installed/Stopped; Marketplace's supplied-source request supports Core Cancel,
  the SDK cancelled result and return to the catalog. A missing manifest exposes a bounded error
  and Change source retains the supplied path. A real connection interruption recovers with Retry.
- Tokens & devices is checked at desktop and 390 px: search, sort, page changes, selection,
  column controls and Core revocation review retain their existing destination and authority.
  Cancelling bulk review confirms zero revocations and keeps the remaining selection. The
  640 px table scrolls inside its container without page overflow at 390 px. No browser
  credential revocation is claimed; protected mutation outcomes are covered by component tests.
- Embedded Telemetry renders actual Core/container metrics and a disposable OTLP log and trace
  roster in light/dark and 390 px views. These checks do not claim every provider workflow,
  mobile software keyboard, screen-reader, device rotation or full grayscale/contrast matrix;
  those remain in D12/D13/D16/D20 and the relevant acceptance deliverables.

The owning parent Core confirms Finish. The child data root, owned Docker containers/networks/volumes,
preview listeners and parent process are gone; disposable credentials are removed. The operator Core
remains running from the registered Hosty redesign worktree, with existing app runtime states preserved.

No named `test:integration` suite targets SDK or settings presentation: the repository runner
covers activation, transport, worker, Windows and Whisper. The managed browser exercise above
is this batch's integration check; unrelated lifecycle suites are not represented as executed.

### Contextual Lifecycle Verification (2026-10-23)

D46 passes its implementation and isolated verification. Platform version changes from
`0.151.0` to `0.152.0`, including the main channel copy; Shell remains in the existing
`0.111.0 → 0.112.0` batch. No operator Core lifecycle, commit or publication is performed.

- `npm test --workspace @haas/hosty-shell`: 206 Node and 674 component tests pass (880 total).
  Final TypeScript, scoped ESLint and the final production Docker build pass. Coverage includes
  one primary action, Restart before setup/update/runtime diagnostics, factual health-only Logs,
  ordinary-user guards, pending/queued/duplicate/retry behavior, Core title badge and narrow More
  access. Core's metadata Update action is also disabled while Stop is accepted or unconfirmed.
- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path
  /tmp/hosty-d46-core-stop-artifacts --nologo --verbosity minimal`: succeeds with zero errors and
  four pre-existing warnings. The isolated output keeps the active Core generation unchanged.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path
  /tmp/hosty-d46-core-stop-artifacts --filter
  'FullyQualifiedName~CoreStopHttpTests|FullyQualifiedName~CoreDevelopmentTests|FullyQualifiedName~RuntimeAppSupervisorServiceTests|FullyQualifiedName~AppManagementHttpTests|FullyQualifiedName~AuditStoreTests'
  --nologo --verbosity minimal`: 175 pass, zero fail or skip. These include 13 new HTTP stop cases
  for administrator/CSRF/delegation admission, stale instances, launch/workspace/restart conflicts,
  bounded audit, forced keep-apps behavior, response-write failure and admission through actual stop.
- A parent-managed source child Core runs final Core `0.152.0` and the final Docker Shell image.
  Normal setup/password login verifies the single Restart action, original Shell confirmation,
  warning clearance and healthy Core Stop. Confirmed Core Stop returns acceptance, closes the
  child listener and leaves its app container running. The owner subsequently Finishes the child.
- Ordinary native Core stop/start is additionally exercised on the isolated test data root, without
  a parent supervisor reclaiming exited child workloads. Process exit is verified separately from
  HTTP acceptance. A fresh ready Core adopts the same Docker Shell container with unchanged start
  time. The fixture enables autostart for this recovery check: an ordinary new Core start retains its
  existing startup policy for autostart-disabled package Docker apps; Stop itself preserves them.
  This native lifecycle check uses normal password-authenticated API access; browser identity and
  Shell integration evidence comes from the managed child rather than the native diagnostic probe.
- The test app is removed through Core, native test processes exit, child Finish is verified, and
  private test roots, credentials, owned container resources and unused test image generations are
  removed. The registered redesign lease remains because the operator's Core/apps still consume
  the workspace. Read-only dev Shell inspection confirms both Core and Shell show one Restart
  primary action with title badges; no operator restart/stop is used as test evidence.

### Apps Overview Removal Verification (2026-10-23)

D45 is complete in the existing Shell `0.112.0` uncommitted batch. The Apps overview component and
view are removed. The expanded sidebar Apps heading is plain text; the compact catalog control is
absent and authorized app rows remain. Phone Apps collapses an overlaid tool workspace before opening
the app sidebar, preserving tool frames/selection and the current document. An ordinary user's
unselected `/` home renders no central page; administrators resolve to Dashboard. Personal profile
and tokens, authorized app workspaces and the existing ordinary-user logs-only boundary remain.

- `npm test --workspace @haas/hosty-shell`: 206 Node and 627 component tests pass. New checks cover
  empty ordinary Home despite launchable app rows, role guards, administrator Dashboard, retained
  profile/tokens, noninteractive/compact navigation, phone callback ordering and no app-page navigation,
  root/legacy redirects without loops, and assistant continuation preservation through authorization,
  aliases and login. Existing removal tests now exercise Dashboard menus and retain exact Core
  admission, duplicate-click, cancellation/retry, errors, success-only refresh and Logs destinations.
- Final TypeScript and Docker production builds pass. Lint has zero errors and the same three
  existing warnings. Version consistency, documentation and whitespace checks pass. The remaining
  removal entry points keep Core's protected review and authority; no app is uninstalled by this QA.
- A disposable parent-managed source Core with normal setup/password login runs Docker Shell.
  An administrator opening `/apps` resolves to `/dashboard` without a catalog; expanded/compact
  navigation has no catalog action. The final image is applied through a reviewed local update,
  and its actual running container image matches the final build identity. Reloading the retired
  URL still reaches Dashboard and reports no console error. Ordinary-user and phone role/overlay
  behavior is verified by component/route fixtures, not a live ordinary-user login or device matrix.
  Read-only inspection confirms the existing dev Shell also resolves `/apps` to Dashboard with
  direct application rows retained.

The parent confirms Finish. The child data root, owned Docker resources, preview listeners, parent
process, disposable credentials and exact owned QA image generations are removed. No operator Core
restart, app runtime switch, commit, publication or SDK/Core authorization change is performed.

### Shell Form Controls Verification (2026-10-23)

D44 is verified in the existing Shell `0.112.0` batch without another version increment or commit.
The remaining native selects in generic settings, mounts, invitations, browser address controls and
tool views use the existing shared Select. Native checkbox and source-radio rows use Checkbox and
RadioGroup; text/number/URL/password fields already use shared Input. A source audit finds native
input markup only in the shared Input implementation, and no page-owned select/option/textarea.

- `npm test --workspace @haas/hosty-shell`: 201 Node and 610 component tests pass. The controls
  retain exact empty/unknown/raw option values, numeric invitation expiry, source drafts/revisions,
  protected submission payloads, busy/authority/conflict locks and per-app assignment behavior.
  Existing interaction tests target visible accessible controls instead of hidden Radix form inputs;
  the jsdom setup supplies the missing ResizeObserver API. The nested Open views Escape regression
  fails before its fix and passes afterward, retaining frames, selection and trigger focus until a
  subsequent panel Escape.
- Scoped/final Shell lint has zero errors and the same three existing warnings. Final TypeScript,
  production Docker builds, version consistency and documentation validation pass. No new dependency,
  Core API, Dashboard structure or navigation change is included.
- A disposable parent-managed source Core with normal setup/password login runs the production
  Docker Shell. Browser checks cover Provider keyboard selection and conditional fields, mount mode
  selection/cancel, invitation role/expiry drafts/cancel, source radio keyboard selection and retained
  path text while toggling, and light/dark dropdown surfaces. No real invitation, mount binding,
  provider connection or source/network setting is saved. Submission outcomes and the narrow panel
  Escape sequence are covered by component tests; no broader device/browser matrix is claimed.
  The final image is applied through its reviewed local update plan, reloads successfully and reports
  no browser console error. A read-only check confirms the existing dev Shell renders SelectTrigger
  for Provider.

The parent confirms Finish; the child data root, owned Docker resources, preview listeners, parent
process, disposable credentials and exact owned QA image generations are removed. The operator Core
and its current app runtimes are not switched or restarted by this batch.

### Background Access Refinement Verification (2026-10-23)

D43 is verified within the existing Shell `0.112.0` batch. Background app access adopts the
credential Frame/table surfaces, searchable scope metadata, row menus and explicit history/lifetime
labels. Account-wide revocation is prominent above the personal credential grid with its full
scope explained; it remains administrator-only, own-account-only and protected by Core review.

- `npm test --workspace @haas/hosty-shell`: 201 Node and 585 component tests pass. Fifteen
  additional component cases cover full history, scope search/reset, exact scoped DELETE versus
  global POST, same-target scopes, OAuth removal, denied/cancelled/failed actions, duplicate-click
  protection, success-only navigation and actor changes. Lint has no errors and the same three
  existing warnings (the cross-origin login navigation warning moves with the global action).
  Final TypeScript and production Docker builds, version consistency and documentation checks pass.
- A disposable parent-managed source Core with normal setup/password login runs the final Docker
  Shell. The global action opens the existing isolated Core review with its full account-wide
  consequences; Cancel changes nothing, closes the Shell review and retains the signed-in rows.
  Empty background state, light/dark layouts and 390 px local table scrolling pass; document width
  remains 390 px. The final view reports no browser console errors.
- Populated grants, revoked/expired history and mutation success/failure use component fixtures.
  Automatic approval review declined creating real background grants as an unapproved access change;
  no live grant was created/revoked and no live global revocation is claimed. Broader real-provider
  and accessibility acceptance remains in its existing deliverables.

The parent confirms Finish. The child data root, owned containers/networks/volumes, preview listeners,
parent process, disposable credentials and exact QA image tag are removed. The operator Core remains
in dev mode from Hosty redesign; read-only inspection confirms the current dev Shell has the update.
No commit, publication, Dashboard or navigation change is included in this refinement.

### Host Settings Refinement Verification (2026-10-23)

D42 is verified with the existing Shell version `0.112.0` in the uncommitted redesign batch;
no extra commit, release or Core change is created. `npm test --workspace @haas/hosty-shell`
passes 201 Node and 570 component tests. `npm run lint --workspace @haas/hosty-shell` has zero
errors and the same three existing warnings. Final TypeScript and production Docker builds pass.
Existing grouped settings, source draft/revision and mount-binding checks retain their behavior;
no implementation-mirroring cosmetic tests are added.

A fresh parent-managed source Core with normal password login runs only the Docker Shell against
isolated data. Browser checks cover Maintenance save, provider-draft conditional fields, the
Cloudflare disconnected/diagnostic surfaces, Core-confirmed read-only creation of a disposable
shared mount, usage expansion and edit/cancel with an immutable name. The Source draft survives
a theme rerender without a save or Core restart. Desktop light/dark and 390 px layouts retain the
accepted navigation: Source and Network have no page/panel overflow, and the mounts table scrolls
inside its existing container. Connected Cloudflare publication/disconnect and actual source
restart are not exercised: no provider credentials are copied and this batch changes presentation.
Their existing contracts/tests and broader D20 acceptance remain separate.

Read-only review of the live workspace at 1564 × 1314 confirms the new Source/Updates cards
without changing operator settings or restarting Core. Parent Finish removes the test child data
root, Docker containers/networks/volumes and listeners; the owned parent process and disposable
credentials are removed. Live Core and existing application states remain intact.

## Incremental Adoption And Functional Parity (Owner Direction, 2026-10-13)

The owner is still refining the visual references. Apply finished foundations first: colors,
typography, logos/icons and common styling. Then adopt prepared Shell layouts and extend their
patterns to screens without a dedicated reference. This is a sequence proposal, not a one-session
implementation estimate or approval of unresolved interactions.

Mockups describe appearance and may omit existing actions or states. Inventory the current
functionality before replacing a screen; every supported action remains reachable, along with
permissions, navigation, forms, drafts, selection, panel state and failure/recovery behavior.
Absence from a mockup does not authorize removal. If placement is unspecified, retain the existing
control with compatible styling or propose its new location explicitly. Functional regression
blocks that screen's replacement even when the visual match is better.

The [November milestone](../hosty-delivery-readiness/plan.md) prioritizes the working development
journey. Foundation styling can proceed independently once approved; layout/activity changes need
their own full verification. Existing deliverables remain outstanding, and D20 tracks the parity inventory
and acceptance. Partial adoption does not mark the entire design plan complete.

## Core And Settings Coordination (Owner Direction, 2026-10-20)

The supplied Hosty Style Guide HTML adds Core authentication, installation, update,
permission and outcome artboards. The narrow approved adoption is tracked in
[Core confirmation design](../core-confirmation-design/feature.md); that adoption predates the broader implementation approval above. That feature owns the local Core fonts, trusted form palette,
brand mark and responsive card styling. Further Shell adoption remains tracked here; compact Core credential actions also use the shared forms.

[Settings experience](../settings-experience/feature.md) owns the implemented destination
inventory and protected settings workflow. The access-token grid in this design is
a visual example: current-user tokens belong to My profile; authorized support
actions for another user belong in that user's detail. Do not create a competing
global token destination or a Shell-wide Assistant access tab.

## Manifest Icon Ownership (Owner Correction, 2026-10-22)

Runtime app icons belong to the app's manifest and referenced assets. The earlier inline app-ID
substitutions left Permissions and other manifest consumers on the old assets; the adopted
metadata-based rendering replaces them and must not regress to per-app overrides. Shell, Harness and Marketplace now have
new `assets/icon.svg` files at their existing `catalogMetadata.icon` paths. This changes neither
the manifest schema nor its icon contract. Core branding and own-app empty illustrations remain
separate from runtime icon rendering. Complete the remaining accents and empty artwork under D4.

All seven first-party runtime apps now declare their cell SVG through existing manifest metadata,
including Whisper. Their completed asset/version adoption is recorded in [feature.md](feature.md)
and the verification archive. D4 retains the unfinished chart/empty-art/accent work, while D19
retains theme and font adoption in Plans, Telemetry UI and Demo App. Catalog snapshots keep their
vendored assets until normal publication; no source/runtime switch follows from this cleanup.

## Scope Decisions (Owner Direction, 2026-10-21)

- Keep Dashboard resource history at **five minutes**, matching the current
  [resource delivery contract](../runtime-resource-usage/feature.md). This redesign does not
  extend retention or require a new history API.
- Exclude the retired **Workspaces app** from the redesign, its app marks and token adoption.
  Harness owns the workspace experience and already has desktop, review and phone references.
- Keep the Dashboard layout from the design. Release/source identity and focus follow the
  2026-10-22 refinements below. The Runtime / workspace selector stays in the row's More dropdown, and
  source details retain hover, keyboard and click/touch access.
- Use **ReUI components wherever practical**, especially standard buttons, dropdowns and inputs.
  Reuse the repository's component wrappers and apply the visual tokens consistently; the
  Components section defines the adoption rule across the redesign.
- Use **Changed locally** for an unresolved review thread whose lines overlap unpublished local
  changes. This reports an observed change, not proof that the feedback is addressed. Keep the
  unresolved state visible; only the explicit Resolve action changes the thread's resolution.
- Prioritize design work for the demo on the already configured local Mac: briefly show a manually
  created clean environment, initial app selection, ordinary administrator setup, Marketplace and
  minimal settings, then return to the main instance. A clean CLI installation is outside this demo.
  Implementation follows the approval and unresolved-interaction boundary recorded above.

## Source, Lifecycle And Focus Refinements (Owner Direction, 2026-10-22)

This direction supersedes the earlier Workspace/Branch prefixes, primary-colored focus choice
and layered ink/lime focus style in the artboards and implementation notes. Core and app source labels contain only the workspace
display name or observed branch name with a dotted underline. The entire second metadata line —
version/source name and runtime — is monospaced. Core source text matches
app rows' muted `text-xs` styling. The later owner refinement uses a decorative hammer before a
workspace name and Git branch icon before source, without a type prefix, background highlight or
extra padding. Source details keep their current content and remain available on hover and keyboard
focus, with the existing persistent click/touch popover.
Core and source/workspace apps retain `SourceChangeSummary` after the workspace or branch name
on the same second metadata line, separated by a dot: observed additions and deletions, then the
count labelled `files`, with a `+` suffix for truncation. Narrow widths wrap naturally without a
forced third line. Missing line totals are omitted; failed or unavailable inspection produces no
fabricated count. This supersedes
the earlier hidden-counter/hover-only count guidance without shortening the full disclosure.

Source/workspace rows omit the pseudo-runtime words and their separator. Package versions retain
their concrete production runtime/profile names. A submitted switch
never replaces factual active-source evidence before Core confirms the transition.

Pending Starting, Stopping and Restarting belong in the main status, without a second copy beneath
the app name. During updates, primary lifecycle comes from Core's actual runtime state and
applicable health, never an update-stage label. Active update stopping/starting phases show only
Updating below it, without a service suffix; other supported phases keep their update label and
optional reported service. Terminal update outcomes add no row label or timer. Configuration problems
and Restart required remain separate information. Focus is
one thin, visible 2 px lime (`#A3E635`) outline or ring in both themes, without an additional
halo or ink edge. Red invalid/error focus and invalid borders remain unchanged. App-owned controls
inside the SDK host follow the same lime rule through the minimal shared theme bridge. Grouped
inputs use only the parent lime outline, or red when invalid. SDK-owned rail and chooser controls
follow the completed D31 adoption; broader control acceptance remains in D1/D16. Lime continues to identify hover, press, selection and progress
under the existing rules.

These refinements settle presentation; D1, D7, D19 and D20 retain their remaining conformance,
functional-parity, keyboard/touch, light/dark and embedded acceptance work.

## Core Runtime And Workspace Selector (Owner Direction, 2026-10-22)

Name the runtime submenus **Runtime / workspace** for both apps and Core. App choices retain their
existing package, branch/source and workspace capabilities; this is a menu label change, not the
removal of source configuration or an existing runtime.

Core's Dashboard selector offers Release and eligible, already registered named workspaces. Replace
the generic Source/main target with those concrete workspace choices. Reuse the same reviewed Core
workspace handover, durable request/status recovery and Return operations as Harness, including
existing administrator, source, binding and separately reviewed Core activation authority. Do not
create a workspace, rewrite source settings or dispatch a generic dev restart merely to imitate a
workspace selection. Preserve returned previous-target identity; a Return to a captured source
executable must not be displayed as a completed Release selection.

Keep Source settings as a separate action. The current source name, branch/workspace provenance,
IDE/external launch and unmanaged/unavailable states remain factual even when that runtime is not
a selectable generic target. Review, disabled reasons, confirmation, failure/reconnect and existing
Core restart/update/log actions remain reachable. A selected workspace is not active before Core
confirms its actual launch identity. This Dashboard adoption stays in D7 and reuses
[workspace activation](../workspace-live-activation/feature.md); it adds no lifecycle contract or
broader acceptance claim.

## App Details And Settings Navigation (Owner Direction, 2026-10-22)

The owner explicitly replaces the duplicate installed-app settings catalog with Dashboard as the
entry point for App Details. App Details/Manage uses the standalone canonical
`/apps/<app-id>?section=<section>` route, outside the Settings hierarchy, with an administrator's
`Dashboard / <app name>` breadcrumb whose Dashboard link returns to `/dashboard`. The retained
ordinary-user logs-only entry links back to the empty `/` Home after D45, without exposing an administrator destination.
Dashboard app rows and app-name links, contextual Logs, More > Console logs and
readiness/update-notification links select the same details page and preserve the requested
section, including Logs. Former `/settings?tab=manage:<app-id>&section=<section>` bookmarks migrate
to the corresponding canonical destination; the removed `/settings?tab=apps` catalog returns to
Dashboard under existing role authorization rather than reproducing the installed-app list.

Settings keeps My profile, Host, Users & security and Shell. Its Apps group lists individual apps
only when their manifest declares an app-owned `ui.settings` surface. These destinations remain
embedded Settings pages with their existing authentication, permissions, sizing and app-owned
internal navigation. Host-managed Launch/Parameters/Folders/Network/Permissions/Updates/Backups
controls belong to App Details, not this Apps group. Preserve direct app-settings bookmarks,
logs-only ordinary-user entry, capability and administrator boundaries, protected Core reviews,
independent form drafts and full-height embedded settings behavior.

This is approved steering within D7/D29/D30 of the existing In Progress redesign. Their full
light/dark, narrow, keyboard, permission and protected-flow acceptance remains unchecked until
its required verification passes.

## Apps Removal And Dashboard Diagnostics (Owner Direction, 2026-10-22)

Following D45, the duplicate Apps overview is removed. Dashboard and
Manage removal entries open Core's isolated approval directly, without an intermediate
Shell options/confirmation dialog. Core owns cleanup choices, removal impact, runtime-state and
active-Shell warnings, source-safety review and the final destructive decision. Preserve every
supported option and existing authorization, installation/source binding, nonce and stale-review
guard. Preparing or opening review must never uninstall an app.

Retain a synchronously reserved popup, an explicit blocked-popup fallback, cancellation/denial,
visible failure and original-request submit/status recovery. Report removal only after Core confirms
successful execution; an unknown outcome must not prepare or execute another removal automatically.

Dashboard app-version hover contains revision/build information only. Full update-check errors
belong to the problem icon after the app name, with diagnostics retained in Manage and error toasts
preserved. Remove the native error title from the version wrapper rather than duplicating the error
there. This presentation change does not alter update availability or Core-card diagnostics.

Under the same owner direction, runtime app rows no longer expand a services/network panel.
Administrator clicks on noninteractive row space open the existing Manage/App Details destination
formerly reached through More > Manage application; remove that duplicate menu entry. Keep a native
app-name link for keyboard access and new tabs, with no extra row tab stop. Embedded controls and
portalled menus/disclosures retain their own behavior; modified/nonprimary clicks and text selection
do not navigate the row. Relocate all per-service health/runtime, resource, image-revision and
endpoint facts/controls to Manage without deleting functionality.

The later 2026-10-22 owner direction also removes Core's expander and entire expanded Dashboard
panel. Preserve its listen address, public origin, data root, runtime host and ingress mode in a
read-only Core information section under Settings > Host > Updates, including address copying.
Reuse the existing authenticated Shell status without new reads or polling, retain unavailable
states and keep unsaved configuration drafts intact. Core's row remains its metadata/status/resource
summary with Logs, Runtime / workspace, Restart, Update and Source settings actions unchanged.

D7 and D20 retain their existing functional, permission, responsive and embedded acceptance.

## Source

The design lives on a Design canvas: <https://claude.ai/artifact/4LypxfZnHz2E7fxhXti4th>. The canvas
is the single source for the visuals and keeps its own version history; it is private to the owner
until shared from its page. This document carries every value and rule needed to implement it.

| Artboard | Covers |
| --- | --- |
| `Main` | Cover and the four principles |
| `Color`, `Accent` | Palette, ink scale, status, app accents; ink acts, lime answers |
| `Type`, `TypePairings` | Type scale and voice; the face comparison behind IBM Plex Sans + JetBrains Mono |
| `Iconography`, `Roles`, `AppMarks` | Mark, app icons, interface icons; provider role icons; the app mark family |
| `Components`, `Tokens` | ReUI components in light and dark; CSS variables |
| `Motif` | Cell motif, loader, empty state, motion |
| `Shell`, `AppDetail`, `DataGrid` | Dashboard with tools, dark app detail, table page |
| `PanelOptions`, `ShellNarrow` | The fit rule for tools, Shell in a 900 px window |
| `PhonePeek`, `PhoneSheet`, `PhoneTools`, `PhoneKeyboard`, `PhoneManyTools` | Phone: tab bar, open tool, tool list, keyboard and long dialog, many tools |
| Core authentication, install/update confirmation, permissions and outcomes in the supplied export | Existing references; adopted by the Core confirmation design feature |
| SDK access overlays; SDK install flow in the supplied export | Blocking cards, non-blocking banners, source entry, Core handoff and progress; adoption tracked by D31 |
| `HarnessPage`, `HarnessReview` | Harness development page; its review page for session changes and open pull requests |
| `HarnessPhoneList`, `HarnessPhoneChat` | Harness on a phone: sessions, and the conversation with the workspace sheet |
| `EnvSetup` | First-run visual reference mapped to the implemented parent Dashboard creation/progress and child Core registration/open journey (D27) |
| `Marketplace`, `Settings`, `AppManage` | Marketplace catalog and installed apps; Shell settings; managing one app |

## Design Coverage And Remaining References (2026-10-21)

The updated owner-supplied **Hosty Style Guide.html** contains 36 artboards. `Marketplace`,
`Settings` and `AppManage` now supply the previously missing main page references, tracked by
D28–D30. `EnvSetup` supplies a first-run reference, with the dependency and contract differences
described under Creating the environment. The previous 32 boards retain their design content.

Manual environment creation is implemented in main at `c3d8e1a9`, documented by
[Hosty initialization](../hosty-initialization/feature.md). The earlier implementation dependency
is satisfied. D27 maps the artboard onto that existing journey. Published-distribution and remaining
platform acceptance stay open in the [initialization plan](../hosty-initialization/plan.md), D10–D11;
this design review does not mark those checks complete.

Remaining design work is tracked by D32:

| Priority | Remaining reference or variant | Reuse and boundary |
| --- | --- | --- |
| Demo creation journey | Parent Dashboard creation entry/dialog and environment rows: name and app selection, progress/failure/resume, setup/open and expired-link recovery; clear child-versus-main identity. Map these to the shipped journey before adding screens. | `EnvSetup` depicts the child first-run experience, not the parent creation dialog. Reuse its components and the Dashboard. Administrator credentials stay on the child's Core page. |
| Demo acceptance | Loading, empty/no-results, access-denied, disconnected and failed-operation states for the new Marketplace/Settings/AppManage pages; unsaved and conflicting settings; dark and narrow variants. | Reuse the existing Core forms, SDK access overlays and Shell phone/tool layouts. Test representative demo settings while preserving all supported controls. |
| After the core demo path | Shared log viewer and destructive/recovery dialogs; Plans list/document/version/discussion surfaces; Telemetry logs, metrics and traces. | Reuse the data-grid, typography, chart and dialog patterns. These are remaining app references, not new platform behavior or mandatory demo gates. |

Harness already has desktop sessions/conversation/workspace, review and phone references; it does
not need another overall design. Core authentication and install/update/permission confirmations
also have references. SDK access cards/banners and installation use their supplied designs under completed D31. The retired Workspaces app remains excluded.

D32 owns design preparation and review only. Existing token adoption uses D1/D19; any additional
page-layout implementation needs concrete scope after review. D20 applies to all adopted mockups.

## Principles

1. **Calm chrome, lively content.** Navigation, panels and text stay ink and white. Color belongs to
   app marks, status and charts.
2. **Ink acts, lime answers.** Primary buttons are ink. Lime appears in answer to the person —
   hover, press, focus and selection — and, by owner decision, in two fixed places: progress bar
   fills, whoever started the work, and the Core cell of the mark. One primary button per view; the
   rest are outline or ghost.
3. **Work moves in blue.** An app starting or a tool at work shows a pulse or a turning ring in Info
   blue with a label, and its progress bar fills in lime; there is no separate live color.
4. **Cells.** The mark is seven square cells; the same cells build the motif, the loader, empty states
   and diagrams.

## Color

### Core

| Name | Hex | Use |
| --- | --- | --- |
| Ink | `#0F1B2D` | Text, dark surfaces, the mark, the primary action (17.4:1 on white) |
| Mist | `#F6F8FB` | Light canvas; cards sit on it in pure white |
| White | `#FFFFFF` | Cards, popovers and fields on the mist canvas |
| Lime | `#A3E635` | Brand: hover, press and thin 2 px focus, checked and selected fills, text selection, progress bar fills, the Core cell of the mark. The same in both themes; carries ink text (11.5:1). Focus uses this exact lime without an ink edge; other light-surface text, icons and hairlines use the stronger tokens. |
| Lime strong | `#5A9A0A` | Small lime marks on light: the active-navigation marker, the selected-tab underline, loader cell edges (3.5:1 on white, 3.2:1 on mist and lime soft) |
| Lime soft | `#ECFCCB` | Highlight under ink text: menu items, ghost hover, active navigation (dark: `#273B2E`) |

Approximate share of a typical screen: ~70% white and mist, ~20% ink, ~5% lime and only on
interaction, and ~2% app and status color.

Owner decision, 2026-10-13: ink is the action color and lime the interaction color, in both themes.
Hosty Blue `#1C68FF` remains only as Info, for links (`#1449C2` on light, `#8DB4FF` on dark) and as the
first chart color, `--chart-1`, because charts are data, not brand; a sky
blue `#00BBFF` tried the same day was dropped, and so was the cyan signal color: work now shows in Info
blue with motion, so the brand is ink, white and lime. The per-user accent setting stays parked in
[Accent Presets](../accent-presets/plan.md).

### Ink scale (cool neutrals, hue 215°)

| Step | Hex | Use |
| --- | --- | --- |
| 50 | `#F6F8FB` | Canvas, sidebar |
| 100 | `#EEF2F7` | Muted, hover |
| 200 | `#DFE5EE` | Border |
| 300 | `#C3CDDB` | Input border |
| 400 | `#93A3BA` | Muted text on dark; disabled on light (2.9:1) |
| 500 | `#6E7F98` | Icons only (4.1:1 on white — not for text) |
| 600 | `#5A6A82` | Muted text on light — the lightest text allowed (5.4:1) |
| 700 | `#3A4B66` | Secondary body text |
| 800 | `#26364F` | Border on dark |
| 900 | `#17253B` | Card on dark |
| 950 | `#0F1B2D` | Text; dark canvas |

### Status

Four meanings, never mixed: **info** tells, **needs you** asks, **failed** reports an error, and
**working** shows activity. A waiting approval is "needs you", not info.

| State | Solid | Soft | Text | Meaning |
| --- | --- | --- | --- | --- |
| Running | `#16A34A` | `#E8F7EE` | `#0F6B33` | Healthy and serving |
| Working | `#1C68FF` (dark: `#4D8BFF`) | `#E8F0FF` | `#1449C2` | Starting, updating, a tool at work: Info blue with a pulse or ring and a label; its progress bar fills lime |
| Stopped | `#93A3BA` | `#EEF2F7` | `#5A6A82` | Intentionally off, not an error |
| Info | `#1C68FF` | `#E8F0FF` | `#1449C2` | An update or a result; never requires action |
| Needs you | `#F59E0B` | `#FEF3DC` | `#8A5300` | A decision or a fix: approval, degraded app, missing configuration |
| Failed | `#D93036` | `#FDECEC` | `#B4232A` | Error: crashed, unreachable, refused |

Color never carries a state alone. Where a row has room, every state carries its name, running
included, as the Dashboard does. Where it does not — compact rows, navigation, tool badges — the
normal state, running and healthy, is a bare dot with its name in the tooltip and accessible label,
and every other state keeps a text label or, failing that, its own shape: a diamond for "needs you", an alert icon
for "failed", a hollow ring for "no connection", and for "working" a pulse that becomes a static outer
ring when motion is reduced. No two states differ by color alone: working shares Info's blue and is
told apart by its motion and label.

### App accents

D39 must settle validated accent metadata before the remaining frame strips and tool badges in
D4/D14 are implemented; no first-party app-ID substitution is authorized. Each first-party app has
one accent. It is identity only: the lit cell of the app's mark, a 3 px
strip on the app's own frame and the corner badge on its tools — both in the strong shade on light
surfaces and the accent itself on dark, since no base accent reaches 3:1 on white or Mist — the first series of the app's own charts (the app sets `--chart-1` to
its strong shade on light and to the accent itself on dark, where the strong shades drop below 3:1) and its mark, with that one cell lit, in its empty-state art. It never fills behind content, never marks focus or selection, and never
stands for a state, so it may sit near a status hue without meaning one. Lime stays Hosty's, and
interaction stays lime inside every app. Accents sit at least 20° apart — the closest pair, Harness and Marketplace, is 21° — and a new
first-party app takes a free hue and a free mark. Third-party apps keep their own icons.

| App | Accent | Strong (chart lines and small UI marks on light) | Mark | Cells, top to bottom |
| --- | --- | --- | --- | --- |
| Hosty (reference) | `#A3E635` | `#5A9A0A` | H | `X.X` `X*X` `X.X` |
| Shell | `#22D3EE` | `#0891B2` | S | `XX.` `X*X` `.XX` |
| Plans | `#60A5FA` | `#2563EB` | P | `XXX` `X*X` `X..` |
| Telemetry | `#A78BFA` | `#7C3AED` | T | `X*X` `.X.` `.X.` |
| Harness | `#FB923C` | `#C2410C` | A (agent) | `.X.` `X*X` `X.X` |
| Whisper | `#F472B6` | `#DB2777` | V (voice) | `X.X` `X.X` `.*.` |
| Marketplace | `#FACC15` | `#A16207` | M | `XXX` `X*X` `X.X` |
| Demo App | `#E879F9` | `#C026D3` | D | `XX.` `X*X` `XX.` |

`X` is an ink (or white) cell, `*` the lit cell in the accent, `.` an empty cell; each row reads left to
right on the 3 × 3 grid. The lit cell uses the base accent on every surface, like the Hosty Core cell:
a logo is exempt from contrast minimums, and the strong shade is for chart lines and small interface
marks. The catalog icon — which Shell also shows in its rows and navigation — and the empty-state art both
use this map; there is no separate in-app copy of the mark.

## Typography

IBM Plex Sans for the interface, JetBrains Mono for anything a machine wrote — IDs, ports, versions,
paths, logs. Owner decision, 2026-10-15, after the `TypePairings` comparison: Plex's squared details
echo the cell mark, JetBrains Mono reads better in code and logs than Plex Mono, and both cover
Cyrillic and ship under the OFL. Core pages self-host both files, allowed by `font-src 'self'` in their otherwise strict CSP.
Weights 400 and 600 do most of the work; 500 is for buttons and badges.

| Token | Size / line | Weight | Tracking |
| --- | --- | --- | --- |
| display | 48 / 52 | 600 | −3.5% |
| h1 | 30 / 38 | 600 | −2% |
| h2 | 22 / 30 | 600 | −1.5% |
| h3 | 17 / 24 | 600 | −1% |
| body-lg | 16 / 26 | 400 | 0 |
| body (default) | 14 / 22 | 400 | 0 |
| small | 13 / 20 | 400 | 0, muted |
| overline | 11 / 16 | 600 | +8%, uppercase |
| mono | 13 / 20 | JetBrains Mono 400 | 0 |

Sentence case everywhere; uppercase only for the overline. Numbers that change use `tabular-nums`.
Body lines stop at about 72 characters. Phone inputs use 16 px so mobile browsers do not zoom.

Harness maps its local `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl` and `text-2xl`
utilities to small, body, body-lg, h3, h2 and h1 respectively. Its UI uses 400 body, 600 headings
and 500 buttons/badges, with 13/20 technical monospace. SDK font inheritance is scoped to SDK-owned
chrome controls so app-owned size, weight and line-height utilities remain effective. This narrow
ownership correction does not complete D19's remaining app/control adoption. D31 now records
the completed SDK surface adoption and its scoped checks. The separate [SDK Style Isolation draft](../sdk-style-isolation/plan.md)
records the owner's request to review a complete style boundary, with no chosen architecture or
implementation approval. Broad device and functional acceptance remains in D12/D13/D16/D20.

### Voice

Friendly, not cute. Say what happened, then what to do; name the app, the port or the path. Examples
in designs set the standard too: an assistant proposes an action only for a problem that is still
happening.

| Do | Don't |
| --- | --- |
| Core restarted. 9 apps reconnected. | Woohoo! Everything is back online!! |
| Telemetry can't reach port 4318. Check that the collector is running. | Oops, something went wrong. |
| Remove Marketplace? Its data stays in `~/.hosty/apps`. | Are you sure? |

## Logo and icons

- **Mark.** Seven square cells on a 3 × 3 grid spell an H: two hosts and the Core between them. On
  the 100-unit grid the cells are 22 units with 7-unit gaps, starting at 10, with sharp corners. Six
  cells are ink on light and white on dark; the Core cell is lime `#A3E635` on every surface (owner
  decision, 2026-10-14; a logo is exempt from contrast minimums). The mark never sits on a colored tile. It replaces the H-graph in
  [`assets/hosty-brand`](../../../assets/hosty-brand/README.md). Clear space is one cell. Below 20 px
  use the favicon cut, scaled ×1.16 with the gaps kept open. No gradients, no app accents, no
  rounded or merged cells, no rotation.
- **App icon.** Where a container is required — app icon, favicon, store — the mark sits on an ink
  tile with radius 22: white cells 16 units with 5.5-unit gaps from 20.5, and the lime Core. Where Shell
  draws it on a dark surface the tile steps one tone lighter (`#22324B`) instead of taking a grey
  frame; a baked icon elsewhere keeps the ink tile and sits on a card surface in dark mode.
- **Wordmark.** IBM Plex Sans 600, shipped as outlined paths; the current lockups ask the system for Inter.
- **App marks.** Every first-party app is drawn like the Hosty mark: square cells on the same 3 × 3
  grid spell the app's initial, with exactly one lit cell in the app's accent (see App accents). Ink
  cells on light, white on dark; where a container is required, the same ink tile as the Hosty icon
  (`#22324B` where Shell draws it on a dark surface), never a colored tile. A pattern belongs to one app. They replace the
  colored tiles with stroke glyphs.
- **Interface icons.** Lucide at 16, 20 or 24 px, stroke 2, never filled, inheriting text color —
  muted at rest, ink when active. App navigation icons ship in `currentColor`; Shell tints them.
- **Tool icons.** A tool shows its manifest Lucide icon on a neutral tile, with the owning app's
  accent as a small corner badge — its strong shade on light, the accent on dark.

### Provider roles

Hosty does not divide apps into system and ordinary, and no design shows a "System" label. An app is
described by the roles it provides; each role has one icon, used wherever the app appears.

| Role | Icon (Lucide) | Provided today by |
| --- | --- | --- |
| `ui-client` | `app-window` | Shell, once [replaceable UI clients](../replaceable-ui-clients/plan.md) ships the role |
| `assistant` | `bot` | Harness |
| `speech-to-text` | `audio-lines` | Whisper |
| `otlp-collector` | `radar` | Telemetry |
| language model (planned) | `cpu` | reserved |
| `text-to-speech` (planned) | `volume-2` | reserved |

- Roles come from Core's confirmed roles, not from what a manifest requests.
- Role icons are ink on mist in a 20 px chip; the app's accent stays on its mark.
- Rows show icons only, with "Provides: …" as tooltip and accessible label; app details show icon
  and name. At most three icons, then `+N`; an app without roles shows none.
- Lifecycle warnings speak in roles: "Stopping Harness leaves the host without an assistant."

## Components

Owner direction, 2026-10-21: use ReUI components wherever practical throughout the redesign,
especially its basic controls. On React surfaces in Shell, Harness, first-party web apps and the
React SDK surfaces, start with the existing ReUI components and repository wrappers for Button,
Dropdown Menu, Input, Select/Combobox, Checkbox, Switch, Tabs, Dialog/Sheet, Tooltip/Popover and
Data Grid. Compose these primitives and style them with the shared tokens; do not recreate standard
controls with page-specific markup merely to match an artboard. Keep keyboard, focus, disabled,
loading, validation and accessible-label behavior. A custom control is justified only where the
available components do not support the required interaction; record that gap during D20's review.
Core's server-rendered setup and confirmation forms retain their native form behavior and shared
Core styles. Matching the design there does not require adding a React runtime or component library.

Controls are 36 px tall (32 small, 40 large; 44 px
touch targets on phones) with an 8 px radius; popovers use 10 px and cards 14 px. Borders separate;
shadows only lift what floats. Disabled is 45% opacity. Dark mode lifts surfaces with a lighter fill
rather than a shadow.

- **Buttons.** The primary button is ink with white text, near-white with ink text in dark. Default
  and outline buttons turn lime with ink text on hover and press; on touch, press stands in for
  hover. Danger stays red and darkens on hover.
- **Focus.** One thin, visible 2 px lime (`#A3E635`) outline or ring in both themes, without a
  second ring, halo or ink edge. Apply it to app-owned fields, buttons, navigation, source
  disclosures, dialog controls and resize handles, including app controls inside the SDK host.
  Retain red invalid/error treatment and invalid borders. Grouped inputs suppress the child
  outline and keep only the parent lime outline, or red when invalid. SDK-owned rail and chooser
  controls follow the completed D31 adoption. Retain keyboard visibility independently of hover, press and selected fills.
- **Selection.** Checked checkboxes and switches are lime with an ink check or knob; text selection is
  lime with ink text. Menu items, ghost hover and active navigation highlight in lime soft with ink
  text; a selected table row takes a lime wash, and a selected tab a 3 px underline in lime strong on
  light (3.2:1 on Mist) and lime on dark.
- **Progress.** Progress bars fill with lime on a neutral track (`#EEF2F7`, dark `#26364F`) in both
  themes; the label next to the bar carries the value.
- **Links.** Info blue, underlined.

## Tokens

ReUI reads the standard shadcn CSS variables, so the theme is a values swap in `globals.css`. Note that
shadcn's `--accent` is the hover and highlight background — here lime soft — and `--primary` is the
ink action color; lime itself is the Hosty addition `--brand`.

| Variable | Light (`:root`) | Dark (`.dark`) |
| --- | --- | --- |
| `--background` | `#F6F8FB` | `#0F1B2D` |
| `--foreground` | `#0F1B2D` | `#F1F5FA` |
| `--card` | `#FFFFFF` | `#17253B` |
| `--card-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--popover` | `#FFFFFF` | `#1C2B44` |
| `--popover-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--primary` | `#0F1B2D` | `#F1F5FA` |
| `--primary-foreground` | `#FFFFFF` | `#0F1B2D` |
| `--secondary` | `#EEF2F7` | `#26364F` |
| `--secondary-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--muted` | `#EEF2F7` | `#1C2B44` |
| `--muted-foreground` | `#5A6A82` | `#93A3BA` |
| `--accent` | `#ECFCCB` | `#273B2E` |
| `--accent-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--destructive` | `#D93036` | `#D93036` |
| `--border` | `#DFE5EE` | `#26364F` |
| `--input` | `#C3CDDB` | `#2E3F5C` |
| `--ring` | `#A3E635` | `#A3E635` |
| `--sidebar` | `#F6F8FB` | `#0B1524` |
| `--sidebar-foreground` | `#3A4B66` | `#B8C4D6` |
| `--sidebar-accent` | `#ECFCCB` | `#273B2E` |
| `--sidebar-accent-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--sidebar-border` | `#DFE5EE` | `#1A2A42` |
| `--sidebar-ring` | `#A3E635` | `#A3E635` |
| `--chart-1` … `--chart-5` | `#1C68FF` `#7C3AED` `#C026D3` `#F59E0B` `#64748B` | `#4D8BFF` `#A78BFA` `#E879F9` `#FBBF24` `#94A3B8` |

Charts never use lime; it belongs to interaction. `--chart-1` is Hosty Blue in Shell's own charts; a
first-party app overrides it inside its own frame — strong shade on light, accent on dark — so there is one
first-series token, not two. A later colored chart token (`--chart-2` to `--chart-4`; the slate
`--chart-5` is neutral and never swaps) that sits within 20° of the app's accent takes the displaced
Hosty Blue instead, so no two series match: Telemetry swaps with `--chart-2`, Demo App with
`--chart-3`, Harness and Marketplace with `--chart-4`. Plans' accent is itself blue, so it simply
replaces Hosty Blue and nothing is displaced.

Hosty additions:

| Variable | Light | Dark |
| --- | --- | --- |
| `--brand` / `--brand-foreground` | `#A3E635` / `#0F1B2D` | `#A3E635` / `#0F1B2D` |
| `--brand-strong` | `#5A9A0A` | `#A3E635` |
| `--success` / `--success-soft` / `--success-text` | `#16A34A` / `#E8F7EE` / `#0F6B33` | `#22C55E` / success at 16% / `#4ADE80` |
| `--warning` / `--warning-text` | `#F59E0B` / `#8A5300` | `#F59E0B` / `#FBBF24` |
| `--info` / `--info-text` | `#1C68FF` / `#1449C2` | `#4D8BFF` / `#8DB4FF` |
| `--destructive-soft` / `--destructive-text` | `#FDECEC` / `#B4232A` | red at 18% / `#FF8A8E` |

```css
@theme inline {
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --color-brand: var(--brand);
  --color-brand-foreground: var(--brand-foreground);
  --color-brand-strong: var(--brand-strong);
  --color-success-soft: var(--success-soft);
  --color-success-text: var(--success-text);
  /* warning, info and destructive the same way */
}
```

Default and outline buttons use `hover:bg-brand hover:text-brand-foreground` instead of
`hover:bg-primary/90`. Non-focus uses of `primary` as a foreground — `text-primary`,
`border-primary`, a small `bg-primary` dot — move to `--brand-strong` or Info blue, because ink there
would read as body text and lime fails on light. Focus separately uses the exact lime/red rule
above. In Shell today the non-focus uses include the Button `link` variant,
`field.tsx` (checked choice border and link hover), the Cloudflare connection card link, and two
indicator dots.

Radius: `--radius: 0.625rem` (sm 6, md 8, lg 10, xl 14). Spacing on a 4 px base: 4, 8, 12, 16, 20,
24, 32, 40, 48. Elevation: card `0 1px 2px` at 6% ink, dropdown `0 4px 14px -4px` at 16%, dialog
`0 14px 34px -8px` at 24%.

## Motif and motion

- **Cell field.** A 70 px grid of 22 px square cells, no wires, at most four colored cells — app
  colors, lime for the platform, Info blue for what works; backdrop for headers, onboarding and empty
  states.
- **Loader.** Lime travels the H cell by cell: down the left column, through the Core, up the right.
  The loader is the mark in motion, so its cells light in the mark's lime; on light surfaces each lit
  cell keeps a lime-strong `#5A9A0A` edge so the shape holds 3:1, and on dark it is plain lime.
  Status dots, labels and rings for the working state stay Info blue.
- **Empty state.** In Shell, dashed cells are slots waiting to be filled and the lime cell in the Core
  spot is the action. Inside an app, the empty state shows the app's own mark with its accent cell
  lit, as identity, and keeps the action as an ordinary button. One sentence of help, one primary
  button.
- **Motion.** Hover and press 120 ms ease-out, color only. Menus 150 ms fade plus 4 px. Panels and
  sheets 220 ms `cubic-bezier(.2,.8,.2,1)`. Toasts 240 ms in, 160 ms out. The working pulse loops
  at 1.6 s, in Info blue, and only on working states. `prefers-reduced-motion` keeps fades and stops movement and loops;
  the working dot then keeps a static outer ring so it still differs from a plain dot.
- **Avoid.** Gradient washes and glows, frosted glass, 3D or stock illustration, emoji as icons.

## Shell layout

### Dashboard

Owner direction, 2026-10-21, from the `Shell` artboard, refined on 2026-10-22 for app-row navigation. The installed-apps table in
[Core App Shell](../core-app-shell/feature.md) is the functional baseline (D20 applies).

- No visible column-header row. Core's row and every app row use the same fixed columns — identity
  (flexible), state (188 px), resources (192 px) and actions (184 px) — so values line up down the
  page.
- **Identity:** tile, name followed by its provider role icons, and source · runtime on a second
  line, in the position occupied by the version in the artboard. For a package release, show its
  version; for active source, show only the workspace display name or observed branch name in
  monospaced text with a dotted underline and a decorative hammer for a registered workspace or
  Git branch icon for source, without a Workspace/Branch prefix, background highlight or extra
  padding. Source/workspace rows omit pseudo-runtime words and their separator. Keep production runtime and
  package profile names unchanged; do not add another selector or column. The full second metadata
  line, including version/source name and runtime, is monospaced. Core source
  labels use the same muted `text-xs` treatment as apps.
  Long names truncate without moving the columns, with their full value available on disclosure.
  Use Core's observed active/selected source facts and retain pending-switch/failure states; a
  submitted switch is not proof that the new runtime started. A workspace's internal Git branch
  does not turn it into branch mode.
  In release mode, an available update shows as `0.6.1 → 0.7.0`, with the new version in Info blue.
  In source mode, package versions and update actions remain reachable in the source disclosure/menu
  and Manage application; a package update must not replace the active source name.
  No app row displays a Manual start marker. Autostart remains configurable in the existing More
  menu and Manage > Launch; removing the marker does not change start behavior or its controls.
- **Row navigation:** runtime app rows have no services/network expander. For administrators,
  noninteractive row clicks open the same Manage/App Details destination as the former More >
  Manage application item, which is removed. A native app-name link retains keyboard/new-tab access
  without an extra row tab stop. Embedded actions, menus and version/source/resource disclosures
  act independently, including portalled content; modified/nonprimary clicks and text selection do
  not navigate. All former app service/network facts and controls remain in Manage. Core also has
  no expander or inline detail panel; its former host facts and address controls live in Settings.
  Core's actions, metadata, source disclosures and resource popovers remain independent.
- **Source changes:** Core and source/workspace app rows show `SourceChangeSummary` after the
  workspace or branch name on the same second metadata line, separated by a dot: observed additions
  and deletions followed by the count labelled `files`, with a `+` suffix for truncation. Let the
  metadata wrap naturally at narrow widths without a forced third line. Omit missing line totals;
  unavailable or failed inspection never supplies fabricated counts. Hover and keyboard focus on the dotted source name still expose the complete
  revision/file/line details; click/touch opens the persistent popover. Keep the full source/change
  inspection reachable alongside the visible counts.
- **State:** the current runtime state's name always shows in its status color — Running,
  Starting, Stopping or Stopped — after its dot or shape, composed with applicable health such as
  Running · degraded. Missing runtime observations show Unknown; do not infer lifecycle from an
  arbitrary operation label. Active update progress sits beneath this primary status, including on
  source/workspace rows, rather than in version metadata. Update stopping/starting phases show only
  Updating, without a service suffix. Retain Update queued, Preparing update, Creating backup,
  Installing, Downloading and Checking readiness with the reported service for other real phases;
  do not invent percentages. Under the owner correction of 2026-10-22, terminal outcomes add no row
  label or timer. Keep existing completion/error/readiness toasts and diagnostic icons/Manage.
  Pending Starting, Stopping and Restarting appear in the main status without a duplicate verb
  beneath the name. Keep independent configuration and Restart required information visible.
- **Resources:** two lines, CPU and RAM, each with its value and a sparkline of the last 5 minutes,
  CPU in `--chart-1` and RAM in `--chart-2`; a stopped app shows a dash. One accessible label reads
  both values. Use available samples within the existing five-minute window; gaps and partial
  startup history do not imply zero usage. No retention extension is in scope.
- **Actions:** at most one contextual action (Start, Stop, Update, Logs, Configure), at most 144 px
  wide and truncated with its full name in the tooltip. Preserve existing pending, Configure,
  Update and Start priority. Under the owner direction of 2026-10-22, a running app offers Logs
  to administrators only for observed degraded or unhealthy service health when logs are supported;
  otherwise it offers Stop. Update, manifest, permission and previous-operation alerts retain their
  diagnostics without changing this shortcut. Missing, unknown or startup health is not a failure.
  Non-administrators retain their
  existing Logs shortcut and never gain Stop. Both runtime-app log entries select the capability-gated
  Logs tab in App Details at `section=logs`, as do readiness and update-notification actions. Core's
  log dialog is unchanged. The ReUI More
  (⋯) dropdown retains Restart, Logs, the Runtime / workspace submenu and supported operational actions;
  Manage application is reached from the row rather than duplicated in More. App runtime/source choices
  move out of the row into this dropdown, using a submenu or opening the existing picker as
  needed. Preserve package runtime, branch and workspace selection and Return, including current
  selection, disabled reasons, permissions, confirmations and failure recovery. Source identity in
  the row is informational; it is not an inline switcher. Contextual action buttons do not appear
  only on hover, so labels and any source-change disclosure never shift the columns.
- **All apps row:** the apps table starts with a row in the same columns. Search sits at its left
  and opens into a field in place of the title, filtering the rows together with the state filters;
  the count reads "8", or "3 of 8" while filtered; the aggregate CPU and RAM with their sparklines
  sit directly above the rows' resources. Its state column stays empty, since the filters already
  count the states.
- **Core** is the first row of its own table with the platform's ink tile, its state ("Running ·
  Healthy · up 3 days") and its resources in the same columns, without an expander or expanded detail
  panel. Settings > Host > Updates retains its listen address, public origin, ingress mode, data
  root and runtime host in read-only Core information, with copy buttons for addresses and honest
  unavailable states. Core actions and metadata remain on Dashboard. Runtime app rows open Manage, where per-service
  status, health, image revisions, resources and endpoint controls remain available. Core's
  Runtime / workspace submenu lists Release and eligible existing named workspaces through the
  supported workspace handover/Return flow; Source settings remains separate, and factual source
  or IDE/external state is not replaced by a generic Source/main option.
- **Header:** the Apps title, filters as text toggles with counts (All, Running, In progress,
  Attention, Updates) and the single primary Install app. The artboard no longer shows Check updates
  or Update all; both stay reachable with the feature's behavior — Update all (N) as the All apps
  row's contextual action when routine updates are available, and Check updates in that row's More
  menu.
- **Compact layout,** selected by the page's own width: list rows, filters in a menu, icon-only
  Install and reflowed resources. Per-service details remain in Manage rather than a runtime app
  row expansion. It takes over before the fixed columns would need horizontal scrolling, so the table never scrolls sideways, as today.

### Data-grid pages

Table pages share one pattern, built on ReUI Data Grid (TanStack Table): a toolbar with search,
status filters with counts, dashed facet filters, a density toggle (48 / 36 px rows), a column chooser
and one primary action; sortable headers with an arrow on the active column; checkbox selection with a
select-all mixed state and a floating ink bulk-action bar at the bottom; mono for IDs and dates; status
as dot and text; inactive rows in muted text, never lighter than `#5A6A82`; row actions on hover; a
footer with count, rows per page and pagination.

### Tools at every width

There is no permanent right rail. The assistant has a top-strip button with a status dot; every other
`ui.panels` tool is listed in one Tools menu.

**Hide is not close.** The panel header carries Open separately and Hide. Hide, the top-strip button
and switching tools keep every opened tool mounted with its frame, unsent draft, scroll position and
selected conversation, as Shell does today on collapse. Ending a tool instance is a separate action in
the tool's own menu. The same state survives every layout change: dock to sheet, sheet to phone,
rotation and back.

**The fit rule.** Layout follows what still fits in Shell's own width, so a window beside an agent
behaves like a tablet. Each page has a minimum width — Dashboard 440 px in its compact layout,
Settings and embedded apps 560 px — and the tool panel needs at least 320 px (360 px by default).

| When this fits | Navigation | Page | Tool |
| --- | --- | --- | --- |
| Full navigation + page minimum + tool | Full | Full | Docked, resizable |
| Icon rail + page minimum + tool minimum | Icon rail while a tool is open | Compact layout | Docked |
| Not even that | Icon rail or menu button | Keeps its layout | Sheet over the page, ≥ 320 px |
| Shell narrower than 600 px | Bottom tab bar | Full width | Bottom sheet |

So a 900 px window docks the assistant beside the Dashboard (56 + 440 + 320 px fit) but slides it over
Settings (56 + 560 + 320 px do not).

**Activity.** Each tool reports one state — idle, working, needs you or failed — with an optional
count and label. Reports travel through Core, never only through the tool's frame, so a tool that was
never opened on this device, and a phone, still see them:

- **Identity.** One report per user and tool: the Core user id plus the panel reference the SDK
  already uses (app id, installation id, panel id). A reinstall starts empty; an app may report only
  for users assigned to it, as with notifications.
- **Producer.** The app posts with its service credential to a Core internal endpoint for its own
  panels; the SDK wraps it in a server helper.
- **Freshness.** Working is presence: it expires after the report's time-to-live (60 s by default,
  at most 300 s) unless renewed, and then reads as idle. Needs you and failed stay until the app
  replaces or clears them, or the installation goes away. Core keeps reports in memory; after a Core
  restart apps re-report on reconnect, and the SDK helper resends the current state.
- **Delivery.** Core publishes a `tool.activity.changed` hint on the existing event bus; Shell
  re-reads the user's activity list, following the bus's hint-not-fact contract.
- **No connection.** When Core's readiness reports the providing service as stopped or unreachable,
  the tool shows "no connection" with the time of its last report instead of its last known state.
- **Aggregation.** Shell sums the states by priority: failed, then needs you, then working, so a
  decision is never hidden behind another tool's background work.
- **First provider.** Harness: needs you with a count while approvals are pending, working while a
  run executes, failed when a run fails.

### Phone

- A bottom tab bar holds Dashboard, Apps, Tools and Settings; notifications stay in the top bar.
- App rows keep the runtime status first and append an update after it — "● Running · 0.6.1 →
  0.7.0" — so an available update never hides whether the app is running.
- Tools opens the last-used tool as a sheet above the tab bar; tapping Tools again hides it.
- The sheet header always shows the tool's name, an **All tools** button and Hide.
- All tools groups tools as Needs you, Working, No connection, then a four-column grid of every tool
  with search and Edit (pin and reorder).
- The Tools tab carries a count of tools that need the user, colored by the most severe (red for a
  failure, amber for a decision); with nothing to decide the tab carries no badge, and working tools
  show their pulse in the list.
- With the keyboard open the tab bar gives way and Shell sizes the sheet and the tool frame to the
  visible viewport above the keyboard.
- Everything inside the frame belongs to the tool. For the assistant, Harness owns the approval
  content, pins a pending decision under its own header with a Review action however long the
  conversation, and keeps its composer at the bottom of the frame. Shell owns only the sheet, its
  header, its heights and Hide.

## Harness development page

Owner direction, 2026-10-20, from the `HarnessPage` and `HarnessReview` artboards. The
[Harness development UI](../harness-development-ui/feature.md) is the functional baseline: its
actions, states, ordering, recovery and authorization stay, and this section only changes how they
are presented (D20 applies). Where an artboard shows less than the feature does, the feature wins.

### Layout

The page fills Shell's main area inside the app frame, with Harness's 3 px accent strip. It needs
more width than an ordinary embedded app, so Shell's navigation folds to its icon rail first under
the fit rule. Three columns sit side by side and wrap into one column on narrow widths: sessions
(about 264 px), the conversation (takes the remaining width, its transcript and composer capped at
760 px) and the workspace (about 344 px). A conversation without a Core workspace has no workspace
column; the header's workspace toggle hides and shows it.

### Sessions

- The Sessions heading and count share a row with icon-only **Create app**, **Continue building**
  and **New session** actions on the right, in that order, with accessible names and tooltips. Continue building
  opens its existing chooser. Create app opens its existing form, with creation status and recovery
  inside the dialog instead of a separate toolbar above the conversation. A search field below matches titles and app context; there is no
  separate application selector.
- Filter chips — All, Needs you, Working, Failed — each with its count and the state's shape. They
  only filter; rows keep the feature's order by most recent activity, and a waiting session is not
  pinned above newer work.
- Each session appears once in a flat list, including multi-app sessions. A row has one line:
  an owned workspace's name with a hammer before it, or the conversation title when no workspace
  is attached. Use the same retained name fallbacks as workspace details. Remove the second
  idle/completed/workspace/PR line. Running work has a circular indicator at the right; waiting
  retains its amber diamond and failed its red alert. Idle/completed rows have no activity icon.
  Search includes the displayed workspace name, original conversation title and app context.
  Selection and deletion remain bound to session IDs; delete controls use the displayed label.
  The selected row uses the lime soft fill.
- **External workspaces** becomes one row at the foot of the column, with its count, and opens the
  existing external view; its separation from synchronized conversations is unchanged. The external
  navigation matches the session list: 264 px column, compact single-line 36 px rows, hammer before
  the display name, full-name title and accent selected fill. Omit external task IDs from the rows;
  preserve workspace-ID selection and existing activity order.

### Conversation

- A workspace whose Core workflow closes or blocks new turns has no composer. Preserve the draft
  and attachments for explicit Resume, keep history and changes available, and disable review Ask
  into the unavailable composer. Use workspace workflow rather than agent-turn status in full-page
  and embedded conversations; initial loading and unavailable refreshes must not flash known closed
  input back into view. Ordinary idle/completed chats remain usable.
- The header holds the session title with Rename, the context apps as mark chips with Add app, the
  workspace toggle and the session menu. Its right side places the current session activity badge
  immediately before the read-only Local or Docker badge. Explain native process access for Local
  with a host-access warning;
  describe the Docker worker's container limits without claiming OS administrator privileges or
  confinement for enabled MCP tools.
- A pending decision is pinned under the header — "Needs you · Allow `git push` to update #612" —
  with a Review action that scrolls to the card, however long the conversation. D17 accepts the
  existing pin/composer behavior. The working bar already reports the current step and Stop; D34
  owns the missing elapsed-time contract and dependent display, including reconnect/replay behavior.
- Consecutive transcript tool calls collapse into one **1 tool call** or **N tool calls** section.
  Append a destructive-colored known-failure count beside the call count only when nonzero, such as
  **15 tool calls · 6 failed**, and retain it when expanded. Count each visible call once: use only
  the authoritative command outcome for Bash/Command and the tool result for MCP/other calls, with
  failed status and no conflict. Do not substitute command output status for missing, unknown or
  conflicting command metadata; exclude cancelled, unknown, missing and conflicting outcomes. The section mixes
  commands, MCP tools, reads and edits. Expansion shows flat individual rows in their original
  order, without nested tool-type groups, with each call's input/output and each command's recorded
  outcome. Keep the section stable from its first call as more calls arrive so disclosure state and
  focus survive. Prose, approvals, questions and turns separate sections; approval cards remain
  immediately visible outside them. Individual commands use borderless outer rows with a single-line
  header.
  Bounded outcome, exit code and duration sit on the right immediately before the far-right
  disclosure chevron, matching MCP tool rows, and stay there when expanded. Input/output code blocks
  retain their borders. Generated numeric test summaries and legacy missing-identity explanations
  belong only in expanded details. Expanded command output has no additional outcome-status line;
  unknown/conflicting outcomes stay in its header, while non-command/MCP output retains its only
  outcome indicator.
- Each activity block with recorded edits has an independent collapsible **Changes** sibling of
  Tool calls, with its header visible even while tools are collapsed. Show source-bound file count
  and confirmed aggregate additions/deletions; retain explicit unknown/overflow totals. Expanded
  Changes owns file summaries and existing Review bindings/context. Aggregate only matching recorded
  session/workspace/worktree/repository/path and keep unbound legacy entries separate. The counts
  describe that activity block's edit operations, not the current workspace or net diff; the summary
  is no longer nested inside Tool calls.
- Owner direction, 2026-10-22: expanded per-call details also expose **Tool output**, including
  command output, separately from the retained input disclosure and command outcome metadata.
  Deliver a separate `tool_result` event with `toolUseId`, `status`, `output` and optional
  `truncated`, limited to 32,768 characters of text or serialized JSON. Omit binary payloads,
  `_meta` and transport envelopes. Revalidate the event at worker, coordinator and replay
  boundaries and match results to the same call identity and turn. Show error, unavailable and
  truncation states explicitly; older histories have no output rather than an invented result.
  Render output only inside expanded details using the existing code block's copy and wrapping
  controls. Preserve session isolation and recovery through the existing authenticated stream;
  this adds no Core endpoint or additional polling.
- The approval card has an amber header, the exact command on an ink block, its repository, branch
  and effect, then Allow once (the view's primary action) and Deny…, which reveals an optional
  reason that is sent with the denial. The canvas also shows Allow for this session; that would be a
  new standing grant beyond today's one-time allow or deny, so it stays out until the open question
  below is settled.
- The composer keeps attachments, app mentions and Whisper dictation; its bottom row holds the
  provider and model and the Normal / Autonomous switch. Keep mode explanations in that menu and
  remove the duplicate footer description. The compact circular Context indicator sits immediately
  after the provider selector in both full-page and embedded chat, with used/maximum tokens,
  percentage and observation details in a shared keyboard-accessible tooltip. Preserve the provider
  measurements, unavailable/missing-limit states, replay and session isolation from
  [Harness Context Usage](../harness-context-usage/feature.md).

### Workspace

One column without tabs, top to bottom:

- **Header:** "Workspace", a neutral state chip (In progress, Paused, Completed), the observation
  line ("1 repository · watching · observed 12 s ago"), Refresh, and the menu with Complete, Pause,
  Resume and Delete as the feature defines them.
- **Repository card:** name and bound apps, the branch against its base, Ahead / Behind / Not pushed
  counts (the missing Not pushed observation and dependent display are owned by D35), **Session changes** with its additions, deletions and file count, which opens the review
  page, and Commit…, Push branch and Update PR with the remaining Git actions in a menu.
- **Pull requests:** described below.
- **Preview card:** the sandbox, its running dot and start time, the sandbox address, and a line —
  environment reused, time to ready, its own test users and data — that expands into the launch steps
  with their times. D35 owns the missing history, time-to-ready and child-Core user observations
  and their dependent display; retain explicit unknown/omitted values until verified. Open preview
  and Open test Core stay visible; Restart app, Service logs, Run a
  reviewed check and Stop sandbox move to its menu. Per-service rows, restart requirements and
  failures from the feature remain.
- **Used by — owner refinement, 2026-10-22 (D40):** show compact Bound applications rows for
  explicitly bound, currently installed apps. Keep the real lifecycle state immediately after the app name; a selected
  target or installed source record is not evidence that the process is running or healthy.
  The second line describes the current execution target: package version and concrete runtime key,
  a hammer with the workspace display name, or a Git branch icon with the source branch and
  recorded path as fallback. Keep accessible target labels and full-path tooltips. Keep execution
  selection distinct from installation/update provenance; missing rights or observations remain
  explicit, never inferred as package/workspace use.
  A per-app icon offers Use workspace only when the app is not already on that exact bound worktree,
  with an accessible name and tooltip. Reuse the current authorized generic Core app-management
  reads/actions through workspace-scoped Harness routes; an unavailable permission does not trigger
  automatic approval or a broader grant. Keep group labels short: Use workspace and Return to
  packages fit on one normal-width sidebar row. Show Use only when every bound app is positively
  outside this workspace, Return only when every exact bound worktree is selected, and both for
  mixed or unknown observations. Missing/legacy data, initial loading/errors, another tree in this workspace
  and retained execution requests keep recovery actions visible. Preserve Core confirmation where
  required and the original UUID through uncertain operations and retries.
  Reuse shared SSE refresh for visible consumers and action-triggered reads, without recurring fleet
  polling. Background reads retain the last verified frame and control states until new data arrives,
  avoiding transient Return buttons or disabled per-app icons. Actual errors/disconnects still clear
  stale data. Keep selection/drafts on recovery. Core remains excluded from this bound-app action;
  separate Core activation and folded Activity consumer/lease diagnostics remain unchanged.

### Pull requests

- Every PR of the workspace is a card that collapses on its header. Collapsed, it takes two lines:
  the status icon, the title and the number; then the state word for a draft or merged PR, the CI
  result in its color, and the threads — "Draft · CI passed · not ready for review", "CI 4 of 5 · 1
  running · 2 unresolved threads". Expanded, it adds the state and review chips, a segmented CI bar
  with the passed / in progress / skipped summary, notes such as an unpushed head, and Review changes
  for a PR that is still open or draft.
- The icon's shape names the PR state and its color names CI: an open PR's icon is green when every
  check passed, Info blue while checks run and red when one failed; a draft keeps the muted draft
  icon whatever its CI, and a merged PR the violet merge icon. Closed, unknown and stale states keep
  the feature's icons and neutral color. Green and red describe CI only; review decisions stay in the
  chips. Every icon has its accessible label, and the summary line repeats the state in words.
- The CI bar opens the check list by click only, never on hover, as a popover beside the workspace
  column so it covers neither the cards nor the preview; it closes on a second click or its close
  button and refreshes with new observations.

### Review page

The diff dialog becomes a page of its own. Session changes, an edited file in the transcript and
Review changes on a PR open it; the header's breadcrumb and **Back to session** return to the page
with the conversation, its draft and its scroll intact. Review fills the available application
width; conversation, session navigation and workspace details stay hidden while their state is
retained. External-workspace review returns to its originating workspace selection. It has two columns:

- **What to review:** a picker for Session changes, Since main and each open or draft PR of the
  workspace, the PRs with their status icon and summary line; merged and closed PRs open on GitHub.
  A PR shows its chips and a GitHub link. Below the picker are the totals, the viewed count and the
  file list with additions, deletions, comment threads and a viewed check.
- **The diff:** the file path, its counts, Viewed, previous and next file. The feature's renderer,
  Unified / Split and wrapping stay. Lines that are not yet in the PR head carry a muted stripe.

Review actions:

- **Threads in place.** For a PR, its review threads appear under their lines — from agents such as
  Codex and from people — with the author, whether the author is an agent or a reviewer, the time and
  the replies, an Unresolved state chip in amber and, when applicable, a separate Changed locally
  indicator in Info blue, plus Reply, Resolve and Ask Harness. Changed locally records overlap with
  unpublished changes; it neither claims a fix nor replaces the unresolved state.
- **Select lines.** A click on a line number selects it and a second click or Shift+click extends the
  selection; the numbers fill lime. The selection offers **Ask Harness**, which places a reference to
  those lines — file, line range, source and revision — in the owning session's composer, returns
  to that session and focuses the draft without sending it, and **Comment on
  #N**, which opens a comment box with "Also ask Harness to address it" and posts the comment to the
  PR on GitHub. Lines not in the PR head cannot take a GitHub comment; the bar says to push first or
  to ask Harness.

### Harness on a phone

- The sessions list fills the screen with the same filters and flat session rows, above the bottom tab bar.
- A conversation keeps its pinned decision and its composer above the tab bar; Workspace opens the
  workspace as a bottom sheet over it. Session changes opens the same standalone review screen,
  starting with the file list; each file opens its diff with a Files back action. Back to session
  restores the conversation, and the CI bar expands its check list in place on a tap.

## Environment, Marketplace, settings and app management

Owner direction, 2026-10-21, from the `EnvSetup`, `Marketplace`, `Settings` and `AppManage`
artboards. The owning features stay the functional baseline (D20 applies); the artboards show less
than those features do, and where they differ the feature wins unless a deliverable below changes it.

### Creating the environment

[Hosty initialization](../hosty-initialization/feature.md) now implements manual environment
creation in main. `hosty init` owns the primary CLI journey; Dashboard Create environment owns
child allocation, application selection and installation progress; the child's ordinary Core setup
page registers its administrator after the selected applications are ready. D27 verifies the adopted presentation of these
existing surfaces; D32 owns the remaining parent-journey reference variants. There is no second initializer or repeated app selection inside the child.

Map `EnvSetup`'s four visual stages to that implemented journey:

1. **Choose apps — parent Dashboard.** Keep the visible empty-state entry and creation dialog with
   the environment name, the distribution catalog's actual recommended selections, and the
   existing optional port/resource controls. A Core-only selection remains valid. Preserve capacity
   refusal and selected-app validation; never silently remove an app to fit the environment.
2. **Install — parent environment row/details.** Show actual per-app progress, readiness and
   errors using the design's rows and progress treatment. Keep the supported Resume initialization
   action and durable requests across reloads or a lost response. A running child Core does not
   mean its selected applications are ready. Do not invent a percentage when progress is unknown.
   The artboard's per-app Retry, Show log and Continue without it are not new operations granted
   by this restyle: expose only actions the initialization contract actually supports. A change
   to the accepted selection uses that feature's explicit review flow where available.
3. **Administrator — child Core.** Set up administrator obtains a fresh setup link and opens the
   child's normal registration form. Keep explicit link/token copying and renewal for an expired
   link. Credentials stay in the child registration flow; the parent does not collect or retain
   the child's password. Reuse the already adopted Core confirmation design.
4. **Open — actual child destination.** After registration, offer the child's Shell when installed,
   or the existing CLI/API guidance for Core-only environments. Clearly distinguish this child
   from the main instance. Keep Stop/Restart and Finish/delete with their existing retention and
   cleanup meanings, confirmations and error recovery.

Use the initialization feature's authoritative defaults, readiness, authorization and endpoint
projections. Preserve existing-instance behavior and independent child users/data. Its remaining
published-distribution and platform acceptance is tracked by D10–D11 in the
[initialization plan](../hosty-initialization/plan.md); D27 separately verifies the redesigned
parent-to-child UI without duplicating those deliverables.

### Marketplace

Inside Shell's frame with Marketplace's accent strip. The standalone storefront and settings
page omit the redundant SDK navigation rail. The storefront has no repeated Marketplace title or
description; Settings belongs beside the catalog source and remains reachable while source data
loads or fails. Remove global Refresh while preserving explicit failure retries, cached-content
recovery and detail Refresh.

- A header with the catalog source and a search field over names, publishers, summaries and
  categories; Discover and Installed tabs with counts.
- **Discover:** category chips (All, Productivity, Media, Monitoring, Home) and a grid of cards —
  the app's own icon, name, publisher, summary, category, and Installed or the available update.
- **App card:** beside the grid, the selected app's icon, name and signer, its category, version and
  footprint, Install (or Update and Manage when installed), screenshots, description, and the
  permissions it will ask for in plain words, ending with the note that Core confirms runtime,
  startup and permissions on its own page.
- **Install** opens the shared SDK install dialog: feed and manifest checked, defaults prepared,
  waiting for confirmation, and Continue in Core to the existing confirmation page.
- **Installed:** every app on the host, wherever it came from — version, source (catalog or Hosty
  distribution), an available update, Open and Manage.

Catalog examples are not additional data contracts: the current detail response has signer,
screenshots, description and feeds, but no footprint or permission summary. Display those only
when the existing authoritative APIs provide them for the selected artifact; otherwise omit the
field or show it as unavailable. Do not infer trusted permissions from catalog prose or invent a
download size. Any required new metadata contract needs explicit scope before implementation.

### Settings

Settings keeps its own navigation inside the page, so Shell's sidebar holds a single Settings entry:

- **You:** My profile — Profile, Connections, Tokens & devices.
- **Host:** Host — Updates, Network, Shared folders, Core source; Users & security — Users, App
  permissions, Policies; Shell — preferences such as theme, the Assistant button and the start page.
- **Apps:** individual apps with a declared app-owned `ui.settings` surface. Each entry opens that
  embedded Settings page with its own internal navigation and existing access checks. There is no
  duplicate installed-app catalog or general App settings entry; Dashboard opens host-managed
  App Details.

Each destination has a title, a one-line description and line tabs (lime strong underline). Rows
use the field pattern — label column, value with a muted note, one action — and lists use bordered
row groups. Protected changes keep the feature's Core confirmation and say so in place.

### Managing an app

Addressed from Dashboard at `/apps/<app-id>?section=<section>`, outside Settings, with a
`Dashboard / <app name>` breadcrumb linking back to `/dashboard`. Former settings Manage bookmarks
migrate with their requested section preserved. The header holds the mark, name, version and
runtime, the state name with its detail, and Open app, Restart, Stop and More. Tabs:

- **Launch:** Start with host (the same setting as the Dashboard menu), the runtime with a link to
  the Dashboard row's More > Runtime / workspace submenu where existing runtime/source switching lives, what the app starts after,
  and its services with state and resources.
- **Logs:** after Launch when the app declares logs; preserve the existing console tail of 200 lines,
  explicit Refresh, per-service selection, aggregate-text fallback and visible empty/error states.
  Dashboard Logs, More > Console logs, readiness and update-notification links select this
  addressable section rather than opening a runtime-app popup. Fetch only while selected, abort
  obsolete app/user/Core requests and keep the other forms mounted with their drafts. Preserve
  Core's existing authorization; a logs-only ordinary-user entry adds neither management controls
  nor a grant to read administrator-only logs. Core console logs keep their separate dialog.
- **Parameters:** the manifest's typed parameters with units and notes, secrets as masked values
  with Replace, Save and Discard. Saving configuration does not restart services automatically;
  describe the actual effect and retain the explicit Start/Restart path.
- **Folders:** the data folder with its size and backup inclusion, and the folders the app asks for —
  attached with path and access, or optional and unattached with Choose folder — noting that attached
  folders are never backed up or deleted.
- **Network:** each endpoint with its protocol, local address and public address, internal endpoints
  with Add public address, pinned ports with Reassign, and the app origin.
- **Permissions:** granted Core permissions in plain words, confirmed provider roles, and Review
  permissions, which opens Core's review page.
- **Updates:** an available update as an Info panel with its class, permission change and size, and
  Update; what changed; the installed version and feed with Check now; the currently supported
  update behavior; and the source with Use a source checkout. The illustrative Install routine
  updates preference does not add an automatic-update policy.
- **Backups:** what backups cover, Create backup, the list with Restore and Delete, and the existing
  cleanup preview/apply and retention status. The 14-day per-app retention editor, scheduled backup
  examples and Download action are not implemented controls; do not add them as part of this restyle.

The Telemetry parameter values and mounts in `AppManage` illustrate generic form patterns; render
the selected app's actual manifest/configuration, including an empty Parameters state. Telemetry
currently declares no app settings. Age-based rules and per-app overrides belong to the separate
[backup retention plan](../app-data-backup-retention/plan.md), which this redesign does not approve.
Preserve the existing manual-backup stop/restart explanation and restore/cleanup confirmations.

## Interactions With Existing Features

Implementing this plan changes documented behavior; each owning `feature.md` follows in the same PR as
the deliverable that changes it.

- [Resizable Shell Panel](../shell-panel-resize/feature.md) and
  [App UI Surfaces](../app-ui-surfaces/feature.md) retain frame/draft/selection behavior under the
  adopted top-strip launcher, separate Open/Hide actions and fit-rule dock/sheet layout. D11 is
  complete; D12/D13 verify embedded and phone transitions rather than implementing another rail.
- [SDK UI Composition](../sdk-ui-composition/feature.md) and
  [SDK Panel System](../sdk-panel-system/feature.md) own child tool-launcher negotiation. The adopted
  Assistant/Tools controls must keep honoring enabled/hidden policy. Existing readiness/attention
  remains distinct from D15's still-unimplemented Core-backed working/activity contract.
- [Shell Navigation](../shell-navigation/feature.md) owns the adopted sidebar/top-strip and phone
  tab layout. D12/D13 accept its responsive behavior; D18 separately replaces remaining legacy
  System labels with confirmed role visuals.
- [Replaceable UI Clients](../replaceable-ui-clients/plan.md) D8 owns showing confirmed role badges
  from Core facts for all installed apps. This plan supplies only the role icon set and the chip
  (D18); D8 decides where role data comes from and when it appears.
- [Core App Shell](../core-app-shell/feature.md) and
  [Shell Navigation](../shell-navigation/feature.md) own the adopted Dashboard identity/status/
  resource/actions composition, More menu and fleet toolbar. D7 verifies their retained behavior;
  remaining status-semantic consumers belong to D6 and compact filters to D8.
- [Core Event Bus](../core-event-bus/feature.md) gains a `tool.activity.changed` event; its
  hint-not-fact contract is unchanged.
- [Notifications](../notifications/feature.md) remain the durable channel; a tool activity state is
  live presence, not a notification. [Shell Operation Feedback](../shell-operation-feedback/feature.md)
  keeps its placement.
- [Assistant Entry Points](../assistant-entry-points/feature.md) and
  [Assistant Approval Rules](../assistant-approval-rules/feature.md) stay owned by Harness; D17 accepts
  the implemented pinned decision/composer and its integration with D15, which still owns Core-backed
  activity reporting and Harness as the first provider.
- [Harness Development UI](../harness-development-ui/feature.md) documents the page D21–D26 restyle.
  The current workspace implements the review page, External workspaces row, collapsible PR cards
  and whole-icon CI color with Info blue for running checks. D21–D26 are acceptance gates; extracted
  implementation and contract gaps remain explicit in D33–D37. Session order stays based on most recent activity,
  with waiting sessions not pinned.
- [Assistant PR Lifecycle](../assistant-pr-lifecycle/feature.md) already observes review threads
  with their IDs, paths, lines and bounded comment text, including author/kind/time, and owns
  the implemented review threads and resolution.
  D24/D25 verify the existing reply/resolve/new-comment operations through the selected GitHub
  connection; D37 owns the remaining mixed-account source-grant validation work.
- [Delivery Readiness](../hosty-delivery-readiness/plan.md) keeps its priorities: D21–D26 follow its
  incremental-redesign rule and are not demo gates unless the owner promotes them there.
- [Hosty initialization](../hosty-initialization/feature.md) integrates
  [Removable System Apps](../removable-system-apps/feature.md),
  [CLI Bootstrap](../cli-bootstrap/feature.md), [child environments](../app-sandbox-runtimes/feature.md)
  and [Local Password Login](../local-password-login/feature.md). It owns selection, durable
  initialization/retry semantics, setup authority and completion. D27 accepts the adopted parent
  Dashboard and child registration journey; D32 reviews the remaining visual variants. Remaining distribution/platform acceptance
  belongs to its plan, rather than blocking design mapping or being silently marked complete here.
- [App development controls](../app-development-controls/feature.md) and
  [workspace activation](../workspace-live-activation/feature.md) retain source/runtime authority,
  destination validation, readiness and Return behavior. D7 verifies the adopted Dashboard entry
  points; the selector in More grants no new switch and bypasses no review.
- [Runtime App Marketplace](../runtime-app-marketplace/feature.md) shows installed badges from
  Core's installed-state API; the adopted Installed view and in-page responsive detail pane use the
  same authorized data. D28 retains its full acceptance boundary.
  [App Installation SDK](../app-installation-sdk/feature.md) keeps its dialog and Core confirmation.
- [Settings Experience](../settings-experience/feature.md) owns personal/host settings and embedded
  app-owned settings. App Details groups Launch, capability-gated Logs, Parameters, Folders, Network,
  Permissions, Updates and Backups outside Settings at `/apps/<app-id>`, with Dashboard breadcrumbs
  and migrated `manage:<app-id>` bookmarks. D29/D30 retain their responsive, permission and functional
  acceptance. Protected-change reviews, ownership and independent drafts stay unchanged.
- [External Mounts](../external-mounts/feature.md), [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md),
  [App Permission Management](../app-permission-management/feature.md),
  [Runtime App Update](../runtime-app-update/feature.md) and
  [App Data Backup Retention](../app-data-backup-retention/feature.md) own the behavior behind
  D30's Folders, Network, Permissions, Updates and Backups tabs; D30 accepts their adopted
  presentation without changing those contracts.

## Deliverables

IDs D1–D32 retain their original obligations or explicitly delegate extracted work below. No ID is
renumbered or reused. Acceptance items refer to the detailed target sections and current feature's
Testing Expectations rather than repeating completed implementation as new work.

### Remaining Implementation

- [x] D1. Finish Shell control-token conformance: the D44 mount/control adoption and shared Field selected state use lime selection tokens. Preserve one 2 px lime (`#A3E635`) focus treatment without halo, red invalid states and parent-only grouped focus. Focused control-flow checks, lint and the production build pass; D16 separately owns measured accessibility acceptance.
- [ ] D3. Complete the deferred native AppIcon adoption and its independent Swift version outcome when the owner reopens native scope. The web portion is implemented: canonical SDK/shared mark geometry, generated light/dark/icon/favicon cuts, outlined IBM Plex Sans 600 lockups, tokens/README and Shell public assets. Web-only generation preserves native outputs. D31 consumes the shared source; Shell and SDK version outcomes remain with the current web batch.
- [ ] D4. Complete remaining Plans/Telemetry/Demo App chart accents, required distinct-series swaps and own-app empty artwork. Telemetry swaps Hosty Blue with chart-2 and Demo App with chart-3; retain the implemented Harness/Marketplace chart-4 swaps and Shell Hosty Blue. Preserve baked ink tiles in both themes and appropriate dark-card separation. Seven manifest cell icons are already implemented. Frame strips and tool accent treatment depend on a reviewed and approved outcome of D39; D14 owns tool-icon composition and D10 owns placement of empty states.
- [x] D5. Demo App and Telemetry use theme-legible external navigation SVGs while preserving their manifest paths and navigation behavior. Demo neutral strokes measure at least 3:1 on the adopted light/dark surfaces, and Core-managed Shell rendering confirms the external artwork. Telemetry retains its earlier verified neutral strokes; neither app relies on inherited `currentColor` through an external image.
- [ ] D6. Finish status-semantic and motion adoption: keep Info-blue labelled working, amber needs-you, red failure and distinct state shapes; replace remaining neutral active-update/transition indicators. Working motion becomes a static ring under reduced motion, and lime remains an interaction/progress color rather than a data-chart series. D16 owns the full contrast/grayscale acceptance pass.
- [ ] D8. Complete the remaining compact Dashboard state-filter menu, selected by container width. Responsive rows, resource reflow and compact Install already exist. Retain combined search/filter semantics, counts, keyboard/touch access and selected state; D7 accepts the rest of Dashboard.
- [x] D9. Build the ReUI Data Grid pattern for current-user Tokens & devices: the specified search/filtering, sorting, density/column controls, selection/bulk behavior and pagination. Preserve existing credential visibility, Create/Connect/Rename/Revoke authority and recovery. Current-user navigation stays under My profile; authorized support for another user stays in that user's detail.
- [ ] D10. Complete remaining labelled grid-loader and empty-state placement, including environment inventory, unavailable service observations and shared-mount empty results. Keep factual loading/error/empty/no-results distinctions, static reduced-motion behavior and theme contrast. D4 supplies app-specific empty artwork; working/status indicators remain separate data.
- [ ] D14. Apply the tool's Lucide icon and owning-app accent badge consistently in menus, pickers and panel headers after D39 settles its metadata source and fallback. Do not replace supplied icons or introduce app-ID color overrides.
- [ ] D18. Replace legacy System labels/presentation with confirmed provider-role icons and detail chips for `ui-client`, `assistant`, `speech-to-text` and `otlp-collector`, including the reserved icon set. Consume authoritative role facts owned by [Replaceable UI Clients D8](../replaceable-ui-clients/plan.md#deliverables); this design item does not duplicate that contract, infer roles from `system` or grant lifecycle authority.
- [ ] D19. Adopt the shared light/dark theme, local IBM Plex Sans/JetBrains Mono, lime interaction/selection/focus/progress and app chart accents in Plans, Telemetry UI and Demo App. Shell/Harness/Marketplace theme foundations and Harness's local typography scale already exist; preserve app-owned typography inside SDK workspaces. Finish residual control conformance across all adopted first-party app controls, including Harness/Marketplace inside the SDK host: one 2 px lime focus indicator, red invalid states and parent-only grouped focus. Preserve D4's distinct chart series and independent artifact versions.
- [x] D31. Adopt the supplied access-card/banner and installation-flow designs in SDK-owned surfaces, preserving the implemented chrome-only font reset and app typography ownership: typography, palette, cards, buttons, progress, rail/chooser focus and responsive light/dark layout. Use D3's shared mark. Preserve identity/access, installation contracts, drafts, popup fallback, supplied-source shortcuts, cancellation/retry and truthful installed/configured/running outcomes. Coordinate concurrent SDK work, verify through Core-managed Shell/Marketplace and bump `@hosty-sdk/app` for package changes.
- [x] D33. Add distinct list/decision/working/failure shapes to Harness's All/Needs you/Working/Failed filter chips while preserving counts, selection and filtering. Focused mixed-state/search/order tests and managed light/dark/narrow rendering pass; existing row projections and ordering remain unchanged.
- [ ] D38. Resolve and complete the existing Phone design's All tools Edit/pin/reorder controls, separately from accepting the implemented picker in D13. Confirm the supported pin/order scope and persistence before implementation, preserve app grouping/search/access and document the decision. This does not approve a fifth phone tab or other optional navigation changes.

- [x] D41. Correct read-only metadata for a linked external PR whose source branch differs from the current workspace, including the reported #631 case. Preserve owner, selected account, repository and PR-URL authorization; title/state/CI display is not review, merge, completion or cleanup evidence. Keep existing exact-source/head guards for those operations. D36 separately owns historical original-source review binding, and D22 retains real-provider card acceptance.
- [x] D42. Unify the existing Host settings Updates, Network, Shared folders and Core source content with the accepted Core information Frame and Dashboard surfaces. Preserve navigation, every field/action, drafts, protected changes, mount bindings and source/restart ownership; verify light/dark, narrow layout and existing functional coverage.
- [x] D43. Align Background app access with the credential Frame/table, preserve scoped grant history and actions, and make account-wide revocation prominent in the personal Tokens & devices section with clear consequences and existing Core confirmation. Verify own-administrator visibility, cancellation/failure/actor-change behavior and light/dark/narrow layouts.
- [x] D44. Normalize Shell dropdowns and input controls to the shared shadcn/Radix components, including generic Core settings, mounts, invitations, address controls, tool instances and source options. Preserve empty/unknown values, validation, keyboard/label behavior, form payloads and authority; audit remaining native controls and verify affected flows in a managed test Core.
- [x] D45. Remove the duplicate Apps overview component/view and catalog navigation entries; keep a non-clickable Apps heading and directly accessible app rows. Resolve retired URLs and role-aware home/close fallbacks without loops, retain ordinary-user blank home and app/profile access, and verify sidebar/phone behavior and protected app removal through its remaining Dashboard/Manage entries.
- [x] D46. Use one prioritized contextual action for application and Core rows, with Restart before runtime-health Logs and ordinary controls; give Core the shared title badge and an audited administrator/CSRF-protected instance-bound light stop. Preserve apps, prevent conflicting lifecycle operations, retain original restart/confirmation guards, and verify action matrices plus stop admission/recovery in an isolated managed Core.

- [x] D47. Update the four authorized web consumers to Next.js 16.4.1 and matching ESLint tooling, preserving React and frozen app declarations. Verify clean dependency resolution, all four production builds, affected lint/tests and Core-managed runtime readiness; retain the current redesign changes and independent artifact versions.


### Contracts And Dependent Work

These items expose remaining backend/SDK or timing dependencies, rather than treating them as
cosmetic acceptance. Documentation reorganization alone approves none of the unresolved contracts;
record the contract review before dependent code and preserve existing safe behavior meanwhile.

- [ ] D15. Complete the Core-backed tool-activity contract and dependent Core/SDK/Shell/Harness integration described under Tools at every width: per-user installation/panel identity, assigned-user app-authenticated reporting, SDK server helper, working TTL, reconnect/re-report after Core restart, `tool.activity.changed` hint delivery and readiness-derived No connection. Implement severity aggregation, the Assistant indicator, phone activity-priority groups and Tools badge, with Harness as the first provider. Existing opened-frame attention is not completion. Verify unopened/second-device delivery, TTL, reconnect, installation/user isolation and failed-before-needs-you-before-working priority.
- [ ] D34. Define and review authoritative elapsed-time semantics for the Harness working bar, then implement and verify the dependent display. Specify turn versus step start, reconnect/reload, hidden/background time and unavailable timestamps. Preserve current activity/Stop and do not substitute component mount time or infer elapsed time from unrelated events.
- [ ] D35. Resolve and separately scope the missing workspace/preview observations and dependent presentation: Not pushed, full preview launch history, time-to-ready and child-Core test-user totals. Define source, meaning, freshness, visibility and unavailable states with the owning Core/Harness features; preserve the distinction from existing app-sandbox user counts. Any retained target requires reviewed projections, Harness display and acceptance, not just DTO names. Keep unknown/omitted values until that work is verified; an explicit owner decision is required to remove an existing target.
- [ ] D36. Design the retained original branch/source binding for historical PR review and scope its implementation separately. Preserve workspace ownership, selected account, repository/head validation, immutable published coordinates and explicit refusal/GitHub fallback when old evidence cannot be validated. Do not infer a branch from the current worktree or weaken provider checks. D23 accepts current supported scopes; the historical extension needs its own reviewed implementation and provider acceptance before being claimed complete.
- [ ] D37. Complete safe mixed-account private-source grant validation for the existing new-comment publication operation. Preserve the PR's selected GitHub connection and operator authority; validate each source grant without recursive credential-lock acquisition or borrowing another account's credentials. Cover mixed-account admission, revocation, stale bindings and original-request recovery with focused tests. Current refusal stays until verified; D25 owns real-provider new-comment acceptance and D24 owns reply/resolve acceptance.
- [ ] D39. Decide and review the source and transport of app accents for frame strips and tool badges, including validated palette values, absent/unknown/third-party fallback and identity/access boundaries. Reuse app-owned metadata where supported; no Shell first-party app-ID override is authorized. Scope any required Core/SDK contract implementation and tests explicitly before D4/D14 consume it. The existing manifest icon contract is already implemented and remains unchanged by this decision.

### Acceptance Of Implemented Behavior

- [x] D51. Complete focused Harness connection-loss, expired-login and explicit Retry acceptance with retained text/attachments/review drafts and no automatic mutation replay. Resume authenticated conversation reads from the durable cursor after verified same-actor recovery, bound stalled recovery operations, and preserve one durable identity for an uncertain message send. Verify regressions, affected builds and normal Core-managed embedded browser recovery.
  - Verified 2026-10-24: 1,567 Harness and 695 SDK tests pass; affected lint/typechecks, SDK build, Next.js production builds, Docker builds, documentation and version checks pass. Native embedded Chrome acceptance retains the selected idle chat, text and native file across actual Offline/Retry and expired app authorization. Lost-acknowledgement admission and no duplicate dispatch are verified with HTTP/manager/UI fixtures, without additional provider turns. Owner Finish removes the child, private data and labelled resources. The separately approved ordinary Harness-only restart serves the final recovery controls with healthy API/worker; Core and Shell retain their process identities.


These items are verification gates, not instructions to rebuild the existing pages. Preserve the
current redesign version outcomes; this documentation-only cleanup changes no artifact version.

- [ ] D7. Accept the implemented Dashboard against its target section and current feature: common columns, source/version metadata and inline file counts, concrete production runtime names, runtime/health versus update progress, contextual actions and More, five-minute resources, App Details/Logs navigation, Core information relocation and supported Runtime / workspace handover/Return. Verify long/missing/stale data, mouse/keyboard/touch, roles, protected-flow recovery and retained actions. Resources/actions use approved 192/184 px columns and the contextual action has a 144 px maximum. Remaining compact filters belong to D8, role visuals to D18 and token/status residuals to D1/D6.
- [ ] D12. Accept the implemented fit rule through Core-managed embedding: Dashboard minimum 440 px, Settings/embedded-app minimum 560 px and tool minimum 320 px. Verify full-nav/rail/dock/sheet/phone transitions, resizing and rotation with retained frame, draft, scroll and selected conversation. Existing 599/600 px unit coverage does not replace actual embedded or mobile keyboard acceptance. A future manifest-defined minimum is an unapproved extension, not a blocker to verifying these defaults.
- [ ] D13. Accept the implemented below-600 px phone tabs, retained last-tool sheet, All tools search/app grouping, visible viewport sizing, second-tap hide/reopen and long forms on iOS Safari/Android Chrome. Verify keyboard pan/safe areas, rotation, focus and retained drafts with 16 or more tools. D15 separately owns unimplemented activity-priority groups/severity badges, and D38 owns Edit/pin/reorder.
- [ ] D16. Complete measured Shell light/dark contrast, grayscale, reduced-motion and disabled/unsupported-state acceptance across text, tinted surfaces, primary-colored text/borders/dots and focus. Shared semantic tokens and successful builds do not prove every consumer passes. D1 owns control conformance; D6 owns status semantics/motion. The approved exact lime focus remains 1.51:1 against white; resolve its design constraint before claiming full focus-contrast acceptance.
- [ ] D17. Accept Harness's implemented pinned approval/question Review navigation and bottom composer through embedded/phone layouts. Verify the first-provider integration once D15 supplies Core-backed activity; preserve visible pending decisions while another tool works and on a device that never opened Harness. Existing frame-local attention is not this integration.
- [ ] D20. Complete functional-parity acceptance against the inventory above and the owning features: every supported action/state, role/permission, route, independent form/draft, selection, retained panel and failure/recovery flow remains reachable. Check existing ReUI primitive/wrapper reuse and document concrete unsupported-control exceptions. Moving actions into menus does not permit losing keyboard/touch access or changing authority.
- [x] D50. Preserve the real Codex file-change proposal in Harness approvals by correlating exact active thread, turn and item identity before persistence. Bound and clear retained proposals, refuse stale cross-turn matches, and verify the real request shape that omits changes from the approval request. Keep approval authority and single-request semantics unchanged.
- [x] D49. Repeat fresh local actor/source admission immediately before GitHub reply and resolution mutations, including after delayed provider reads. Verify actual saved-state role/source revocation, cancellation and durable request recovery in isolated Core tests; preserve selected-account bounds and D37's explicit refusal. Build the exact Core project and verify the scoped fix before any separately authorized live restart.
- [x] D48. Correct Harness multi-view transport cleanup and request starvation: use authenticated, per-view WebSocket delivery for browser events, dispose subscriptions admitted after disconnect and pause hidden session streams. Preserve origin/actor checks, expiry, bounded buffering, drafts, durable replay and normal recovery; verify authorization/cleanup races and concurrent standalone/embedded requests in an isolated Core-managed sandbox.
- [ ] D21. Accept the implemented Harness navigation, conversation, cards, menus, approvals and composer through real providers and Core-managed embedding in light/dark/narrow layouts. Preserve the verified D48 concurrent standalone/embedded transport regression; complete the broader normal Retry, interrupted silent sign-in/frame reload recovery, frame interaction and authority/revocation matrix without weakening actor, origin or grant checks. D48's synthetic idle conversations do not complete real-provider acceptance.
  - Verify mixed activity sections, flat call order, canonical nonzero failure counts, result identity/turn isolation, retained disclosure/focus and visible decisions. Exercise existing bounded tool output, input/copy/wrap, empty/error/conflict/truncation, legacy replay and worker/coordinator recovery; no new output event implementation is requested here.
  - Verify borderless command headers and far-right chevrons, factual status/exit/duration, expanded-only numeric/legacy details and no duplicate command outcome. Verify independent Changes/Tool calls disclosure, visible Changes headers with tools collapsed, per-activity source-bound file counts/confirmed totals, unknown/legacy states and retained Review bindings.
  - Verify icon-only session actions, retained workspace/title/app search, activity filtering, flat rows and deletion focus; context ring after provider, unavailable/missing-limit/replay states; factual Local/Docker header badges and autonomy details only in the mode menu. Preserve menu confirmations/logs/recipes and original-request recovery. D33/D34/D35 own the missing chip shapes, elapsed time and observations separately.
- [ ] D22. Accept implemented collapsible PR cards, whole-icon CI semantics, click-only checks and review actions through the real provider. Verify cached/stale/unknown/closed/draft states, merge/observation times, CI/thread totals and refresh, preserving owner/connection/repository/head bounds. Historical evidence is never merge authority. D41 owns the outstanding other-branch linked-PR metadata fix.
- [ ] D23. Accept the implemented standalone review page, transcript/session/PR entries, hidden but retained conversation, Back/Ask return and focus, scope picker, Viewed, thread totals, Unified/Split, wrapping and unpublished RIGHT-line markers. Verify immutable merge-base/head and current working scopes, exact-source evidence and stale/unsupported refusal. D36 owns historical original-branch binding; keep its explicit current refusal/GitHub fallback rather than relaxing validation to pass acceptance.
- [ ] D24. Accept side-specific line/range selection, structured Ask Harness, author/time metadata, file/range/outdated threads and explicit replies/resolution on a disposable bound PR through a normally authenticated embedded session. Verify stale heads, unplaceable feedback, permission revocation, retained drafts and original-command recovery. Changed locally remains distinct from Unresolved and never resolves a thread automatically.
- [ ] D25. Accept the implemented new-comment UI and Core publication operation on a disposable bound PR through the selected GitHub connection and operator's authority. Verify CSRF, published head/line bounds, stale or unpublished-coordinate refusal, optional Ask Harness handoff, cancellation, revocation and original-request recovery. D24 owns reply/resolve acceptance; D37 owns the remaining mixed-account source-grant implementation, whose refusal remains explicit until verified. Do not recreate the existing publication operation.
- [ ] D26. Accept implemented Harness phone sessions/conversation, pinned decisions/composer, retained workspace sheet, file-list/file review and inline CI expansion. Verify actual embedded focus, keyboard, safe areas, long menu/thread/comment content and provider workflows on mobile devices, not only resized desktop fixtures.
- [ ] D27. Accept the adopted parent environment dialog/inventory/progress and child registration/open journey: actual selected-app readiness/errors, Resume, durable requests, renewed setup links and clear child-versus-main identity, including Core-only completion. No skip/per-app retry/log operation is added. D32 owns reference variants; initialization distribution/platform acceptance stays in its owning plan.
- [x] D28. Accept implemented Marketplace catalog/detail/Installed and standalone/storefront/settings through Core-managed Shell: light/dark/narrow/permission states, selected feed across resize, source/detail failure and stale/closed reads, session expiry and SDK/Core install handoff. Verify authoritative installed metadata, aligned version/actions, Open/Manage, source-adjacent Settings in loading/failure, removed redundant rail/heading/global Refresh, explicit cached-content retry and retained detail Refresh. Unsupported footprint/permission facts stay omitted.
- [ ] D29. Accept implemented Settings navigation, titles, tabs and fields in light/dark/narrow layouts across roles, keyboard, independent drafts and protected-review cancellation/conflicts. Verify the already removed installed-app catalog, individual declared `ui.settings` entries with embedded authentication/internal navigation/full-height forms, former app-setting bookmarks and `tab=apps` migration to Dashboard. Do not repeat the catalog removal as new implementation.
- [x] D30. Accept implemented standalone App Details at `/apps/<app-id>`, role-aware breadcrumbs, legacy Manage migration and section deep links. Verify Dashboard/notification Logs entries, capability gating, selected-only console reads/Refresh/service selection/empty/errors/aborts and Core's separate log dialog. Exercise Launch/services, Parameters, Folders, Network, Updates, Permissions and Backups through existing authorization, stale/error/revocation recovery and retained feed/source/account drafts. Preserve ordinary-user logs-only access, manual save/restart and Core-owned protected reviews; no automatic-update policy, resource/size contract, scheduled backup or download/retention editor is introduced.

### Remaining Design References

- [ ] D32. Complete and review the missing parent environment creation/inventory, responsive/failure/unsaved-draft variants for demo pages, then shared operational dialogs and Plans/Telemetry references. Reuse the existing Core/SDK/Harness/Marketplace/Settings/AppManage/EnvSetup references and functional contracts. This item prepares designs only; additional layout implementation requires concrete scope.

### Completed Deliverables

- [x] D2. Shell loads local IBM Plex Sans and JetBrains Mono through its shared typography tokens, with the recorded Shell version outcome. Core forms remain owned by Core confirmation design.
- [x] D11. The permanent right tool rail is replaced by the top-strip Assistant/Tools launcher; Open separately, Hide and ending a tool instance remain distinct, with frames/drafts/scroll/selection retained.
- [x] D40. Compact Bound applications rows show factual lifecycle state and current execution targets, exact-worktree per-app Use workspace icons and retained group actions. Workspace-scoped Harness routes project existing Core app-management data and preserve authority, access review and original-request recovery; visible rows reuse shared SSE. Focused tests, lint and the web build pass. Read-only authorized Core-managed preview checks confirm current-workspace/package rows, action visibility and narrow layouts; per-app dispatch/review/recovery is verified by contract/UI fixtures, not a live switch. Core/SDK/manifest contracts and the existing Harness batch version remain unchanged; broader acceptance stays in D20/D21/D26.

## Open Questions And Decision Owners

Only unresolved choices remain here. Each retained target has an unchecked deliverable; this list
does not create implementation approval or hide additional work outside the checklist.

- D32 owns review of EnvSetup's visual mapping onto the existing parent creation/progress and child
  registration/open journey. Initialization authority/order/recovery are established contracts.
- D39 owns accent metadata for strips/badges. No per-app substitution table is authorized.
- D34–D36 own elapsed-time, missing observation and historical-binding semantics and the explicit
  review boundary before dependent implementation. D37 owns the already identified mixed-account
  source-grant gap without broadening provider authority.
- D38 owns All tools pin/order scope and persistence. A fifth phone tab and an Assistant keyboard
  shortcut such as Cmd+J remain optional proposals, not approved redesign deliverables.
- Allow for this session is not approved. Any standing approval grant needs a separate contract for
  scope, display, revocation, persistence/audit and consistent Claude/Codex behavior; existing
  one-time decisions and Autonomous mode remain the current design.

Settled choices are not reopened: fleet Check updates remains in the Apps toolbar's More menu;
192/184 px resource/action columns and a 144 px contextual-action maximum follow the owner's latest
widening; page minimums use D12's existing defaults for acceptance. A future manifest minimum is a
separate contract proposal.

## Review Implementation Decisions (2026-10-21)

- Approval events do not supply factual repository/branch labels for every provider. Keep the exact
  command and existing tool context without guessing them; no standing session grant is added.
- Historical PR summaries are cached display evidence. Original historical branch binding remains
  scoped by D36; provider refusal must remain explicit.
- Session changes includes committed and uncommitted changes from the original preparation base;
  Since target uses the cached target merge base. Working contents are labelled explicitly.
- New comments post individually from the published PR diff. Unpublished working-line coordinates
  are never treated as GitHub coordinates; the operator can push or use Ask Harness.
- Review mutations use only the workspace owner's selected source account; administrator inspection
  does not borrow another user's provider credentials.
- Full D23/D24/D25 acceptance still requires a disposable bound PR and a normally authenticated
  embedded session. The current redesign workspace has no bound PR; fixture coverage does not
  establish actual account scopes or organization policy.

## Verification

Compare changed screens against D20's functional inventory through Core/Shell, including actions absent from mockups.

- `node scripts/docs-index.mjs --check` passes.
- Changed React screens use existing ReUI primitives/wrappers for standard controls; custom-control
  exceptions identify a concrete unsupported interaction. Menus, forms and dialogs retain keyboard,
  focus, validation and touch behavior; Core's native forms preserve their submission behavior.
- For future implementation deliverables: affected lint, type-check builds, tests and artifact
  version changes follow AGENTS.md. Documentation-only changes run index/link/whitespace checks,
  with no artificial runtime build, lifecycle change or version bump.
- Focus uses exact lime (`#A3E635`) as one thin 2 px outline/ring in both themes, without an ink
  edge. Other lime text, icons and hairlines on light surfaces use the stronger tokens; lime fills
  carry ink or a lime-strong edge, except progress bars, whose label carries the value, and the lit
  cells of the Hosty and app marks.
- The whole version/source and runtime metadata line is monospaced. No app row displays a Manual start marker; autostart controls remain in More and Manage Launch. Source labels
  use a decorative hammer/Git icon before the workspace or branch name, dotted text and no type
  prefix, highlight or extra padding;
  Core matches app rows' muted text-xs styling. Verify `SourceChangeSummary` after the source name
  on that same second line for Core and source/workspace apps, separated by a dot, with natural
  narrow wrapping, factual additions/deletions, the `files` label, `+` truncation and omitted
  unavailable totals. Confirm no development pseudo-runtime words or orphan separators, unchanged production names,
  hover/keyboard/click/touch details and one pending lifecycle label alongside separate configuration
  and restart-needed information. Verify one visible 2 px lime (`#A3E635`) focus indicator on
  app-owned controls, including inside the SDK host, without a halo or ink edge; retain red
  invalid/error treatment and parent-only lime/red grouped-input focus. SDK-owned rail and chooser
  controls follow the completed D31 adoption; broader control acceptance remains in D1/D16.
- Contrast checks for every text and status token pair in light and dark, and every state checked
  with `prefers-reduced-motion` and in grayscale to confirm it differs by more than color.
- Activity, after D15 integration: a pending Harness approval reaches the Tools badge on a second device that never opened
  the assistant, survives another tool's background work, comes back after a Core restart, and turns
  into "no connection" when Harness stops.
- Browser checks through Core-managed Shell in light and dark at both sides of every layout switch:
  599/600 px, and the widths where each page's minimum plus the tool minimum stops fitting with the
  full sidebar and with the rail (for the Dashboard and Settings). No overlap between navigation, page
  and tool at any width.
- Harness development page through Core-managed Shell and a normal password login, in light and dark:
  every action and state from the Harness development UI feature is reachable; the review page opens
  from all three entries and returns with the draft and scroll intact; each picker source shows its
  own files; a selection reaches the composer as a reference; a GitHub comment lands on the intended
  PR line through the selected connection and is refused for a line outside the PR head; the CI
  popover opens only by click.
- SDK: check supported access/installation states through Core, including blocked popups,
  cancellation, preparation failure/retry, configuration required and manual start.
- Apps removal: administrator-only Uninstall retains Open/Standalone and opens Core directly from
  each existing entry. Verify all cleanup choices, impact and runtime/Shell warnings, source safety,
  blocked-popup fallback, denial/expiry, visible errors, original-request recovery and no premature
  success. Keep ordinary-user access and app-token direct-removal refusal unchanged.
- Dashboard app-version hover exposes revision/build data without a native update-error title.
  The problem icon after the app name retains the full error on hover/focus; Manage diagnostics,
  error toasts, known update offers and Core-card diagnostics remain available.
- Harness review: a Changed locally indicator leaves Unresolved visible and never asserts a fix.
- Dashboard: history remains five minutes with honest gaps and partial startup history; a long state
  detail and a long contextual action never shift the columns, Core and app values line up, search filters together with the state filters, and the table never scrolls
  sideways at any width, switching to the compact layout first. Verify one contextual action:
  disabled pending progress, then Restart required ahead of configuration, update offers and
  runtime-health/previous-operation errors; then Logs for a running app with observed
  degraded/unhealthy service health and the logs capability; then Configure, Update and Start/Stop.
  Unrelated manifest, permission, update-check and operation alerts do not select Logs.
  Missing/unknown/startup health and no-logs apps retain their applicable ordinary action.
  Ordinary users retain Logs without lifecycle authority. Core uses disabled pending progress,
  Restart required, factual degraded/unhealthy/failed-status Logs, then Stop; source/Git and
  configuration warnings are not runtime health. Verify the shared title badge, one contextual
  button and guarded Stop Core access through More on narrow layouts.
- Runtime-app Logs: both Dashboard entries, readiness/update-notification actions and direct
  `section=logs` links select the capability-gated tab after Launch without a popup. Verify the
  200-line tail, Refresh, per-service/aggregate output, empty/errors, no hidden reads, app/user/Core
  aborts and mounted form drafts. Preserve visible-app and capability checks, logs-only ordinary-user
  navigation without management controls and factual Core API refusal; Core logs remain a dialog.
- Dashboard row navigation: verify administrator noninteractive row clicks and the native app-name
  Manage link, keyboard/new-tab access and retained table semantics without an extra row tab stop.
  Nested and portalled controls, version/source/resource disclosures, text selection and
  modified/nonprimary clicks must not trigger row navigation. Runtime app expanders and the
  duplicate More > Manage application item are absent. Verify all former app service
  health/runtime/messages, resources, image revisions and network controls in Manage.
- Core summary: no expander or expanded detail panel remains. Verify all former listen/public
  addresses, data root, runtime host and ingress mode in Settings > Host > Updates, including
  address copying, missing/unavailable states, administrator access and retained dirty forms. Reuse
  existing status without extra requests; preserve Dashboard Core metadata, source/resource
  disclosures and every Core action.
- Core Runtime / workspace: verify Release and eligible existing named workspace choices against
  direct Core handover/Return contract, matching repository/project/binding and current authority.
  Verify same-target restart continuity, original-baseline Return, a metadata-only menu read on each
  opening, target confirmation and contextual recovery without ordinary Details/Refresh entries.
  Preserve the original request through interruption, stale/source changes and unavailable CLI/API.
  A Return to a captured source target is not labelled Release; source settings, factual IDE/external
  state and all Core actions remain reachable. App menus use the same label without losing branch/
  source choices. No workspace creation or generic dev restart substitutes for workspace activation.
- Dashboard source identity: verify release, workspace and branch modes, long names, package updates
  while a workspace is active, pending/failed switches and unavailable change inspection. Runtime
  and source selection and Return remain reachable in More by mouse, keyboard and touch, with the
  original permissions/reviews/recovery. Do not make a hover-only interaction the sole way to inspect
  changes or show a requested destination as successfully running.
- Environment redesign acceptance uses the implemented parent-to-child journey: verify
  selected-app readiness, actual failure/resume behavior, normal administrator setup, renewed setup
  link and completion with and without Shell. No second initializer, duplicate installs or invented
  skip/owed-entry behavior may be introduced by adopting EnvSetup.
- Marketplace, Settings and standalone App Details through Core-managed Shell in light and dark:
  every action of the owning features is reachable, including those absent from the artboards.
  Dashboard row/name/Logs and notification links open `/apps/<app-id>` with the requested section;
  The administrator's `Dashboard / <app name>` returns to Dashboard; ordinary-user logs keep an
  accessible Apps parent. Former `manage:<app-id>` bookmarks migrate with their section and removed
  `tab=apps` returns to Dashboard with existing role authorization. Settings has no installed-app catalog;
  its Apps group contains only declared `ui.settings` surfaces with retained embedded authentication,
  access checks, app-owned internal navigation and full-height layout.
  Configuration Save does not add a restart, unsupported mockup policies/actions are absent, and
  catalog values are sourced or explicitly unavailable rather than invented.
- Phone checks on iOS Safari and Android Chrome: keyboard open with a long conversation, a pending
  decision while another tool works, 16 or more tools, rotation, and a hidden tool keeping its draft
  across dock, sheet and phone transitions.

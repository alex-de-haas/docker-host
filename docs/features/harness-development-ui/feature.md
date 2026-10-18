---
created: 2026-10-16
updated: 2026-10-18
summary: Harness combines app-grouped conversations, multi-repository workspace details, sandbox previews and verified lifecycle actions.
components: [apps/harness, apps/core, apps/shell, packages/app-sdk]
---

# Harness Development UI

## Navigation And Conversation

Harness exposes `/development` as its entrypoint and a Shell navigation entry. `/assistant` remains
the compact assistant panel. Both render the same conversation component and use the same session,
streaming, provider, question, approval, app-context and attachment APIs. Workspaces and Plans are
not installation dependencies and remain available as separate apps.

The full page places app-grouped sessions on the left, conversation in the center and workspace
context on the right. A multi-app session appears in each associated group with the same session
identity. Unassigned chats follow the app groups. Rows distinguish actual session activity from
workspace and PR badges; an app filter changes navigation without changing conversation identity.
Sessions within each app group and external workspaces are ordered by most recent activity, with
stable ID ordering for equal or unavailable dates. Waiting sessions keep their indicators without
being pinned above newer work. Sessions fall back to their creation date on older records; Core
aggregates workspace activity across its repositories and workflow. Status polling, reconnects and
opening details do not count as new activity. Reordering keeps the selected conversation/workspace.
Core records managed operations, lease/consumer changes, workflow changes and observed Git-visible
source metadata changes; ignored build output does not affect order. Legacy workspace records use
their last saved observation as a baseline until new activity is recorded. A Core predating this
field leaves activity unknown, sorted deterministically after dated records.
Each row offers Delete session with confirmation. It reuses the existing session deletion API,
including unfinished-workspace protection, and keeps failures visible for retry without navigating
away from the current conversation. Deleting the selected session clears its draft and route selection;
deleting another session preserves the selected conversation. History and new-session header icons
belong only to the compact assistant; the full page uses its left navigation, including on narrow screens.
A conversation without a Core workspace has no right panel. Narrow screens expose session and
details controls while retaining the conversation draft.

Open in Harness promotes the selected session to Shell's main content area through explicit SDK
main navigation, leaving the compact panel at its own route. Full-page session selection updates
Shell's destination, so refreshing restores that session rather than the originally opened chat.
Standalone selection updates its document URL. The selected session and text draft are preserved. Pending local attachments are
uploaded through the existing authenticated session API before navigation and their references
are retained with the draft. This does not send a message or start an agent. A storage/upload error
leaves the operator in the compact surface. Removing a retained attachment also updates the draft. Uploaded draft references synchronize between
already mounted panel/page surfaces; switching presentation does not leave an attachment visible only
in the transcript but missing from the receiving composer.

MCP confirmations survive browser credential renewal and changes to unrelated app MCP routes.
Revoking an app route invalidates only that provider's pending calls and dispatch guards; development
workspace/sandbox approvals remain independent. Native MCP configuration replacement waits until the
turn is idle, while proxy route removals take effect immediately. Session cancellation still revokes
all providers, and a replacement idle client receives a fresh JSON-RPC request namespace.

## Workspace Context

Each repository displays its branch, app bindings, observation time and original-base change counts, including
committed changes. Bounded diffs open in a keyboard-dismissable dialog with repository/file and
all-workspace/uncommitted scope selection. Harness uses the same `@pierre/diffs` renderer as Shell:
syntax and inline change highlighting, line numbers, Unified/Split layout and optional line wrapping.
The viewer follows Hosty's light/dark theme. Untracked local files are rendered as literal additions;
staged and committed additions are parsed as patches. Core identifies the content format in each
diff response, so staging changes after an inventory read cannot reinterpret literal source as a
patch. Older Core responses without that field retain a readable text fallback. Binary and truncated previews retain explicit
messages; metadata-only or malformed patches keep a readable text fallback. Missing statistics are unavailable rather than zero;
binary files contribute to file counts without invented line counts. Closing the dialog restores
focus to the Changes control. File and scope selection persist per repository while the workspace
panel remains mounted, including closing/reopening a diff and resizing the view. Detail and inventory
reads retain Core's source authorization.

The diff viewer is verified against real Git changes in a disposable Core-managed Harness with a
normal password login: Unified and Split, syntax/inline highlighting, wrapped long lines, local
untracked patch-like contents, binary messaging and file/scope persistence after reopening. Its
focused tests also cover theme updates, failed highlighter loading, malformed and truncated patches,
and staged additions/deletions. The test worktree passes Core cleanup after removing its synthetic
changes; the test Core, Harness process and credentials are removed.

PR rows show the title followed by repository name, successful/total observed checks and the
provider's discussion-comment count. Missing counts remain unknown. State, draft, stale evidence,
review decision, unresolved threads and individual failed/pending checks remain distinct. No
historical green PR implies that a new head passed CI.

The sandbox section is omitted when empty. Owned child Core environments show their label, runtime
state and authorized Core/application preview links; app sandboxes show their runtime state and
preview link. Ordinary child login remains required. Missing resource permission or unavailable
application status is reported. Merely completing a workspace does not finish a retained sandbox.

Each child app also shows Core-owned launch progress (preparation, environment build/reuse,
service start, readiness, failure/interruption), its observation time and the affected service.
Individual service rows show the child's observed runtime and health states, so a healthy frontend
does not hide a stopped backend. A new topology replaces the previous service rows; missing
observations display `Service status unobserved`.
A fixed read-only inventory request remains available during a long child app build; it retains
caller, consent, ownership and process checks without waiting behind the mutation gate. Failed
inventory refreshes clear old results. Older children without observations display unknown values.
Live-source apps report a changed source manifest/location and the resulting restart requirement.
Restarting with an accepted manifest clears that requirement. Protected Docker contract changes
still require the existing reviewed update flow; the panel displays that manifest error.
Application dev-server compilation/hot reload is explicitly application-managed: a running process
or a successful environment build does not attest to the current source compiling successfully.

Each child application has independent Check preview, Restart app and Show service logs actions.
Optional checks show the exact per-service command, working directory and timeout before execution,
separate readiness from test results, and display stale/unknown/failed states and real exit output.
No recipe leaves tests not checked and does not disable restart. Logs are an explicit bounded
snapshot, not a live stream. Build/start failures retain repair guidance for the same worktree and
sandbox. The [creation feature](../app-prototype-workspaces/feature.md#optional-preview-checks-and-repair)
owns the runtime recipe, serialization and recovery contract.


External workspaces have a separate tab using Core's existing typed external ownership and the same
summary/diff components. There is no fabricated Harness conversation or imported transcript. Its
selection is independent of the conversation and draft. External agent execution is not inferred
from a workspace or lease. The panel explicitly distinguishes external work from synchronized
conversation/activity. Missing and stale observations are labelled. Core authorization still
determines management authority.

## Lifecycle Actions

Complete, Defer, Resume and Delete use the [Core workflow contract](../workspace-lifecycle-controls/feature.md).
Core checks all repositories; chat inactivity, CI success or an agent's message cannot complete work.
Completion leaves source and previews available. Resume invalidates completion without starting an
agent. Delete explains its scope and optionally removes the Harness conversation after resource and
source cleanup succeeds. Published PRs are preserved. Pending operations retain their UUID and
revision, including recovery from Core after browser storage loss.

Harness's agent completion tool records intent and submits it after the turn succeeds and source
leases are released. Failure, cancellation or interrupted execution does not complete work. A
failed verification becomes a visible blocked completion request. Existing prompt customization
remains available; Plans and specification-driven development are not mandatory.

## Instructions And Retention

Settings exposes an editable Development workflow beside additional operator instructions. The
shipped default covers clarification, registered worktrees, tests, reusable operator previews,
authorized publication and verified completion. Plans and a Markdown plan are optional. Saving an
empty workflow disables that process text; restoring the default edits the draft until Save. Existing
repository instructions, Core permissions and worktree/resource checks remain independent of this
text. A newly started provider client receives the current instructions; an already running client
is not silently reconfigured in the middle of its session.

The same settings page provides separate ordinary-chat and completed-workspace expiry, each with
Off. Completed-workspace expiry defaults to Off. The conversation shows its eligibility, completion
time or preservation reason and offers refresh/retry when cleanup is blocked. In-progress, deferred
and unknown work is never deleted because of age. The
[retention feature](../harness-session-retention/feature.md) documents authorization, coordinated
resource cleanup, migration and D5 browser/startup acceptance.

## Validation Baseline (2026-10-16)

The separate local Core used normal setup/password login and Core-managed Shell/Harness runtimes.
Browser checks cover two repository groups, diff inspection, retained drafts/attachments across
compact/full-page navigation, a no-workspace chat, the External tab's empty state, and lifecycle
controls at 480 px and 1280 px. The narrow page has no horizontal overflow. The deletion dialog
removed both merged worktree directories, finished the associated child Core, deleted its temporary
data directory and removed the selected conversation (subsequent read returned 404).
Authenticated Harness API checks cover dirty and committed-unmerged rejection, completion,
defer/resume, and invalidation by a later source edit. No Workspaces or Plans app was installed.

A subsequent isolated fixture uses an explicitly approved temporary `hosty:core` credential with
`mcp:read` and `mcp:workspaces`. Two external repositories appear in the dedicated tab with separate
counts/diffs and no fabricated conversation. Completion rejects active leases, dirty files and
unmerged commits. After merging the disposable fixtures, completion and deletion work from the UI.
Revoking Harness child-environment permissions interrupts cleanup and preserves both worktrees.
After a Core restart and permission restoration, Retry continues the original UUID/revision, removes
both directories and the child data root, and reports deleted. The external MCP credential is then
revoked; another MCP request returns 401. The existing conversation draft survives tab changes and
restart. PR presentation is covered by component tests using distinct current/stale observations.

The real-agent acceptance uses Codex in native mode, authorized with a temporary copy of the selected
host account, against a disposable Demo-only Git repository. The agent prepares a workspace, creates
a child Core, uses normal setup for its independent test user, installs Demo App with two Docker
services, and stores an explicit app role. The operator opens the preview from Harness and observes
`Harness preview iteration 1`. A second turn updates it to `Harness preview iteration 2`, confirms
hot reload and restarts the same child Core. Browser acceptance verifies the second marker and the
same stored Admin role. The child process identity changes; the app role file's SHA-256 does not.
Defer and Resume from the UI retain the same source and preview without starting another agent.

Observed snapshots (not peak-memory measurements):

| Observation | Demo App containers combined | Child Core process | Owned disk |
| --- | --- | --- | --- |
| After iteration 1 | 798 MiB | 108 MiB | 1.08 GiB |
| After iteration 2 and restart | 484 MiB | 96 MiB | 1.15 GiB |

The agent's Finish succeeds at revision 7 and removes the child data directory, app containers,
network and owned volumes. The panel no longer offers that preview. Source edits stay uncommitted
and the workspace is not falsely marked completed. The disposable parent stand is then stopped and
removed, including the two test sessions, their worktrees, provider storage and approved auth copy.
The provider connection is removed before stand disposal. Only the two parent test containers and
the newly built Demo dependency image are removed explicitly; existing operator containers/caches
are preserved. No credentials, event JSON, raw logs or experimental source patches are checked in.

### D4 Build And Restart Acceptance (2026-10-16)

A second isolated stand runs the current built Core and Core-managed Harness with no Workspaces or
Plans app. Native Codex prepares a Demo-only linked worktree and performs two source iterations;
the operator uses Harness's ordinary environment actions and Core consent/installation review to
start its child. Installation from `apps/demo-app/manifest.json` correctly records that subpath even
when `source.repository` names the absolute original repository. The repo-root source override
has no live-manifest warning.

The child builds two Docker development services. While the start request is active, the Harness
preview API reports `building`; the browser panel shows environment build/readiness and then
`Started`. Normal child password login opens the authorized Demo preview. The browser displays
`D4 iteration one`, then `D4 iteration two` without replacing the sandbox. The second agent edit
also changes the manifest description: the panel reports `Restart required` while the app remains
healthy. Restart reports the existing image as `Reused`, clears the requirement and preserves the
preview URL. The browser still displays the second marker and the explicit Admin role from the app
store. Both `app-roles.json` and a synthetic retained-data file keep their SHA-256 across restarts.

An attempted unreviewed Docker build-revision edit retains the accepted runtime and reports the
existing protected-contract review requirement. Restoring the reviewed recipe clears that warning.
Actual build-failure/interruption and unknown/missing observations are covered by focused Core and
component tests; this probe is not evidence of a failed Docker compilation.

Observed post-restart snapshots are 626.4 MiB frontend and 226.8 MiB backend (not peak measurements).
The earlier environment observation reports 81.6 MiB child Core and 1.12 GiB owned disk; these
samples have different timestamps and are not a simultaneous total.

The D4 native session remains in normal approval mode. Several environment MCP confirmations are
cancelled before dispatch, including the attempted agent Finish; the operator's Harness action
performs cleanup. The normal-mode follow-up below resolves this limitation; the original D4 run itself is not an end-to-end agent lifecycle pass.
The two code edits and their browser verification complete D4's retained-data iteration contract.
Finish reaches revision 5 and removes the child root, both app containers and owned network/volumes.
Fixture cleanup also removes its generated build images. Harness no longer lists its preview; uncommitted source is not marked completed.
The disposable parent is then stopped and removed, including its worktrees, test sessions, provider
storage and temporary Codex authorization. No raw evidence JSON, logs or fixture patches enter the
repository.


D4 verification:

- `npm run harness:test`: 622 tests in 78 files; `npm run harness:lint`: passed.
- Core-managed Harness setup runs `npm run build:web`: static production build passed.
- Core test filter `CoreLifecycleServiceTests|CoreEnvironment|DockerSourceRuntimeTests`: 781 passed,
  four existing opt-in integration tests skipped. Real Docker/browser acceptance is described above.
- After the final inventory-gate change, filter
  `CoreEnvironment|LinkedWorktreeManifest|LaunchProgress_|DockerSourceRuntimeTests`: 113 passed.
  It also rebuilds the exact Core project used by the stand. Counts overlap, not a unique total.
- Regression cases cover absolute/file-URI repositories, linked worktree subpaths, same-size and
  same-mtime manifest edits, missing manifests, build reuse/failure, concurrent inventory and legacy
  children without progress fields.

Earlier UI/lifecycle verification commands passed:

- `npm run harness:test`: 619 tests across 77 files.
- `npm run harness:lint`: ESLint and TypeScript checks.
- `npm run build -w apps/harness/web`: static production build.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter
  'FullyQualifiedName~Workspace|FullyQualifiedName~CoreEnvironment|FullyQualifiedName~Sandbox'
  --artifacts-path /private/tmp/hosty-harness-ui-build --no-restore`: 254 tests.
- The later `Publication|WorkspaceWorkflow` filtered Core run after the corrective-publication fix:
  105 tests. These suites overlap; their counts are not a unique combined total.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs`, `git diff --check`.

### Normal-Mode MCP Lifecycle Acceptance (2026-10-16)

A fresh isolated parent runs the built Core and Core-managed Harness with a temporary, explicitly
authorized copy of the selected Codex host login. Codex remains in normal approval mode throughout.
The real agent prepares a disposable Demo worktree, changes its visible heading, requests launch
consent, creates and starts a child Core, performs normal account setup, submits the child app
installation review, sets the repo-root source override and starts both `sandbox-dev` services.
The operator confirms individual operations and the two ordinary Core reviews; no operator BFF
create/start/Finish action substitutes for the agent's environment tools.

The prepare approval survives 30 seconds, two credential refreshes and a browser reload. The Finish
approval likewise survives two refreshes and approximately 30 seconds before explicit acceptance.
Nineteen authorized development MCP confirmations succeed without unexpected cancellation. An
additional `workflow_complete` request after Finish is explicitly denied because completing the
workspace is outside this probe's scope; the agent reports the denial and does not retry it.

Harness shows the one-file diff, running/healthy Demo services and `Environment build: Built`.
Opening its app preview prompts for normal child password login. The browser displays
`MCP normal-mode sandbox verified`, an active app session and the child QA user; People navigation
shows the same assigned user. One in-app browser tab crashes during the probe; a fresh tab restores
the same conversation and preview without stopping the agent. The probe does not attribute that
browser-process failure to an application or claim coverage of arbitrary browser crashes.
Observed Docker memory is 470.8 MiB frontend and 289.3 MiB backend, a sample rather than a peak.

After browser verification, the agent reads the current revision and executes `environment_finish`.
Its subsequent status/list reads report `finished`, revision 5, without a process or data root.
Independent inventory checks confirm removal of two containers, six cache volumes and the child
network; Harness returns an empty preview inventory. Finish preserves borrowed worktree source.
Docker source-build tags are cache artifacts, not removed by this Finish: fixture teardown explicitly
removes its two owned tags, without pruning shared Docker caches. The provider connection is removed,
the test parent stops, and the entire disposable stand (including source, sessions, build output and
temporary authorization) is deleted. No raw JSON, logs or experimental patches enter the repository.

Verification: `npm test --workspace @haas/hosty-harness` passes 627 tests in 78 files;
`npm run lint --workspace @haas/hosty-harness` passes. The exact Core project builds successfully
with isolated artifacts (four existing warnings). The final follow-up also covers delegation expiry:
an active development approval survives, while replacing an idle client invalidates its old dispatch
guards and permits a fresh RPC namespace. Core behavior is unchanged by this MCP fix; Core tests
from D4 are not repeated.

## D6 Responsive, Navigation And Recovery Acceptance (2026-10-16)

A disposable data root runs the exact source Core project and Core-managed Shell/Harness with normal
bootstrap and browser password login. Two local Git fixture repositories provide a single multi-app
conversation with two changed files each; a separate quick chat has no workspace. Workspaces and
Plans are not installed. This probe makes no paid provider call and copies no provider credentials;
real-agent preparation/retained-data/Finish coverage remains the D4 and normal-mode acceptance above.

Browser acceptance uses 1440×900 and 390×844 viewports in the in-app browser. The narrow Shell leaves
256 CSS pixels for the embedded app: its document scroll width equals its client width, with no
horizontal page overflow. Session list, chat and details remain reachable through explicit toggles.
Diff text scrolls within its own pane. Checks include app filtering, selection from both application
groups, the unassigned quick chat without a details panel, External/Sessions switching, both
repositories, all-workspace/uncommitted scope, second-file selection, Escape and focus restoration.
The final diff regression preserves each repository's file/scope on reopening.

The initial browser run exposed four continuity defects, now corrected:

- Compact-to-full navigation replaced the compact iframe. Explicit main placement now uses the
  Core-resolved entry and selected-session query, preserving the originating panel.
- The Shell page-link resolver duplicated the entry path when a session query was present; matching
  the declared pathname now preserves the query without prepending the entrypoint again.
- Picking a later conversation left Shell's original session in its URL. Selection now updates that
  destination and a browser reload restores the selected conversation and its own unsent draft.
- Uploaded draft references did not reach an already mounted second composer. Storage events now
  synchronize references, including removal, without sending a message.

A disposable text attachment is uploaded by Open in Harness and remains ready to send after a
Core-managed Harness stop/start. The text draft, selected session and two worktrees also survive.
Stopped Harness is shown as unavailable in Shell. The test then gracefully stops only the fixture
Core with keep-apps and starts the same built project/data root again. Its process identity changes
from PID 58531 to 55220; the factual launch remains dev with the expected worktree project. During
the outage the browser shows Cannot reach Hosty. Retry revalidates access; inventory polling restores
names, source observations and workspace controls, retaining the conversation/draft/attachment.
The session inventory remains three idle sessions throughout; presentation changes start no run.

Coverage mapping for the broader D6 contract:

| Area | Evidence |
| --- | --- |
| Wide/narrow layout, filter, draft, attachment, panel/main navigation, browser/Harness/Core recovery | This normal-login browser probe and new continuity regressions |
| Multiple repositories and external ownership, no fabricated chat, denied cleanup/replay and revoked token | Earlier isolated external-workspace acceptance above |
| Real provider, questions/approvals, retained preview data and agent-owned Finish | D4 and normal-mode lifecycle acceptance above; existing provider/approval regressions rerun |
| Several PRs, missing/stale/failed CI, comments/reviews, unknown statistics and preview permission revocation | Workspace details/navigation/preview regression tests; Core inspection/workflow coverage recorded above |
| Completion, resume, deletion and unfinished-work preservation | UI/lifecycle and D5 retention acceptance; broader cancellation/discard work stays in its owning plan |
| Navigation migration | Harness manifest entry, no Workspaces/Plans dependency, standalone Workspaces remains installed where the operator chose it; no uninstall or redirect |

Final verification:

- `npm test --workspace @haas/hosty-harness`: 657 tests in 79 files pass.
- `npm test --workspace @hosty-sdk/app`: 681 tests in 34 files pass, including negotiated main
  navigation, legacy-host refusal, response acknowledgement, request/query conflicts and revoked frames.
- `npm test --workspace @haas/hosty-shell`: 192 Node tests and 270 component tests pass.
- Harness backend TypeScript, web ESLint/TypeScript, SDK build and Harness/Shell production builds pass.
  Shell lint has no errors and two pre-existing warnings (callback dependencies and internal navigation).
- The exact Core project builds with isolated artifacts. No Core implementation changed in D6;
  the affected Core runs recorded above are not represented as a new full-suite run.
- Version consistency, documentation index/link validation and `git diff --check` pass.

The fixture's app runners and Core stop before teardown. Its labelled Docker container and
private data, temporary account/session credentials, fixture repositories and build output are removed.
No labelled test networks or volumes remain. Shared caches and the operator's main Core/apps are untouched. Raw evidence and logs are not repository
artifacts. The registered implementation worktree is retained for publication.

The UI plan's D1–D7 are complete. Artifact versions for the accumulated feature are Core/CLI
0.137.0 → 0.138.0, Harness 0.54.1 → 0.55.0, Shell 0.104.1 → 0.104.2 and npm app SDK
0.31.0 → 0.32.0. These are source version changes, not a claim that releases are published.

Workspace actions also offer non-destructive Close while the agent is active. Core journals admission,
Harness coordinates its owned Docker stop and the panel retains Retry for interrupted closure.
Closed source and conversation remain available; Resume is explicit. See
[workspace lifecycle controls](../workspace-lifecycle-controls/feature.md).

## Local App Authoring Controls

The conversation's Create app form reviews app metadata/icon, Git author and the single bootstrap
commit, preserves its browser draft and recovers the original allocation/dispatch after uncertainty.
Continue building opens retained work or a new session from an installed local Git app. Repository
panels expose reviewed commits, Accept locally, Use locally and optional existing-remote operations
without requiring publication to save or use the app. The
[creation feature](../app-prototype-workspaces/feature.md) owns source retention, replay, authorization
and verification; these controls reuse the same sessions, worktrees and child Core panels.

## Testing Expectations

- Verify activity ordering, legacy/missing/invalid dates, multiple repositories, repeated observations,
  replays, file edits and workflow changes. Keep attention indicators independent of ordering and
  preserve selection during refresh.

- Session-row deletion requires confirmation without selecting the row, preserves errors for retry,
  prevents duplicate pending requests and retains Core's workspace/resource guards. Verify selected
  session detachment, other drafts, filter fallback after removing a group, and compact-only history
  controls across reloads.

- Preserve editable workflow defaults, custom/empty text, instruction delivery, independent retention
  policies and unsaved settings drafts. Keep retention eligibility/retry consistent with Core's
  verified workflow; follow the retention feature's boundary, migration and recovery checks.

- Credential refresh with no app providers, last-provider removal and delegation expiry preserve
  pending development approvals. Revocation cancels only the affected provider; session teardown
  invalidates every dispatch guard and idle client replacement resets replay detection.


- Preserve existing assistant streaming, approvals/questions, providers, attachments and context tests.
- Verify grouping, same-session draft/attachment continuity, conditional details and narrow-screen
  navigation. Panel promotion targets Shell's main area, current-surface navigation stays local,
  selection survives reload, and unavailable/legacy hosts never silently replace the panel.
- Verify both diff layouts, wrapping/scrolling, Hosty theme changes, literal untracked additions and
  metadata/malformed/binary/truncated fallbacks without changing file/scope selection.
- Preserve acknowledged/replay-safe SDK navigation and per-repository diff selection/focus on reopen.
- Keep each repository's change scope and each PR's CI/review observation independent; test missing,
  binary, bounded, failed and stale evidence.
- Use normal Core/Shell identity for embedded acceptance; standalone UI alone is insufficient.
- Exercise explicit complete/resume/delete and recovery with original IDs; never infer completion.
- Preserve external-owner authorization and no-chat behavior; do not synthesize provider evidence.

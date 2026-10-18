---
created: 2026-10-17
updated: 2026-10-18
summary: Local Git app creation, child Core Docker preview, local acceptance, remote publication and versioned development guidance through Harness, MCP and CLI.
components: [apps/core, apps/cli, apps/harness]
---

# Local App Creation From Harness

Harness provides **Create app** in a conversation. The form accepts an app id, display name,
optional description and PNG icon, Git author and generation request. Explicit consent permits one commit of
the fixed packaged bootstrap. No remote is added. The draft and replay id survive a form close
or browser reload; confirmed pre-allocation refusals unlock the inputs for correction.
The form suggests a valid local id without replacing a manually chosen one. Git identity defaults
come from the current user's Core profile and remain editable without changing that profile.
Late profile responses preserve edits and cannot change an already submitted request.

Icons are optional PNG uploads up to 128 KiB and 1024×1024 pixels. The form previews/removes the
selected image; Core checks byte/dimension bounds, PNG framing and chunk checksums before allocating
source. The fixed `icon.png` asset is referenced by `catalogMetadata.icon`, included in the reviewed
bootstrap commit and carried into the worktree. Icon-free requests retain their existing fingerprints.
Harness accepts a bounded 256 KiB workspace-action body and 128 KiB creation-dispatch body; other
routes retain their existing limits. The same optional base64 `iconPng` input is available to MCP.

Browser drafts are scoped to the conversation, include the icon and explicit commit consent, and
report storage failures. An unsaved replay identity prevents submission; the open draft remains
editable. Submitted bootstrap arguments stay locked after uncertainty. Core and Harness retain the
creation operation and generation prompt, and **Recover** also covers an observed app whose agent
handoff has not started. A provider failure preserves the app/workspace and does not become a new
creation attempt. Draft persistence is local to that browser; it is not cross-device synchronization.

Core requires the calling app's reviewed source/workspace and install authority plus the actual
user/session owner. It reserves `apps/<id>/source`, creates local `main`, installs the valid Docker
bootstrap as an ordinary stopped app with autostart off, then prepares the normal session worktree.
Harness associates that app with the conversation and shows **Created locally**. Source edits
appear in the existing workspace panel alongside the child Core, runtime health and preview link.
Workspace inspection retains Core error status even for empty/non-JSON failures; malformed successful
responses are reported as upstream errors rather than usable workspace data.

## Operator Workflow

| Action | Result and boundary |
| --- | --- |
| Create app | Review the app id, Git author and single bootstrap commit; allocate canonical local Git and a session worktree without a remote |
| Develop and preview | Let the agent edit the worktree and prepare an authorized child Core; open its preview with child users and separate test data |
| Check preview | Review an available check recipe; missing recipes, health and browser verification remain distinct observations |
| Commit and Accept locally | Review/commit source changes, then explicitly fast-forward canonical main; no push is implied |
| Use locally | Start the accepted app through normal lifecycle with its ordinary data, independently of the child preview |
| Continue building | Open retained work or prepare a new session from reviewed accepted main; source does not belong to a chat |
| Connect remote and publish a PR | Select an existing repository/account and review the separate fetch, integration, push and PR operations |
| Finish and Complete | Finish removes child resources; Complete verifies every repository before workspace/chat deletion becomes eligible |

Creating a hosted repository, publishing a release/feed and submitting to Marketplace are separate
from the existing-remote code publication described here. Ordinary app data, canonical source,
worktrees, sandbox data and conversation retention have distinct owners and cleanup rules.

## Durable Source And Recovery

The canonical repository is a `local-git` source binding. The generic managed-clone fetch/pin paths
reject that binding instead of cloning or resetting over it. Live manifest reconciliation preserves
it. Ordinary app-data removal without Delete source retains the canonical repository.

Core journals the creation under its `authoring` operation directory; this is not a second source
or workspace registry. The journal binds owner, replay id, original input, selected author,
bootstrap fingerprint, source path, commit and installation. Pending recovery checks the original
bootstrap bytes and rejects edited files, path links, unrelated content or a changed package. A
persisted bootstrap commit is reused after an interrupted installation. Installed replay preserves
later source edits and refuses a removed/replaced installation. A different owner cannot replay it.

Harness persists preparation intent before calling Core. A lost preparation response retries the
same operation and worktree. Model dispatch uses the existing queued/running/unknown handoff state;
an uncertain delivery does not silently spend another generation turn. Pending creation is protected
from chat retention, and completed preparation counts as workspace/resource history. A later
permission refusal cannot turn an uncertain earlier allocation into a confirmed rejection. Retrying
a previously refused request first persists pending intent again, so response loss remains recoverable.

## Docker Preview And Agent Guidance

The embedded Node/React bootstrap uses a read-only source mount, a separate `node_modules` volume
and the child app's own data directory. The Node watcher observes server changes; the browser bundle
is rebuilt on request, so client iteration uses a page refresh. Container health and successful
client compilation are separate checks.

The client uses `AppIdentityBridge`/`appFetch`. Its plain Node server exchanges PKCE launch codes,
sets scoped app cookies and revalidates app credentials with Core. Protected API access requires an
active app session. The normal child Core setup/password login flow supplies preview identity.
Parent credentials, app users and ordinary application data are not promoted into the child app.

Core packages a development guide in eight bounded topics: overview, source, docker, identity,
sdk, preview, checks and finish. Each response includes the running Core version, manifest schema,
selected topic, complete topic index and a SHA-256 revision over the packaged content and titles.
One topic is at most 16,000 UTF-8 bytes; unknown IDs fail explicitly instead of reading arbitrary
paths or expanding the entire guide. The default overview explains which topics to retrieve next.

The same reader serves Harness `app_creation_guide`, direct Core MCP
`get_app_development_guide`, authenticated `GET /control/v1/apps/development-guide?topic=...`
and `hosty --data-root <root> apps guide --topic <id> --format text|json`. CLI reads the running
Core rather than a bundled CLI copy and preserves raw Markdown/code blocks without terminal wrapping.
Harness forwards the topic through its existing app/session authority; it needs no workspace,
provider connection or install permission to read. Existing source authority remains required;
Core MCP retains its admin/read scope gate (assistant MCP also requires `apps.read`). Disabled or
refused MCP is not replaced by an unreviewed shell/CLI bridge.

The guide describes the reviewed child install flow, actual worktree paths, Docker-to-host HTTP
routing, source retention, normal identity and bounded stack-specific checks. It distinguishes
actual TypeScript and .NET SDK capabilities, including the Next-specific server slice and the
absence of a .NET browser/code-exchange bridge, and supplies direct browser/HTTP protocol examples
for other stacks. It distinguishes aggregate workspace IDs for child
allocation from worktree IDs for source/Git/local-status tools, and describes explicit toolchain PATH,
separate Rust caches and generated lockfile overlays. Editable workflow instructions still apply.
Both Codex and Claude use the existing shared Docker worker. Codex uses its external-sandbox
protocol for that transport while retaining normal command/MCP confirmations; native runs retain
their previous sandbox policy. An incomplete worker disk observation retries once, then still fails
closed rather than accepting partial quota accounting.

Child Core creation, setup, installation, start and Finish use the existing environment APIs and
confirmation mechanisms. Finish removes the child's app containers, caches, users and data while
retaining the parent's canonical source and uncommitted worktree. Creation leaves the normal parent app
stopped; Finish does not change an ordinary instance started later through Use locally. Workspace
Complete, chat deletion and sandbox Finish are different operations.

### Multi-Service Iteration

An installed bootstrap can become a multi-service Docker app through the child's ordinary reviewed
update flow: prepare an installation request with `updateAppId`, the actual worktree manifest path
and selected runtime, then submit and review it. The packaged guide includes this recipe. App id,
installation identity, child users and the app-data directory remain stable. A data target can move
to the replacement service without copying data into source or the parent application.

Docker start reconciles obsolete service containers against the complete selected Docker graph
before resource admission. Removal requires exact app/instance ownership and an immutable container
ID; services still present in that graph, foreign containers, data and caches are retained. Docker
inventory/removal errors fail the start rather than reporting successful reconciliation.

The Harness panel renders each observed service's runtime and health state, including a failing
backend beside a healthy frontend. Missing observations remain unobserved. Existing source-watch
commands can reload code inside the same containers; topology/build-revision changes retain normal
review and explicit lifecycle behavior. Stop/Start reuses the same environment, users and test data;
Finish disposes them. Shared Docker image/build-cache retention is unchanged.

### Optional Preview Checks And Repair

Harness offers separate **Check preview**, **Restart app** and **Show service logs** actions per
child application. Check preview refreshes manifest/topology/readiness observations and reads
optional `.hosty/preview-checks.json` arrays from read-only Docker service source roots. No recipe
means build/tests are not checked, not passed. Missing Docker/service/source observations remain
unknown. A recipe specifies an id, argv, contained cwd and a 1–300 second timeout. The panel displays
the actual command and interruption warning before **Run reviewed check** sends its id, digest and
request UUID. The child administrator API exposes the same prepared-recipe contract; the browser
cannot supply replacement shell text.

Execution uses the existing quota-limited service container. Parent-mediated checks serialize with
registered workspace writers and refuse pending/unknown Git operations after restart. No toolchain installation or automatic restart occurs. Writable
outputs use the selected runtime's existing caches, temporary storage or test data; source remains
read-only. Timeout/cancellation kills that exact container and verifies it stopped, terminating
detached check descendants as well. Unknown termination or interrupted Core execution requires
an explicit service restart before another command in that container. Docker transport interruption
is distinct from a check deadline; unverified termination remains unknown.

Receipts retain request identity, digest, real exit code, timestamp and bounded command output.
Replaying a request returns its receipt; interrupted execution is unknown rather than rerun.
Changes to source, recipe, manifest, image or container invalidate results. The bounded source scan
excludes Git metadata and declared generated/cache paths; changing those tools or caches manually
requires restart and a new check. Readiness and functional browser QA remain separate evidence.

Build errors name the failing service and retain bounded Docker diagnostics. Startup errors expose
the service and exit status; the operator can read its last 80 log lines from the same panel.
Source can be repaired while the application is stopped, followed by an explicit restart in the
same child Core. Protected manifest changes retain ordinary installation review. Test data and
users are preserved until Finish; check receipts are stored outside application data and disappear
with the child root.

## Multiple Repositories In One Session

A Harness conversation can associate several apps with separate registered worktrees. Removing an
app from conversation context does not discard an existing source binding. Turn admission acquires
all required source leases before starting the adapter; refusal from a second repository prevents
execution without silently dropping that repository. Message attachments stay in session storage,
separate from the app repositories and source mounts.

The same child Core can consume both worktrees and run their Docker previews with separate app data.
Cancelling a native turn preserves its source leases because stopping an adapter alone does not prove
that every native process has exited. Restart retains these bindings and leases; a successful resumed
turn releases both. Docker worker close records verified stop before releasing leases and can retry a
partial multi-repository release without declaring the workspace quiescent early.

Close retains unfinished source, conversation and previews; Resume reopens that work. Completion
checks every repository, and deletion requires verified completion. A clean first repository cannot
hide dirty, unmerged or leased work in another. Finishing the shared sandbox releases both source
consumers and removes child resources while leaving unfinished worktrees and canonical Git intact.

## Accept Locally And Use Locally

For Core-created local Git apps, the workspace panel shows canonical main and worktree commits,
cleanliness, local acceptance and ordinary runtime state. The operator reviews an explicit
**Accept locally** confirmation after authorized worktree commits; accepting never creates a commit,
remote, push or publication. It fast-forwards the clean canonical main to the exact reviewed head.
Dirty trees, stale heads, divergent history and active writers are refused without reset, stash or
force. Unknown Git outcomes and unreadable workspace activity records also block target integration
until recovered; an advisory list that omits damaged records is not used as proof of idle writers.
An ordinary running app must be stopped before main advances, because its development watcher
could otherwise change behavior against real data. A sandbox preview can remain attached to its
separate worktree.

Core serializes managed writer admission with target integration, journals owner/installation,
request id and both commits before mutation, and reconciles an interrupted operation whose target
already advanced. Identical successful replay returns the original receipt with current facts.
The UI retains pending arguments through reload. Core refreshes the managed target reference after
acceptance; Complete still uses actual ancestry and requires every repository to qualify.

**Use locally** is a separate operator confirmation. It requires the accepted clean source and
uses the ordinary installation's existing lifecycle, permission/manifest/settings checks, data and
caches. It copies no sandbox users, data or secrets and leaves autostart unchanged. The panel links
to Core's normal authenticated app-open flow. Both mutations refuse active Harness turns; the agent
can inspect local status and prepare reviewed commits, then return control to the operator. Recorded
session cancellation closes earlier unresolved approval and question cards, including after replay;
answered questions retain their answers and requests from subsequent turns remain actionable.

Core recognizes only the registered canonical local Git source under its own app directory as
executable source. This exception does not allow arbitrary app-data overrides or shared mounts over
source. Sandbox Finish and workspace cleanup retain the canonical repository and ordinary app data.

## Optional Remote And Reviewed Publication

A local Git app can connect to an existing HTTPS GitHub repository using the current user's source
connection and an explicit target branch. The remote is a separate nullable binding: canonical
local main, the source directory, worktree identity and local acceptance do not change. Core does
not write credentials or a remote URL into Git configuration. Local-only status works without a
connection. Fetch records the observed remote head, time, relationship and ahead/behind counts in a
separate upstream reference; it never pulls into a branch or rewrites working files.

When the selected target is absent, the operator can explicitly publish the exact accepted local
main as its base. A create-only reference lease refuses a concurrent creator; an existing differing
head is never overwritten. An exact existing head reconciles a lost response. Nonempty remote
history is fetched and integrated explicitly in the registered worktree with reviewed local and
remote heads. Unrelated histories require explicit consent. Conflicts retain source and use the
existing abort/recovery flow; remote integration does not mark local main as accepted.

The Harness repository panel separates reviewed commits, remote connection, fetch, base publication,
publication configuration, branch push and draft PR creation. Commits select paths and authorship
without requiring publication. Push and PR operations reuse Core's publication journal, connection,
CI and review mechanism. Before a push Core checks source identity, selected connection, clean exact
HEAD and upstream ancestry. The same request ID and arguments survive response loss and browser or
Core restart. Abort integration remains available for an observed worktree conflict even when the
remote connection is revoked; it uses local Git and retains the ordinary pending-action and active-work
guards. Changed replay arguments and stale heads are refused. Connection acquisition precedes
workspace admission, and nested authenticated Git borrows that connection rather than reacquiring
its lock; concurrent fetch, status and publication remain usable.

The workspace panel projects authorized provider observations against the connected remote rather
than the local `.git` path. It shows the repository name, PR state, CI counts and unresolved review
threads, and removes a transient detail-read warning after recovery. Source or connection changes
invalidate those observations. Remote-status HTTP reads authenticate the app/user/session before
validating the requested source app; missing parameters never bypass the authorization response.
A published branch or open/closed unmerged PR does not satisfy local
acceptance or merged-work completion and does not authorize source cleanup.

## Continue Building

The full Harness page offers **Continue building** beside session navigation. It reads installed
local Git apps directly from Core, including apps whose previous conversations have been deleted.
The chooser shows canonical main, the current user's retained worktrees, workflow state and whether
their clean committed work is already included in main. Unverified source remains visibly unknown.
It opens an existing Harness session without transferring its leases, resuming a closed workflow or
starting an agent. Deferred/completed work uses the existing explicit Resume action.

**New building session** allocates a new conversation and worktree from the reviewed accepted main
commit. Core serializes preparation with source selection and local acceptance. It refuses a changed
head, alternate source override, dirty canonical source or a main commit changed outside local
acceptance. Old worktrees, their edits and active leases are retained. Allocation and preparation
reuse the same request after a lost response; the browser retains the retry arguments through reload.
The operator chooses a provider and sends the next instruction in the resulting conversation.

Source replacement changes only the selected runtime folder. It does not overwrite the canonical
repository or move an existing session to another repository. Clearing an override on a local Git app
restores its own canonical source rather than leaving a missing source selection. Existing workspace
and chat retention guards still require verified completion and resource cleanup before deletion;
canonical source belongs to the app and survives that deletion.

Existing workspace Git/PR actions retain their original authorization requirements.

## Source Protection During Removal And Selection

Core reads durable workspace activity when removing an app or selecting/clearing source. Active
leases, sandbox consumers, releasing worktrees and pending/unknown source operations block mutation.
Unreadable workspace records block it as unknown. Repository admission gates serialize those checks
with new consumers without blocking unrelated repositories. A removed or replaced source installation
cannot acquire new worktree leases or sandbox consumers through its old binding; observation and
release remain available.

Core removal and source-selection confirmation show actual source paths, Git HEAD and cleanliness,
local-only history, unverified remote backup, no-Git/unknown state, outstanding worktree changes and
whether committed worktree HEAD is included in canonical source. A clean canonical checkout is not
reported as proof that its worktrees are complete. Selecting another folder never moves or deletes
canonical source, external folders or old worktrees.

A removal review is bound to source/workspace facts and rechecked under repository admission. For
explicit source deletion it also hashes regular file contents, including ignored files, without
following symlinks; Git storage is represented by HEAD and refs. The review is bounded to 20,000
entries and 256 MiB of non-Git file contents. Unreadable or over-limit source is unknown and cannot
be deleted through that review; keeping source remains available when activity is verifiably idle.
Source changes after review, including edits with unchanged Git status, require a fresh review.
Core verifies the facts again after successful runtime removal. Ignoring runtime errors cannot be
combined with source deletion. Source deletion failures retain the app record for inspection and a
fresh review; partially completed filesystem deletion is not rolled back.

Keeping local source retains its binding and accepted commit in the existing retained configuration
file. Deleting app data clears settings, mounts and autostart while keeping that source provenance.
Repeated cleanup of an absent installation preserves it too. An explicit reinstall of the exact
canonical manifest restores the binding without committing files, accepting dirty work or rebinding
old worktrees to the new installation. A different manifest cannot silently replace retained local
source. Failing to persist its binding stops uninstall before the installation record is removed.

Unconfirmed installation/removal reviews expire across a Core restart. Recovery requires a new
review; it does not silently repeat a destructive action. Creation and sandbox lifecycle retain their
existing durable original-request replay contracts. Explicitly deleting canonical source keeps
external overrides and worktree files, although the old source installation may no longer support
continued work until the operator restores a suitable binding.

## Verification

[Local QA on 2026-10-17](../../reviews/2026-10-17-harness-app-creation-local-qa.md) covers two real
providers in normal approval mode: Codex generated persistent notes; Claude generated a persistent
counter, repaired a broken client bundle and reused the same child Core. Both previews authenticated
in the browser, retained data across reload and were removed through agent-driven Finish.

[Local handoff QA](../../reviews/2026-10-17-local-app-handoff-qa.md) verifies a real Codex commit,
operator acceptance and ordinary start through Harness, separate authenticated browser data, app
and Harness restart, agent-driven Finish and completed-worktree removal without losing ordinary data.

[Continuation QA](../../reviews/2026-10-17-local-building-continuation-qa.md) verifies existing and
new sessions through Harness, source override/clear, restart and continued development after
completed chats/worktrees are removed. Canonical source remains independent of chat retention.

[Multi-service reuse QA](../../reviews/2026-10-17-multi-service-sandbox-reuse-qa.md) covers replacing
the bootstrap with two services, retained browser-written data, source reload, image rebuild,
observed backend failure, child Stop/Start and Finish through Harness. This operator-driven check
is supplemented by the real-provider generated-stack acceptance below.

[Recovery regression](../../reviews/2026-10-17-app-creation-recovery-regression.md) covers persisted
creation boundaries, request replay after authority changes, writer recovery, failed integration,
publication/runtime failures and preservation of dirty/unaccepted source during ordinary uninstall.

[Real-provider stack QA](../../reviews/2026-10-17-real-provider-app-creation-qa.md) verifies Codex-generated
.NET/Node services and Claude-generated Rust with direct Hosty protocol, real browser authentication,
persistent data, compiled iteration, failed-start/runtime recovery and agent-driven Finish. Source and
canonical Git survive both children. It also covers cancellation, Harness/Core restart, original-request
replay, stale checks and measured agent/application resource use, with explicit platform boundaries.

[Source preservation QA](../../reviews/2026-10-17-app-source-preservation-qa.md) covers D3/D5:
Harness creation/replay, authenticated Docker preview, active-consumer refusals, Finish, reviewed
source changes, stale deletion consent, restart, retained-source reinstallation and explicit deletion.

[Multi-repository QA](../../reviews/2026-10-17-multi-repository-harness-qa.md) verifies one session,
two independent apps and a common child Core through Harness and authenticated browser previews.
It covers cancellation/replay, parent and Harness recovery, close/resume, exact source/data hashes,
unfinished-work deletion refusal and Finish cleanup. A deterministic adapter drives this regression;
it does not duplicate or extend the separately recorded real-provider acceptance.

[Optional checks and repair QA](../../reviews/2026-10-17-preview-checks-recovery-qa.md) verifies
actual Node exits and replay, stale source observations, timeout descendant termination, Docker
build/start failure repair, preserved browser data and Finish through Harness.

[Remote publication QA](../../reviews/2026-10-17-local-remote-publication-qa.md) covers attaching an
existing GitHub remote, reviewed commits, base/branch publication, a draft PR, actual failed/passing
CI and review observations, retry and preserved unmerged source. The test PR was closed without merge.

[Development guide QA](../../reviews/2026-10-17-app-development-guide-qa.md) covers the running
Core's guide through MCP, control, CLI and an authenticated Harness session without a provider.
[Creation form QA](../../reviews/2026-10-17-app-creation-form-qa.md) covers icon/author/consent,
browser draft restoration, authority, original-request recovery and corrected input after refusal.

[Final component verification](../../reviews/2026-10-18-app-creation-final-qa.md) consolidates all
creation deliverables and records full Core/CLI/Harness tests, native/worker builds, Docker transport
and source-mount checks, artifact versions and explicit platform boundaries. The component versions
are Core/CLI 0.140.0 and Harness 0.57.0; local acceptance does not attest to registry publication.

## Testing Expectations

- Every packaged guide topic is bounded, versioned and AOT-serializable; Core MCP, control, Harness
  and CLI return the same content/revision. Unknown topics never read files or expand the catalog.
- Guide reads require existing authority, preserve refusal semantics and allocate no app/worktree;
  normal Harness browser login and on-demand session reads work without an agent connection.
- CLI text/code blocks are unwrapped, JSON preserves metadata, and invalid options fail without
  starting Core. Harness tool discovery marks guide retrieval read-only and forwards bounded topics.

- Local-only and connected source identity, timestamped fetch without pull, create-only base publication,
  explicit unrelated-history integration, stale/replayed requests, source/connection changes and dirty
  file preservation need real local Git coverage. Concurrent remote status/fetch/publication must not
  deadlock. Browser QA covers reviewed commit, separate push, PR, actual CI/review observations and
  recovery of pending actions; local source and unmerged workspace must survive refusals.

- Creation authority, input validation, collisions, symlinks, owner-bound replay and selected author.
- Fixed bootstrap history, separate registered worktree and stopped/autostart-off parent installation.
- Partial creation and changed-package recovery without overwrite or a second bootstrap commit.
- Durable local source survives ordinary data removal and cannot enter managed clone/reset paths.
- Harness preparation/dispatch recovery, one generation prompt, ambiguous dispatch and retention.
- Both providers in shared Docker with normal confirmations; no host home or Docker socket mount.
- Normal child Core login, app launch-code exchange, anonymous API denial, real writes and reload.
- Broken client compilation repaired in the same sandbox; runtime health is not sufficient UI proof.
- Optional checks without recipes; real exit/output, stale review refusal, durable request replay,
  source-writer serialization, timeout descendant termination and unknown execution recovery.
- Failed Docker build and entrypoint repaired in the same child, preserving browser-written data;
  log-read failures clear old snapshots, and Finish removes check receipts with the child root.
- Finish removes exact owned resources while source/worktree remain; test credentials are removed.
- Exact-head local acceptance, dirty/divergent/stale targets, active writers and running ordinary apps.
- Interrupted acceptance and repeated local start, foreign-owner and lifecycle-permission refusals.
- Ordinary Docker data and caches remain separate from preview through reload, restart and Finish.
- Existing-session continuation preserves its worktree; new sessions start from reviewed accepted main.
- Lost preparation responses and restart reuse the original session without starting an agent.
- Dirty/outstanding work blocks deletion; completed chat/worktree deletion retains canonical Git.
- Source override and clearing retain canonical and worktree files and restore the original binding.
- Reviewed multi-service replacement removes obsolete containers without touching another app/instance.
- Full-graph reconciliation retains sibling services and fails honestly on Docker inventory/removal errors.
- Source reload, build revision and child Stop/Start retain test data; service failures remain visible.
- Repeated creation revalidates current authority; permission loss after an uncertain allocation does
  not unlock retention, and a retried refusal becomes pending before sending another request.
- Local acceptance and preview execution wait for pending/unknown Git outcomes; unreadable activity
  cannot prove the canonical target idle. Recovery reuses the original operation and preserves source.

- Removal/source changes reject active, pending or unreadable consumers under repository admission.
- Destructive review detects content-only edits; runtime failure and late edits retain source.
- Repeated keep-source uninstall and restart preserve provenance and all retained source files;
  explicit reinstall does not accept new work or take over an old workspace.
- Explicit source deletion preserves unrelated external folders/worktrees; stale confirmation cannot
  operate on a replacement installation, and expired confirmation requires a new review.
- Two app bindings in one session retain separate worktrees and attachment storage across context
  changes, cancellation and restart; a second-repository admission failure prevents agent startup.
- Partial multi-repository lease release recovers from persisted Docker worker close without losing
  unconfirmed bindings; dirty, unmerged or leased secondary repositories prevent cleanup.
- Cancelled question cards stay inert after replay, preserve recorded answers and leave later-turn
  questions actionable. Shared-child Finish removes consumers without deleting either source tree.

- Creation form consent gating, id suggestions, editable Git defaults and complete draft restoration.
- Storage refusal must prevent allocation; confirmed creation refusal unlocks fields without losing
  the request text. Unknown results and failed provider handoff retain the original replay identity.
- PNG size/dimension/chunk bounds, actual icon bytes in canonical source and worktree, explicit author
  in the sole bootstrap commit, unchanged icon-free fingerprints and changed-input replay refusal.
- Core-managed browser creation with an icon above the former request-body limit, Harness restart,
  same-request recovery, occupied-id correction and unchanged existing source.

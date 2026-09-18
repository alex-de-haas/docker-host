# Assistant Approval Rules

Status: Draft
Created: 2026-09-02
Updated: 2026-09-17

Operator-owned rules for which assistant tools are disabled, ask before execution, or run without
an approval card, beyond the per-app read-only grant that ships today. This is the "second iteration
informed by real usage" that the
[AI Agent Bridge](../ai-agent-bridge/feature.md#approval-posture) deferred when every write became
approval-gated on 2026-08-08. The usage informing it: an operator answering a card for every
`hosty apps update-plan`, and for every repeat of the same command inside one long session.

Everything here is a diff against the shipped assistant in
[ai-gateway](../ai-gateway/feature.md) — its per-app "run read-only tools unprompted" grant, the
Core provider row, and the typed approval cards are the ground this builds on.

## Goal

Let the operator decide, in advance and in the open, which actions of which provider may run without
a card — per tool, for one session, or for a shell command prefix — with every such decision visible
on the settings page, honoured identically by both harnesses, and leaving an audit line whenever it
lets something through.

Owner decision, 2026-09-17: keep the provider enable/disable switch and expose three modes for
each MCP tool in its expandable settings list: **Ask**, **Run unprompted**, and **Disabled**.
The gateway owns MCP enforcement for both Claude and Codex, including the approval pause; it must
not depend on a native harness requesting approval for an MCP call. This records the agreed product
behavior, not implementation approval for this entire Draft or proof of the transport mechanism.

Owner decision, 2026-09-16: the administrator can grant source writes and project-command execution
for any source-capable app selected in a session's context, including existing apps and several apps
in one session. Association alone grants nothing. Routine authorized development must proceed without
one approval card per edit or command. This feature owns the shared development binding and enforcement;
[app context](../assistant-app-context/feature.md) owns selection and
[prototype creation](../app-prototype-workspaces/plan.md) consumes the same grants.

This explicitly weakens the existing "every write asks" policy inside an administrator-approved
development boundary. Provider opt-ins, draft-only third-party messages and external-client read-only
restrictions remain unchanged. [Vision decision 6](../../vision.md) records the accepted direction and
the separate administrator responsibility for executing apps through Core's localCommand runtime.

## First-Slice Scope Decision (2026-09-16)

The owner defers immediate revocation of already-running processes and further experiments on that
mechanism. It remains an unchecked deferred deliverable, not a prerequisite for the first slice.
Permission changes govern subsequent dispatch/resume; already-started commands may retain their
original permissions until they exit. The UI must describe this limitation rather than report that
an active process has lost access. Removing and re-adding context does not restore grants.

Isolation between temporary directories is not a first-slice objective. Temporary scratch space may
be shared by the native harness; no session-private temporary-storage guarantee is offered. The
required boundary protects Hosty apps outside their explicitly granted source roots, Core state and
credentials. Hosty must not move protected data into shared scratch space as a way around that boundary.
Resolve canonical paths: an app Source or Hosty data root physically placed under a broadly accessible
temporary directory is not covered by the successful outside-temp experiment. The first slice must
identify such unsupported protected-root placements rather than promise app isolation there.
This narrows the target scope; it neither approves implementation of the remaining Draft nor changes
the separately accepted localCommand runtime responsibility.

## Target Behavior

### A. Per-tool policy in settings

- Under each enabled provider's row the settings page can expand **the provider's tool list**, read
  from its `tools/list` the way the facade's catalog and the read-only probe already do: name,
  description, and the app's `readOnlyHint` / `destructiveHint` as labels.
- Keep the provider's master enable/disable switch. Each tool, including read-only tools, carries
  one selectable mode: **Ask**, **Run unprompted**, or **Disabled**. The labels describe the
  gateway's behavior, not a grant of missing authority in Core or the target app. Display the
  app's annotations as app-declared hints. A destructive hint remains visible beside the control.
- **Ask** keeps the tool available to the model, but the gateway holds each call for an approval
  card before forwarding it. Approval authorizes that exact provider, tool and argument set.
- **Run unprompted** keeps the tool available and forwards authorized calls without a gateway
  approval card. Core and app authorization checks still apply.
- **Disabled** removes the tool from the model-facing catalog and rejects calls by name, including
  names retained in an existing conversation. A prompt instruction or catalog filter alone is
  insufficient. Disabling the provider takes precedence over all of its tool modes.
- New tools default to **Ask**. During migration preserve existing read-only auto-allow choices
  for tools verified against a complete catalog snapshot; discovery failure must not create an
  unprompted grant. Define this migration explicitly so a later new tool does not silently inherit
  permission from an old provider-wide setting.
- Bind rules to the provider/interface identity and tool name. Prune obsolete rules only after
  authoritative removal or successful complete discovery, never because a stopped provider or
  failed catalog read looks empty. A reappearing tool starts with the new-tool default.
- Policy changes govern subsequent calls in existing sessions. Recheck current policy before
  forwarding a waiting call; an old card or session grant cannot override a disabled tool/provider.
  Refresh advertised catalogs where supported; otherwise show when a session refresh is needed.
  Call-time enforcement must not wait for that refresh. Disabling does not undo an already
  dispatched upstream action.
- These controls cover MCP calls through the gateway's assistant-session route. They do not
  prohibit an equivalent CLI/HTTP action or grant filesystem development access. External facade
  callers retain their existing read-only restriction; this decision adds no external write path
  or remote approval-card workflow.

### B. Session grants from the card

- The approval card gains **Allow for this session** beside Allow and Deny. For an app or Core tool
  the grant is the tool's name; for a shell command it is the command's first word plus its
  subcommand words up to the first argument that is not a flag (`hosty apps update-plan`), shown on
  the button so the operator sees what they are granting before they grant it.
- Session grants live in the gateway's live session only — never in settings, never in the harness's
  own permission store — and end with the session. A new session starts with none.
- A session grant leaves an audit line when it is made and a line each time it lets a call through.
- For MCP, a session grant can satisfy **Ask** only while the provider and tool remain enabled.
  Policy revocation must invalidate conflicting grants and pending decisions.

### C. Shell prefix rules

- Persistent shell rules are **prefix rules in Claude Code's own syntax**, `Bash(hosty apps
  update-plan:*)`, written on the settings page under the Shell heading. The syntax is borrowed so
  an operator who has written one for the CLI need not learn another.
- There is no "run every shell command unprompted": that is `bypassPermissions` under another name,
  and the plan refuses it as an unrestricted shell control. F permits project commands only within
  an explicitly granted, technically enforced sandbox boundary.
- A command containing `;`, `&&`, `||`, `|`, `$(`, backticks or a newline **never matches a prefix
  rule**, and never matches a session grant: a prefix guards the head of one command, and a compound
  command has more than one head. Fail closed.

### D. Where the policy is evaluated

- **Owned by the gateway, for both harnesses.** MCP catalogs and calls are governed at the
  session MCP boundary before upstream dispatch. The existing transparent proxy needs protocol-aware
  filtering and approval handling; this is not implemented by the current byte forwarder.
  **Ask** creates the existing session approval event/card and waits for its decision before
  invoking the app. **Disabled** never reaches the upstream tool. **Run unprompted** bypasses the
  gateway card only after policy and session authorization checks.
- Coordinate adapter permissions so one MCP call produces at most one Hosty approval card and
  **Run unprompted** does not encounter a second native approval for that same call. Any native
  allowance must cover only gateway-controlled MCP routes, never blanket shell/file permission.
  Verify this against both pinned adapters rather than assuming their callbacks or defaults.
- Shell/file approval callbacks continue to consult the shared policy; development grants also
  configure native enforcement and require event-based auditing for actions that do not raise
  callbacks (G). Do not write hidden grants to the harness's own permission store. Native options
  must be derived from the visible Hosty policy, with verified enforcement and audit.
- Bind a pending MCP decision to the session, request and arguments. Resolve denial, cancellation,
  disconnect and timeout without forwarding the held action. Define retry/deduplication behavior
  and restart recovery before shipping, so a retried request or replayed card cannot execute a
  mutation twice or release a stale call. Support the actual JSON/SSE transports used by providers;
  pending approval must not rely on an unbounded HTTP request surviving every client timeout.
- The policy takes the tool name, input and effective session grant revision; a shell rule is about
  the command and a source grant is about the resolved target, not just the tool name.

### E. Audit

- A call the policy lets through reports `ai_action_auto_allowed` to Core with the tool name and the
  rule that matched (per-tool, session, or prefix), the way an approved card reports
`ai_action_approved` today. An unprompted mutation without a trail would be exactly the thing the
2026-08-08 posture existed to prevent.

### F. Development grants for contextual apps

The session's Apps UI exposes explicit **Edit source** and **Run project commands** permissions for
each selected app. Show the Core-resolved source location and effective permissions before granting.
Apps without accessible source remain valid context entries, with development permissions unavailable
and a reason. No Git repository is required. Creating a prototype uses these same controls; an app
menu opening a chat never enables them automatically.

Grants are session-scoped, administrator-owned and revocable. Persist them with a policy revision so
reloads do not ask again; revalidate the actor, app identity, canonical source root and enforcement
availability before each run/resume. They end when the session is deleted or access is revoked. A new
session starts without grants. Missing/replaced source or a changed resolved root invalidates its grant;
app ids alone cannot authorize an unrelated folder after reinstall. Never accept browser-supplied
paths as authority. Generic transient grants in B keep their existing lifetime.

Several contextual apps may receive development grants. Keep the primary cwd explicit and independent
of the permitted root set; do not infer an edit target from checkbox order. Use a shared typed binding
such as `primaryWorkspaceAppId`, resolved through Core, for existing apps as well as prototypes.
Commands can affect every root made writable in their execution environment: show that scope rather
than implying cwd isolates them. Context-only apps remain outside the writable set.

Changes to context and grant removal apply to subsequent dispatch/resume in the first slice.
Removing an app removes its grants for future work and clears its primary binding, requiring an
explicit next target. Already-started commands may finish with their original rights; stopping them
immediately is deferred. Re-adding an app does not restore grants. Reconfigure native threads only
where supported and verified; otherwise require a new native thread under the same Hosty conversation,
with the changed boundary made visible. Never resume a new turn with stale rights.

**Edit source** permits normal reads and changes within granted source roots without cards.
**Run project commands** permits execution within the enforced filesystem/network boundary, including
dependency setup, builds and tests. Commands must not bypass a disabled Edit source permission:
without it, source remains read-only. Package caches and temporary outputs use declared writable
locations; dedicated paths organize outputs without promising isolation within system temporary space.
Toolchains/system libraries have only the access needed to run. Network destinations and
Git publication rights are separate permissions, visible in the grant summary. Source editing alone
does not authorize push, host administration, global package installation or access to other apps.
Explicit Git requests and any separately granted remote/branch authority use the same policy, not a
second per-command approval loop after authorization has already been given.

### G. Enforcement and trusted runtime boundary

`cwd` and shell-prefix matching are not containment. Enforce canonical filesystem boundaries for
file tools and subprocesses, including indirect writes from scripts and package hooks. Test symlinks,
path traversal and changed roots. Restrict sensitive reads through both file tools and shell; write
restrictions alone do not protect neighbouring Core state, secrets or host credentials. Limit inherited
environment credentials and access to host-control endpoints/sockets so commands cannot obtain broad
authority outside the filesystem boundary. Project or user harness settings must not widen the grant.

The Claude experiment establishes separate enforcement paths. Derive `additionalDirectories` for
file tools and sandbox `allowWrite` from the same effective grant, while keeping shell-only cache
directories separate. `acceptEdits` is a candidate for granted source writes, not a permission for
every session: independently verify Edit source without Run project commands and the inverse.
Out-of-root file operations reach the callback and must not inherit general allow rules. Replace
unconditional built-in Read/Glob/Grep auto-allow in development sessions with path-aware enforcement
covering direct reads, search results and resolved symlink targets. Sandbox `denyRead` alone does
not cover those tools. Verify hook/native-policy coverage when a callback is bypassed; a callback-only
read filter must not be assumed complete.

Recommended settings design: exclude writable user/project permission settings from development
queries and construct native policy from Hosty grants. Preserve useful project instructions through
an explicit bounded instruction-loading path; source-local CLAUDE.md is project guidance and cannot
grant tools, expand filesystem roots or override host policy. This is a proposed design pending review,
not a claim that the current adapter already separates instructions from permissions.

Audit every execution path beyond Bash. The auto-allowed Task/subagent and in-process WebFetch paths
must inherit the effective grant or remain unavailable in development sessions until enforcement is
verified. Native sandbox networking does not establish in-process tool or MCP-server egress policy.
The observed shared Claude sandbox TMPDIR is accepted scratch space for the first slice, not a
session-private cache. App source, Core state and credentials remain within the protected-root policy.

Use native sandbox controls where their behavior is verified on the supported host platform. Codex
needs a bounded writable policy instead of today's read-only policy; Claude needs scoped file-tool
authorization and sandboxed commands. Neither `danger-full-access` nor blanket Bash auto-approval is
the implementation. If enforcement is unavailable, show development execution as unavailable; never
silently run outside the boundary. Explicit exceptional authorization remains visible and separate.

The gateway owns policy and audit. Native enforcement is necessary even when a shell/file action does
not produce an approval callback; the MCP boundary in D does not cover these paths. Observe actual tool events
for authorized operations and verify audit coverage on both adapters. An approval callback predicate
alone cannot establish parity or containment. Persist policy decisions, not secrets or full command
output, in audit.

Lifecycle permissions are distinct app/action grants. Core or a narrow trusted execution broker must
validate the requested app and action; an unrestricted hosty CLI/control credential inside the agent
boundary would bypass source restrictions. The first app-scoped lifecycle authority belongs here;
[development controls](../app-development-controls/plan.md) adds runtime-switch operations
using that contract. Existing broad delegated tokens do not gain mutations.

Core-started localCommand apps run outside the assistant sandbox under the Core OS account today.
The administrator accepts responsibility for the code they create and launch, including malicious
behavior. Show this once with development setup/creation; do not add a confirmation for every restart.
Do not claim runtime isolation or secret containment for that app. Editable source plus authorized
Core start/restart can execute arbitrary app code with those runtime privileges, even when the agent's
direct tools are sandboxed. This accepted runtime boundary does not waive direct agent restrictions,
third-party instruction defenses or app/API identity checks.

### H. Experiment before implementation approval

Initial evidence: [Codex experiment, 2026-09-16](../../reviews/2026-09-16-assistant-development-permissions-spike.md).
Installed Codex 0.153.4 on macOS enforced two writable roots and rejected a symlink write outside them;
a real edit/command/edit turn completed with zero approval requests. Legacy workspaceWrite still
allowed reading the synthetic secret outside source. App-server cwd also contributes an implicit
writable boundary: starting it in the parent fixture folder permitted all fixture writes. Resolve
the effective roots and temporary-directory defaults explicitly.

[Claude experiment, 2026-09-16](../../reviews/2026-09-16-assistant-development-permissions-claude-spike.md),
installed SDK 0.3.261 driven by a scripted model mock: `acceptEdits` with `additionalDirectories` plus
a matching sandbox `allowWrite` gave a zero-callback edit/command loop. Out-of-root file writes,
including through a symlink, fell back to `canUseTool`. Sandboxed commands were denied ungranted
roots, parent state, `.git` hooks/config, `.claude` settings, the secret fixture, a denied environment
variable and loopback. The gateway's unconditional Read auto-allow still exposed the secret through the
file tool. User allow rules bypassed `canUseTool` entirely, and project settings inside granted source
widened the shell sandbox.

[Pinned-version verification](../../reviews/2026-09-16-assistant-development-permissions-verification.md)
now preserves reproducible runners under `scripts/experiments/assistant-permissions/` and uses Codex
0.154.0 and Claude SDK 0.3.268. On macOS, the tested native tool paths support independent edit/command
permissions and narrower native-session resume on both adapters. Claude's host PreToolUse guard plus
shell restrictions blocked the synthetic secret; Codex's named profile blocked shell and apply_patch
reads outside temporary paths. The scripts assert observed files and actual tool results, not model prose.

Two Codex findings limit the originally proposed general boundary. The owner scope decision above
defers immediate process revocation and excludes temporary-directory isolation from the first slice.
`turn/interrupt` and a subsequent
`thread/unsubscribe` did not stop a running unified-exec writer: the next turn had narrower rights but
the old process kept writing. Standalone command/exec/terminate worked and must not be confused with
model-tool process control. Separately, fixtures in `/private/tmp` escaped the named profile's expected
write/read restrictions even with a valid default profile, dedicated TMPDIR and slash-tmp deny entry.
The successful outside-temp cases do not prove arbitrary source/cache path isolation.

These results do not complete H within the remaining first-slice scope. The new runners use scripted model responses and a fixed native-tool
catalog; live model generation, code mode, other operating systems, package/network setup, subagents
and the complete create/build loop remain open. The original Claude mock artifacts were not retained;
the new runners preserve the candidate read/settings-exclusion tests but do not yet reproduce every
original user-settings bypass case. Treat failed assertions as unresolved findings, not successful gates.

Run a bounded experiment on both configured adapters with synthetic source and secret fixtures;
never probe real host secrets. First measure the current create/edit/build loop, recording approval
count, elapsed time and failures. Then test candidate grants: routine source changes and project
commands require no repeated cards; writes to ungranted apps and reads of secret fixtures fail through
both file tools and shell. Include multiple granted roots, package setup/network, user/project settings,
symlink attempts, next-dispatch permission changes and native-session resume. Immediate running-process
revocation experiments are deferred by the scope decision above. Check host-control credential
access and report the separate Core-started runtime limitation explicitly. Record OS and pinned harness
versions. Unsupported cases remain documented blockers to the corresponding capability, not assumed
parity. A disposable spike establishes the contract; this Draft does not authorize product implementation.

## Deliverables

- [ ] Run and record H's current-policy baseline and candidate-boundary experiment on both adapters;
      resolve enforcement, audit and lifecycle-authority design before implementation approval.
- [ ] **Deferred — immediate process revocation:** own and terminate model-tool commands or verify all
      old executions have quiesced before claiming their access was revoked. Preserve the failing
      interrupt/unsubscribe regression; further experiments are postponed and do not block the first slice.
- [ ] Implement the first-slice protected-root policy: check canonical app Source and Hosty data paths,
      identify unsupported placements under broadly accessible temporary directories, and disclose
      shared scratch space without promising isolation between temporary folders.
- [ ] Implement session development-grant persistence/revisions, Core-resolved source bindings and
      explicit primary cwd, with multiple granted apps, no-Git sources and stale-root invalidation.
- [ ] Add per-app Edit source / Run project commands controls to the shared context UI, effective
      scope summaries, next-dispatch grant removal and unavailable states; prototype creation consumes the same API.
- [ ] Implement and verify filesystem, command, network and credential boundaries in both adapters;
      handle unsupported hosts and native-thread reconfiguration without silent permission widening.
- [ ] Add app-scoped lifecycle authorization/execution with server-enforced app/action checks,
      separate Git destination authority and audit of grants, revocations and autonomous actions.
- [ ] **Neutralize the confirmed H2 bypass** before shipping the rule UI: the Claude experiment
      reproduced user `permissions.allow` pre-empting `canUseTool` for Bash and file writes. Add
      reproducible coverage against the declared SDK, make settings-source policy authoritative,
      and cover source-local settings widening the shell sandbox. No hidden native settings may
      contradict the grants shown in Hosty. Review the Task/subagent auto-allow (H1) in the same pass.
- [ ] Enforce sensitive reads across native file/search tools and shell; verify independent edit
      and command switches, instruction loading without permission-setting inheritance, declared
      scratch-space policy, and WebFetch/subagent/MCP paths against the same effective grant.
- [ ] Rule model in the gateway's settings store: per-tool modes keyed by provider and tool name,
  with interface identity, all three modes, explicit migration of existing read-only grants,
  shell prefix rules, and validation/pruning against complete authoritative discovery.
- [ ] Protocol-aware session MCP enforcement: filtered catalogs, call-time disabled checks,
      gateway-owned Ask pauses, unprompted dispatch, policy changes and audit on both adapters.
- [ ] Pending MCP request lifecycle: exact-call approval binding, cancellation/denial/timeouts,
      retry deduplication, restart recovery, and no duplicate native/gateway approval prompts.
- [ ] One policy over tool name, input and effective session grants, consulted by both adapters;
      include native sandbox configuration and event auditing where no approval callback occurs.
- [ ] Settings page: provider master switch and expandable tool list with Ask / Run unprompted /
      Disabled per tool, descriptions, hint labels and effective-policy feedback; a Shell section
      for prefix rules.
- [ ] Card: **Allow for this session**, with the grant it would make shown on the button.
- [ ] Compound-command refusal, unit-tested against every separator listed in C.
- [ ] `ai_action_auto_allowed` audit report with the matching rule, and the Core side accepting it
  like the existing gateway actions.
- [ ] Docs: `feature.md` for this feature; the approval posture in
  [ai-agent-bridge](../ai-agent-bridge/feature.md) revised from "no exceptions, no session-scoped
  approvals" to the rules above; the index regenerated.

## Open Questions

- **Verified development boundary.** H must establish the supported OS/harness matrix, sensitive-read
  restrictions, network/cache configuration, grant changes on resumed threads and complete audit events.
  The owner approved the product direction, not an untested enforcement mechanism.
- **Protected-root placement.** The first slice does not isolate temporary folders. Verify canonical
  Hosty app/data paths against the supported boundary; protected roots under broadly accessible temp
  paths must be reported as unsupported. Immediate termination of existing commands is deferred, with
  no promise that a permission change has stopped them. This is separate from localCommand runtime risk.
- **Settings sources in development sessions.** Claude user allow rules pre-empt `canUseTool`, and
  project settings inside a granted source widen the shell sandbox. Choose between excluding writable
  settings sources from development sessions, which also stops the SDK loading project `CLAUDE.md`,
  and validating them against the grant before each run. G recommends exclusion with explicit
  instruction loading. Any validation alternative must address changes after validation and native
  settings merge semantics, not just scan a file once before launch.
- **MCP approval transport and adapter coordination.** The owner selected gateway-owned enforcement,
  so native MCP approval callbacks are not its foundation. Verify held-call behavior and timeout,
  cancellation, retry and restart semantics on both pinned clients and supported provider transports.
  Determine the narrow adapter configuration that avoids duplicate MCP prompts without widening
  shell/file permissions. The current Codex path's native MCP approval behavior remains unverified;
  the new policy must not inherit that uncertainty as its enforcement boundary.
- **Core mutations in the panel.** The panel reaches Core with a delegated token, which never carries
  scopes, so Core refuses lifecycle and update tools on it and `update-plan` / `update` stay on the
  CLI. Giving the panel a credential that can carry `mcp:lifecycle` / `mcp:update` for the operator's
  own session is what turns those into typed tools with typed cards — and what makes a per-tool rule
  for `plan_app_update` possible. Either extend the delegated token with the grants a session-minted
  chain may carry, or mint a scoped credential for the session; both are Core changes and neither
  is chosen here.
- **Tool results in the transcript.** The transcript shows a tool's input and never its result; a
  collapsed result under a shell row would tell the operator what the assistant saw. Results land in
  the persisted event log, so `cat` of a secret file would put the secret on disk in a transcript —
  a decision about redaction or a size cap has to come first.
- **`plan_app_update`'s annotation.** Core declares it non-destructive and idempotent but not
  read-only, because it reaches out to the app's source. A per-tool rule covers it either way; the
  annotation stays Core's call.

## Verification

- MCP policy on real Claude and Codex sessions: Ask shows one card and forwards exactly once only
  after Allow; Deny forwards nothing; Run unprompted completes without a card; Disabled disappears
  from tools/list and rejects a direct tools/call using a previously known name. Confirm effects at
  the upstream app, not only transcript events. Existing Core/app permission refusals still hold.
- Exercise provider disable, tool disable while a card waits, policy changes in an existing session,
  client cancellation/timeouts/retries, reconnect and gateway restart. No stale approval releases a
  call and no retry duplicates a mutation. Cover plain JSON and streaming provider responses.
- Migration and catalog discovery: existing accepted read-only grants survive a successful migration;
  new tools ask; unavailable/partial catalogs do not erase Disabled rules or create permissions;
  confirmed removal/reappearance cannot resurrect an old unprompted grant.
- Live development-grant acceptance on both adapters: one existing no-Git app and one second app;
  context-only selection grants neither writes nor commands. Explicit grants allow repeated edits,
  dependency setup/build/test without cards inside the approved boundary. Ungranted roots, synthetic
  secrets and host-control credentials remain inaccessible; validate through file tools and scripts.
  Exercise independent edit/command permissions, declared caches/network, next-dispatch grant changes,
  remove/re-add, changed source roots and resumed sessions. Record approval counts and actual outcomes.
  Verify protected app/data roots outside scratch space and reject unsupported canonical placements;
  temporary-folder isolation and immediate process-revocation experiments are not first-slice gates.
- Verify an app-scoped lifecycle request cannot target another app, and a source grant alone cannot
  push to a remote. Keep the documented Core localCommand trust boundary visible in setup and tests;
  never describe agent sandbox tests as runtime-app isolation tests.
- Gateway vitest: rule store round trip and pruning; the predicate as pairs (a rule lets the exact
  tool through, its neighbour still asks; a prefix matches its command and refuses the compound
  form; a session grant dies with the session); both adapters consulting it; the audit report.
- Settings page: tool list rendered from a stubbed `tools/list`, labels from the hints, a mode change
  saved and reflected from confirmed state.
- Reproduce H2 and project-settings widening with deterministic SDK fixtures; after remediation,
  neither can bypass the Hosty policy. Include file-tool reads of synthetic secrets and source-local
  instructions that attempt to widen permissions. Use the declared SDK and retain reproducible probes.
- Live, on the dev host: a per-tool rule and a session grant observed to skip the card and to leave
  their audit lines; a real Claude create/edit/build turn complements deterministic enforcement tests.

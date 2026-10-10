---
status: Draft
created: 2026-09-02
updated: 2026-10-10
summary: Explicit session and development grants, native command approval rules, revocation controls and permission-decision audit.
components: [apps/harness]
---

# Assistant Approval Rules

## Scope And Owner Direction

The owner approved this documentation split on 2026-10-10, without implementation. This Draft owns
which permissions an operator grants, their scope and lifetime, confirmation behavior, visible
revocation and decision audit. It does not own containers, filesystem/network enforcement, process
termination or Core operation authorization.

[Agent Session Containment](../assistant-runtime-containment/plan.md) owns the deferred execution
boundary. [Execution Authorization](../assistant-execution-authorization/plan.md) owns trusted Core
execution credentials, and [Workspace Lifecycle Controls](../workspace-lifecycle-controls/plan.md)
owns close and cleanup. Those plans remain independently unapproved for implementation.

## Current Behavior And Target Delta

[The shipped MCP policy](feature.md) already provides Ask / Run unprompted / Disabled, identity-bound
rules, broker-owned approval pauses, stale-call rejection and best-effort audit for Claude and Codex.
[Session autonomy](../assistant-session-autonomy/feature.md) already provides Normal / Autonomous,
including unprompted native commands and file changes. These are dependencies, not unfinished work.

Add narrower reusable permissions for operators who choose Normal, plus an explicit model for
future bounded development grants. Reuse existing MCP enforcement and Core rechecks. There is no new
PR-specific approval preference: source publication and lifecycle operations consume this shared
policy and retain their own actor, repository, app/action and resource checks.

Autonomous remains an explicit administrator choice. Prefix rules are optional controls for Normal;
this plan does not prohibit broad autonomous execution, force a card for every native write or claim
that changing confirmation policy creates a sandbox. In an isolated execution, neither a prefix rule
nor Autonomous can enlarge the boundary enforced by Containment or the authority accepted by Core.

## Target Behavior

### Session Grants From Approval Cards

Offer Allow once, Deny and **Allow for this session**, showing the exact scope before granting.
An MCP grant binds to provider/installation/interface identity and tool definition, not just a tool
name. It can satisfy Ask only while the provider and tool remain enabled and verified. Disabled,
missing authority or an invalid call always wins over a remembered approval.

A native command card may propose an explicit reviewed executable/subcommand prefix. Do not infer
a safe grant by blindly truncating at a flag or argument. The operator sees the proposed rule and
its limits; an ambiguous command remains a one-call decision.

Generic card grants live only in the live Hosty session, never in persistent settings or a native
CLI permission store. Deleting the session, explicit revocation or Harness restart removes them;
closing a browser tab is not session termination. Native reconnect must revalidate identity and
policy rather than replay pending calls. New sessions start without grants. Decide the precise
live-session lifetime before shipping; it must be visible to the operator.

### Persistent Command Approval Rules

Expose native prefix rules in Harness permission settings beside effective native-policy feedback;
Shell embedding does not own a second rule store. Use one provider-independent rule model; a familiar
notation such as `Bash(hosty apps update-plan:*)` is a possible presentation, not the authority model
or a decision to inherit Claude's native permission settings.

A rule authorizes skipping confirmation for one simple command, not its filesystem effects or the
contents of a script/interpreter. Match token boundaries, never a raw string prefix. Compound,
substituted or ambiguous commands must not inherit the head command's rule. At minimum reject `;`,
`&&`, `||`, `|`, `$(`, backticks and newlines; define quoting, redirection, environment assignments,
wrappers and supported shell syntax before implementation. A rejected match returns to normal
approval; it does not create a new restriction on explicitly selected Autonomous mode.

Use the same matcher for persistent and card-created command grants. Native settings cannot silently
supersede Hosty's visible rules. Enable this capability for an adapter only after Containment's
native-policy integration verifies that contract, including execution paths without callbacks.
A shell prefix itself is never advertised as source or network containment.

### Development Grant Model And Controls

Offer distinct **Edit source** and **Run project commands** permissions for source-capable apps in
session context. Show the effective Core-resolved workspace/worktree scope, primary cwd and capability
availability. Several apps may be authorized; context selection alone grants nothing. The primary
cwd is navigation, not the allowed-root boundary. Unsupported source bindings show a reason rather
than an apparent enforced grant.

Persist these deliberate development grants with a revision, separately from transient card grants.
Bind them to the actor, assistant installation, conversation and Core-authorized source/workspace
identity. Consume authoritative bindings from Core and the execution backend; never accept arbitrary
browser paths or app IDs alone as source authority. Missing/replaced sources or changed roots
invalidate a grant. No-Git sources depend on the backend's explicitly supported binding.

Edit source permits routine reads/changes in the approved source scope. Run project commands permits
build/test/setup within the backend's verified boundary; without Edit source, commands cannot write
to source. Show all writable roots, declared output/cache locations and separately granted network
access. Source grants do not authorize global package installation, host administration, writable Git
metadata, push or PR merge. Core operation owners retain local-commit and remote publication semantics.

Revalidate grants before dispatch/resume. Context removal or revocation invalidates future use and
pending decisions; re-adding an app does not restore them. Report when a new execution generation is
required. Revocation is not a claim that already-running commands stopped or that a dispatched remote
mutation was rolled back; Containment and Lifecycle Controls own that evidence.

[App context](../assistant-app-context/feature.md) supplies selection;
[prototype workspaces](../app-prototype-workspaces/plan.md) consumes these same permission controls.
Do not make isolated grants a retroactive prerequisite for the shipped instruction-based workspace
workflow or existing administrator Autonomous mode. If enforced grants are unavailable, show that
fact without silently switching execution mode or weakening Core/MCP checks.

### Effective Policy And Audit

Show confirmed server state, scope, source of each permission and expiry/revocation behavior.
Changes must invalidate conflicting remembered grants and waiting calls. Preserve the shipped MCP
broker's provider identity, tool-definition binding, complete-discovery handling and dispatch rechecks.
An approval never creates missing Core/app authority.

Record grant creation, removal and automatic use with actor/session, policy revision, target and
matched rule, without credentials or full inputs/output. Extend the existing permission-decision
audit rather than claiming a confirmation record proves execution success. Verify native events that
skip callbacks; unsupported audit coverage must be visible. Keep the existing best-effort reporting
limitation unless separately changed; Core-managed operation outcomes retain their own records.

## Ownership And Retired Deliverables

D1-D4 and D7-D10 are retired here and remain unfinished in their owning plans; their IDs are not
reused. The detailed transfer is recorded in
[Containment](../assistant-runtime-containment/plan.md#historical-evidence-and-transfer):

- D1/D2/D4/D7/D9/D10 move to Containment's source/Git, experiments and native enforcement work.
- D3's execution termination moves to Containment; coordinated revocation/cleanup stays in
  Workspace Lifecycle Controls.
- D8's app/action-scoped lifecycle contract belongs to App Development Controls D2-D3/D6;
  execution credential binding belongs to Execution Authorization D1-D3, and Git publication
  retains its PR Lifecycle owner. Permission-decision audit remains D15 here.

D5/D6 retain grant persistence and UI, consuming Core bindings and Containment capabilities. D11/D12
retain command approval rules and Harness settings, without native sandbox implementation or a
Shell-only placement requirement. D13-D16 retain session grants, matching, audit and documentation.
Historical native experiments now inform Containment and are not claims about currently pinned SDKs.

## Deliverables

- [ ] D5. Implement revisioned session development-grant persistence using trusted actor/app/workspace bindings, multiple authorized apps, explicit primary cwd and stale-root invalidation; consume the execution authorization and containment contracts.
- [ ] D6. Add per-app Edit source / Run project commands controls, effective scope and unavailable states, revocation feedback and shared prototype integration; do not imply that context selection or cwd grants access.
- [ ] D11. Specify and implement one native command approval-rule model and effective decision policy over explicit prefixes and session grants, including interaction with Normal/Autonomous and backend capability availability.
- [ ] D12. Add Harness prefix-rule settings and effective permission feedback using confirmed policy; preserve existing MCP controls and avoid a second Shell rule store.
- [ ] D13. Add Allow for this session with an exact pre-grant scope, defined transient lifetime, provider/tool identity binding and invalidation on disable, changed definition or revoked authority.
- [ ] D14. Implement conservative command matching with token boundaries and compound/substitution refusal; test the declared shell grammar and ambiguous inputs for both persistent and transient grants.
- [ ] D15. Extend decision audit to grant creation/revocation and native prefix/development automatic approvals, including event paths without callbacks and honest coverage/reporting limits.
- [ ] D16. Document shipped grant/approval behavior and limitations in feature.md and affected Harness/Bridge docs; delete this plan and regenerate the index only when the remaining deliverables pass.

## Open Questions

- What operator-visible event ends the live-session lifetime of transient card grants, beyond explicit
  revocation, deletion and Harness restart? How is that distinguished from persisted development grants?
- Which command grammar and UI representation can both adapters honor without hidden native rules
  or misleading executable-prefix safety claims?
- What trusted binding and capability response connects grant UI to Execution Authorization and
  Containment, including unavailable no-Git sources and native generations awaiting reconfiguration?
- Which revocation controls and audit view are needed in the first delivery? Define outcome and
  coverage wording without conflating policy decisions with execution completion.

## Verification

- Exercise transient MCP grants on both adapters: exact identity/definition matching, no duplicate
  prompt, Disabled precedence, authority changes between approval and dispatch, revocation, reconnect,
  restart and new-session isolation. Preserve existing timeout/cancellation/retry behavior.
- Verify explicit prefix previews, token boundaries, the listed separators, substitutions, quoting,
  redirects and wrappers. Ambiguous cases do not auto-approve. Test equivalent provider behavior and
  ensure no rule is secretly persisted into a native CLI permission store.
- Verify Normal, explicit unprompted rules and Autonomous interactions without changes to Core
  authorization or containment scope. Require the backend's native-policy evidence before exposing
  effective native controls; repeat its conformance checks after adapter changes.
- Verify persisted development grant ownership/revisions, multiple apps, context-only entries,
  independent edit/command controls, stale roots, remove/re-add and confirmed UI state. Check that
  unavailable enforcement and pending generation changes are represented honestly.
- Observe grant/revocation/automatic-use audit without secrets, and distinguish decisions from
  operation outcomes and process-stop evidence. Runtime escape and termination acceptance belongs
  to Containment; coordinated close acceptance belongs to Workspace Lifecycle Controls.

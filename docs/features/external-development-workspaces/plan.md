---
status: Ready
created: 2026-10-07
updated: 2026-10-07
summary: Let local external assistants prepare Core-owned worktrees through authorized MCP and expose their changes in Plans.
components: [apps/core, apps/plans, apps/shell]
---

# External Development Workspaces

## Goal

Let a local Codex, Claude Code or other external assistant request a registered development
workspace, edit the returned directory, and have Core and Plans observe its source and plan changes.
The assistant and Core run on the same machine. A remote Core path is not a local workspace.

## Target Behavior

Reuse [session workspaces](../assistant-session-workspaces/feature.md), including shared bare
repositories, linked Git worktrees, target refs, observation and managed operations. Add an explicit
external owner rather than impersonating an installed assistant or creating a Harness conversation.
Core records development identity and evidence; the external application owns its conversation.
No model run or conversation import is needed to register development work.

An external owner binds the current administrator, an authorized external MCP principal, a stable
opaque external-session identifier and a display label such as Codex. Session identifiers and labels
are not credentials. Preserve all existing installed-assistant owner identities and allocation IDs
when extending serialized records; changing owner serialization must not silently rekey old work.

Direct Core MCP exposes workspace preparation, owner-scoped listing/observation, diff and the
existing managed Git/lifecycle operations. A new explicitly reviewed workspace authority scope is
required in addition to ordinary read access. Workspace source-byte and diff reads require this
workspace authority too; metadata-only read credentials do not gain source access. Read-only and
delegated facade credentials stay read-only. Credentials identify the current caller; tools cannot select another administrator,
installation or external principal by supplying their identifiers.

Preparation returns workspace ID, absolute directory, branch, target branch and base commit.
Repeated requests use the existing UUID replay/argument checks and reuse the same owned binding.
Native edits and commits in that directory are visible through the existing observer, including
uncommitted plan edits. Existing current-administrator, private-source, grant-revocation and source
ownership checks apply to every request. The control secret is never handed to an external agent.

The first version creates Core-owned worktrees. Adopting arbitrary existing Codex worktrees is
excluded; it needs a separate ownership and cleanup design. Instructions can explain an explicit
operator-reviewed patch transfer when migrating existing work, without silently copying dirty files.

External records have no assistant session URL. Plans and source/workspace views show
External / Codex, the workspace branch, source state and observed time. An absent external-session
link is expected, not an assistant-uninstalled error. Plans keeps tracked-branch progress separate
from each workspace version; the app stays a read-only view of Markdown.

Activity leases and cleanup keep their existing conservative rules. A disconnected client or expired
MCP credential does not prove its native processes stopped. Revoking MCP access does not revoke
the external program's operating-system access to an already supplied directory. These are local
cooperation instructions, not a Hosty filesystem sandbox.

## Approved Decisions (2026-10-07)

The owner approved the following decisions on 2026-10-07. Implementation follows completion of
Plans and remains tracked by the unchecked deliverables below.

- **Connection and authority:** Use the existing direct Core OAuth consent flow, extended with an
  explicit own-workspace permission. Require it for source/diff reads as well as mutations. Do not
  grant app lifecycle or publication authority implicitly. A manually issued scoped credential is
  an optional fallback, with its own stable credential identity.
- **Connection and task identity:** Bind the external principal to the current administrator and
  durable OAuth grant, not its rotating access token. Use a separate opaque task ID for each work
  context; require no Codex-specific conversation API. Token refresh preserves bindings. A new
  grant does not inherit an old grant's workspaces automatically. Recommend logical task separation
  within one connection, with authorization isolation between grants. Strong per-chat authority
  requires separate grants or a separately designed Core-issued child credential; a task ID alone
  is not that authority.
- **Source selection:** Recommend initially preparing source for installed apps, using their
  existing repository, target-branch and private-source rules. Arbitrary unregistered repositories
  require an explicit source-onboarding and authorization design. Core-created worktrees remain
  the proposed first-version boundary; existing Codex worktrees are not adopted implicitly.
- **Git and completion:** Recommend exposing the existing managed workspace Git, lease and cleanup
  operations. Native file edits remain observable. Commits, merges and cleanup follow explicit
  user/repository authorization; closing the client never deletes source or releases activity
  implicitly. Publishing PRs and selecting app runtime source are separate authorities/workflows.
- **Packaging:** Recommend verified provider-neutral instructions and local MCP setup guidance
  first, with a short repository entry point. A Codex skill/plugin can package the same workflow
  later; it is not required to create or observe the workspace. Conversation import remains in
  the separate external session-context plan.

## Agent Instructions

Package guidance against shipped tool names and verified local MCP capabilities:

- Select the intended local Hosty instance and obtain the explicitly reviewed workspace authority.
- Prepare a registered workspace before source edits; work in the returned directory.
- Read repository instructions and the approved feature plan before implementation.
- Update plan status and deliverable checkboxes in the working copy as soon as their required
  verification passes. Do not defer progress to PR creation or merge, or mark unverified work done.
- Keep tracked-branch and workspace versions distinct; do not edit main merely to update Plans.
- Use existing request IDs after uncertain operations; preserve leases and observed cleanup rules.
- Follow repository/user authorization for commits, push, PR creation, merge and cleanup.

History exchange and attributed report import remain in
[external agent session context](../assistant-external-session-context/plan.md). They are separate
from this independently useful workspace workflow.

## Deliverables

- [ ] D1. Add typed external owner records and optional session links while preserving installed-assistant bindings, allocation IDs and restart compatibility.
- [ ] D2. Add explicitly authorized, owner-scoped Core MCP workspace tools without broadening existing read-only or facade access.
- [ ] D3. Reuse preparation, observation, private-source access, durable operations, activity leases and cleanup for external-owned worktrees.
- [ ] D4. Expose external identity and expected missing session links in Plans and workspace/source views without losing tracked-branch or workspace evidence.
- [ ] D5. Package verified local-agent setup and development instructions, including immediate verified deliverable updates and repository commit rules.
- [ ] D6. Verify the real local external-agent journey, authorization/revocation, owner isolation, replay, compatibility and conservative cleanup; publish current feature documentation.

## Verification

- Connect a local external agent to the intended local Core through ordinary reviewed authority.
  Prepare a workspace for an installed source app and inspect the actual returned directory.
- Edit a plan without committing. Within the observer cycle, Plans shows the external workspace
  version alongside the unchanged tracked branch, with its own status and deliverable progress.
- Two external sessions changing one plan remain separate. Existing Harness workspaces still reuse
  their original bindings and session links after upgrade/restart.
- Read-only credentials cannot prepare or mutate source. Another principal cannot claim a
  binding belonging to another grant. Tasks sharing one grant remain separate allocations, not
  separate authorization boundaries; an expired/revoked grant cannot invoke tools. Workspace
  source/diff reads require workspace authority. Private-source ownership is revalidated.
- Retry an uncertain preparation with the same request ID. Check normal Git operation recovery and
  refusal of dirty, leased, unmerged or runtime-consumed cleanup.
- Verify source versions with real Core/Plans lifecycle, not a standalone app or fabricated identity.
  Run affected Core/MCP and UI tests, exact Core build, Native AOT, docs and version checks.

## Approval

The owner approved this plan as Ready on 2026-10-07. The existing Plans implementation does not
grant external workspace authority; that interface belongs to this separate approved feature.

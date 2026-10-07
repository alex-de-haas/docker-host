---
status: Draft
created: 2026-09-26
updated: 2026-10-07
summary: Let an authenticated local external agent read a Hosty session, work in its registered folders and save a report back.
components: [apps/harness]
---

# External Agent Session Context

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

This is lower priority than internal switching and remote clients. Support an authenticated local
external agent receiving environment + session id (or selecting it), reading shared history and
registered paths, performing requested work, and explicitly saving an attributed report/summary.
Local external worktree registration is owned by
[external development workspaces](../external-development-workspaces/plan.md). This context-exchange
feature uses that registry when source is needed; it does not duplicate workspace preparation.
No server-hosted model needs to be started merely to register external development work.

Hosty independently observes diffs and Git/PR facts. Saving external context must not implicitly
start an internal turn. Prefer available transcript fragments with source ids when explicitly
requested; label model-written summaries as summaries, not complete imported history. Deduplicate
repeated uploads. Automatic Codex transcript extraction/synchronization is excluded from this scope.

Use AHP for supported reads and MCP/API for Hosty-specific preparation/report operations. AHPX's
current `session import` saves a local CLI record; it does not upload history to the live server.
Do not base the workflow on that assumption. A read-only facade credential stays read-only; design
an explicit local authorization route for the new writes without exposing the Core control secret.

A possible Codex plugin packages MCP configuration, skills and setup guidance; a short repository
`AGENTS.md` explains how to use it. CLI installation is only needed if the chosen integration uses
that CLI. Teach the agent to use registered worktrees and read/save context at user-requested points.
Plugin packaging cannot be assumed to grant full Codex transcript access.

There is no mandatory external/internal ownership transfer. Show participant activity and possible
overlap; instructions ask cooperating agents to avoid concurrent edits. A local external agent with
unrestricted OS access remains outside Hosty's enforceable filesystem boundary. A heartbeat or lease
is not proof that its processes stopped. Do not claim this best-effort coordination is sandboxing.

## Pinned CLI Evidence

AHPX is a third-party CLI. At inspected commit `a178119ec56ec467cef7c0794a9991315dc8974c`, the
[import implementation](https://github.com/TylerLeonhardt/ahpx/blob/a178119ec56ec467cef7c0794a9991315dc8974c/src/bin.ts#L2441)
saves a local session-store record. Pin/recheck the selected CLI before shipping instructions;
do not turn that observation into a promise about every future version.

## Deliverables

- [ ] D1. Implement authorized explicit assistant-session reads and attributed report import with
  deduplication.
- [ ] D2. Package local external-agent instructions and optional CLI/plugin configuration against verified
  capabilities.
- [ ] D3. Expose external activity/coverage and conflicting-write indicators without claiming OS enforcement.

## Open Questions

- What history/diff evidence remains after cleanup, and what is the narrow local authority and packaging
  for explicit external-agent context exchange? A session id alone is not authorization.

## Verification

- On local Hosty, an external client explicitly reads a session, uses its worktree and saves a
  summary; the internal agent continues with that evidence. Re-upload is deduplicated, saving alone
  triggers no model run, read-only credentials cannot write, and direct-access coordination is labelled
  honestly. Remote direct filesystem editing is not an acceptance requirement.

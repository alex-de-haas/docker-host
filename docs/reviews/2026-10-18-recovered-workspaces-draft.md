# Recovered Workspaces Draft And Source Audit

Baseline: `a7f215dd279a199f2f452853ac5b726534fd6921`, 2026-10-18.

The retained external task `b67285a3-ed58-470e-a430-cf54f345053f` has seven uncommitted
Markdown files. Its original Workspaces draft was never committed at that path in main's history.
The complete draft is preserved below; relative links are relocated for this archive. Its original
SHA-256 is `0e17e58e044710eb4076400b579ed405384a15dd534c5a6375fd9b80dc5af657`.
The original worktree is retained; this report does not authorize discarding its files.

## Comparison With Merged History

| File | Evidence |
| --- | --- |
| `replaceable-ui-clients/plan.md` | Exact bytes in `cc4b01117cb718abad9c832b84acc9b96c7a7e02` (PR #566). |
| `default-applications/plan.md` | Exact bytes in the same merged commit. |
| `core-extension-model/plan.md` | Older date and link to the Workspaces plan instead of the shipped feature; remaining text preserved in #566. |
| `plan-provider-interface/plan.md` | Older date/link and absence of later Deferred Association Ideas; original text preserved in #566. |
| `docs/vision.md` | Older date/link and absence of later decisions 24–26; original text preserved in #566. |
| `docs/root.md` | Prose outside the generated index matches `a3a3a9a363b59040f2a9d8f68e196bc9eca87cd6`; the generated index is obsolete. |
| `workspaces-app/plan.md` | No exact committed version; preserved below. |

## Interpretation

This is an archival Draft from 2026-10-08, not an active plan or permission to implement its old
checkboxes. [Workspaces](../features/workspaces-app/feature.md),
[Harness development UI](../features/harness-development-ui/feature.md) and
[workspace lifecycle](../features/workspace-lifecycle-controls/feature.md) describe shipped behavior.
The draft's original verification-history and activity-timeline questions remain historical proposals;
this preservation does not silently add them to the approved recovery scope.

## Original Draft (Links Relocated)

```markdown
---
status: Draft
created: 2026-10-08
updated: 2026-10-08
summary: A standalone workspace app showing every authorized Core workspace, source changes, ownership, publication evidence and lifecycle state.
components: [apps/core, apps/shell, apps/harness, apps/plans]
---

# Workspaces App

## Goal And Owner Direction

On 2026-10-08 the owner chose a separate runtime app for workspace inspection. Workspaces is an
ordinary UI consuming Core APIs with reviewed permissions; it does not introduce a provider role.
Keep specialized source UI outside Shell and keep plan interpretation in Plans. This Draft develops
the agreed direction; API, permission and interaction details still need resolution before Ready.
See [platform vision decision 21](../vision.md).

The immediate problem is discoverability: a prepared, clean workspace must be visible even when
it changes no files and no plan. Plans' document-change projection cannot serve as the inventory.

## Current Boundaries

- [Core workspaces](../features/assistant-session-workspaces/feature.md) own the registry, Git worktrees,
  observations, leases and managed operations. Direct operator APIs are not automatically callable
  by an installed runtime app, even when its human user is an administrator.
- [External workspaces](../features/external-development-workspaces/feature.md) use the same registry but
  have an external principal and task instead of an installed assistant and session URL.
- [Plans](../features/plan-tracking/feature.md) interprets Markdown and document progress. Harness owns its
  conversations; another assistant owns its own sessions. Workspaces owns neither.
- [Publication lifecycle](../features/assistant-pr-lifecycle/feature.md) owns PR observations and completion
  evidence. Its existing owner-scoped endpoints need an explicit authorized inspection projection
  for this app; source permissions alone must not be assumed to authorize publication data.

## Target Experience

The app opens with a searchable inventory and a workspace detail page. Show all authorized active
records, including clean, preparing, unavailable and externally owned records; provide a separate
filter for released history. Filters can cover repository, owner, state and changed/unchanged source.
An empty list, an unreadable observation and a clean worktree are different results.

The detail page groups the following information:

| Area | Information |
| --- | --- |
| Identity | Workspace ID, repository, branch, target, original/integration bases and host-local path |
| Ownership | Installed assistant and session, or external agent label and task; authorized user context |
| Source | Local changes, commits, changed files and diffs, ahead/behind state and conflicts |
| Applications | Repository/subpath bindings, files mapped to affected apps, shared or unmapped files |
| Runtime use | Actual source consumers, selected versus running revision where known, and activity leases |
| Publication | Existing PR links, observed draft/open/merged/closed state, CI, review and completion evidence |
| Verification | Available test/build results, evidence origin, timestamp and exact tested revision |
| Activity | Core-recorded operations, pending/failed/unknown outcomes and observed state changes |

Distinguish uncommitted changes from the cumulative original-base comparison and from divergence
against the current target. Name each comparison. Associate changed files with declared app subpaths
without claiming that shared-code impact is exhaustively inferred. A Core-host path is informational;
it need not exist on the browser's machine.

Show observation time, stale/unavailable state and errors beside the affected data. A recorded PR URL
is a reference, not proof of provider-observed state or merge. A lease does not prove that an agent
is running. A native edit has no attributed managed-operation audit event unless Core recorded one.
Test evidence applies to its recorded revision; later edits invalidate any claim about current files.
Missing evidence stays unknown. Do not infer a percentage of task completion from Git or CI state.

The conversation action is **Open session**, targeting the workspace's owning assistant installation
and recorded session. It does not create a discussion and ignores the default assistant preference.
Show an explicit unavailable state after owner removal or when no session link exists. External
agents currently have no imported conversation URL; displaying their label and task is useful alone.
Do not assume multiple associated sessions until the ownership model actually supports them.

## Integration And Scope

Give Workspaces ordinary app navigation and a stable workspace-ID deep link usable by assistants
and Plans. Resolve destinations through installed app metadata and normal app authentication.
Cross-app links must not require Shell to read source. Remove the existing Development workspaces
launcher section below Core on the Shell dashboard when the replacement entry point ships.

The initial inspection surface is read-only, including refreshing observations where explicitly
supported. Creating, committing, publishing, merging, switching runtime source and cleaning up are
separate operations; do not add mutation authority merely to render their state. The later control
design is tracked by D12 and must settle its scope before implementation.

Plans can link to a workspace and Workspaces can expose a related-document link where a real
association exists. Parsing plans, tracking their deliverables and fabricating associations from
repository co-location are outside this app. The exploratory
[plan-provider contract](../features/plan-provider-interface/plan.md) and
[default applications](../features/default-applications/plan.md) are not launch prerequisites.

## Deliverables

- [ ] D1. Add the independently versioned Workspaces runtime app with ordinary manifest, installation, identity, standalone and embedded navigation.
- [ ] D2. Expose an app-authorized Core inspection contract for inventory, detail and bounded diffs, with reviewed grants and current user/source checks; resolve publication access separately.
- [ ] D3. Implement the inventory and detail navigation, including clean, external, unavailable and released records, filters and independent errors.
- [ ] D4. Show named Git comparisons, file status and diffs, commits, target divergence and conflicts without equating missing observations with clean source.
- [ ] D5. Show app bindings, qualified file impact, runtime consumers and leases without inferring active execution or deployment from a binding.
- [ ] D6. Show owner context and open the owning session generically across assistants; represent missing external and removed-installation links honestly.
- [ ] D7. Present existing PR references and authorized publication observations, CI/review evidence, completion state and freshness, including records without publication data.
- [ ] D8. Define and expose available verification evidence with producer, revision and timestamp; distinguish missing, stale, passed and failed results.
- [ ] D9. Present recoverable operation state and a factual activity timeline, distinguishing managed actions from unattributed observations.
- [ ] D10. Add authorized workspace deep links from assistant/source contexts and Plans, and replace the Shell dashboard launcher with ordinary app navigation.
- [ ] D11. Verify the complete inspection flow through Core-managed runtime lifecycle, document shipped behavior and permissions, and update the generated index.
- [ ] D12. Design a later explicit control surface for selected lifecycle operations, including refresh, publication references and cleanup; settle operation scope and authorization before adding controls.

## Open Questions

- What is the narrow permission/API split for registry metadata, source diffs, publication evidence
  and runtime consumers? Existing full-source grants and direct-admin routes are not the answer by
  default; choose and document actual enforcement points.
- Which observations already have sufficient persisted history, and what retention is needed for
  an activity timeline and revision-bound test evidence? Extend the owning services rather than
  storing a second authoritative workspace registry in the UI.
- How should clients discover this ordinary app's workspace destination without declaring it a
  provider? Use existing app navigation where possible; do not block the first app on general defaults.
- Which lifecycle controls belong in Workspaces, and which should remain with the owning assistant?
  D12 is exploratory; no Publish, Merge or Cleanup action is approved by this document.

## Verification

Test app identity and grant revocation, private-source filtering and bounded diff access. Exercise
clean and dirty workspaces, another compatible assistant, external owners, removed owners, released
records, unavailable source, stale observations, conflicts, active consumers and interrupted
operations. Verify fresh versus stale PR/check evidence and revision-bound test results. Check both
Core-managed embedded and standalone entry points; standalone-only tests do not prove integration.
Build affected artifacts and run their focused tests. This planning change requires only the docs
validator; it claims none of that implementation acceptance.

```

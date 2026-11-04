---
status: On Hold
created: 2026-11-04
updated: 2026-11-04
summary: Retain completed workspace history while releasing source storage, restore source on Resume, and archive completed workspaces separately from deletion.
components: [apps/core, apps/harness]
---

# Retained Workspaces Without Resident Source

## Goal And Scope

The operator requested a separate plan on 2026-11-04 and explicitly deferred implementation to another registered workspace after the current visual changes. This plan does not authorize cleanup, migration or deletion of existing workspaces.

Compared with [current lifecycle behavior](feature.md), Complete releases recoverable working directories while preserving the logical workspace, attached chats, membership, PR links and retained artifacts. Resume reconstructs source. Archive controls visibility independently of source allocation. Delete remains the explicit final removal operation.

## Target Behavior

- Complete retains current all-repository clean/merged checks and exact completion evidence. Source release must coordinate known consumers and verify stopped native writers; it must never borrow unconditional Delete authority or remove unfinished work silently.
- Preserve repository identity, target, exact completed commit, branch intent and app bindings. Retain Git references so garbage collection or remote branch deletion cannot remove the commits needed for recovery. Shared Git objects remain; resident worktrees, dependencies and reproducible build output can be released.
- Persist useful reports and attached artifacts outside disposable source before release. Explicitly classify ignored/untracked files and generated data; Git cleanliness alone does not prove those files are disposable. Do not promise restoration of discarded local configuration, dependency caches or unexported files.
- Resume materializes every repository at its retained commit and verifies bindings and current authority before reopening work. It does not silently rebase to the latest target or automatically restart agents, apps or previews. Partial multi-repository restoration is recoverable under the original request.
- Archive hides a completed workspace from the default list; an archived filter makes it discoverable. Unarchive restores visibility without materializing source. Resume makes the workspace active and visible. Lifecycle, archive visibility and source allocation remain separate dimensions.
- Delete uses the existing explicit operation for final removal, including retained-only and partially restored workspaces. Automatic chat retention continues to protect attached chats; neither Complete nor Archive enables time-based workspace deletion.
- Existing completed workspaces retain source until an explicit authorized release; no rollout-time sweep. Existing released/deleted records must not be presented as restorable without complete recovery evidence.

## Deliverables

- [ ] D1. Specify durable retained-source metadata, archive ownership semantics, artifact retention and legacy migration, including recovery guarantees and storage accounting.
- [ ] D2. Implement recoverable Complete source release across repositories and consumers, preserving completion evidence and retained artifacts.
- [ ] D3. Implement recoverable Resume materialization at retained commits with current authorization and source validation.
- [ ] D4. Add Archive/Unarchive, archived navigation and explicit Resume behavior without automatic source allocation on viewing history.
- [ ] D5. Integrate final Delete, session retention, source observation and recovery for retained-only and partially released/restored workspaces.
- [ ] D6. Verify failures, retries, restarts, disk reclamation, history/artifact retention and restore fidelity in managed sandboxes; update feature documentation and release versions.

## Open Decisions Before Ready

- Is archive visibility shared by all workspace participants or personal to each operator?
- Which artifact locations are durable today, and what explicit export policy covers files stored only inside a worktree?
- Should Complete coordinate stopping owned previews automatically, or require an explicit combined completion choice when consumers still use source? Account for live app trials and unknown external writers.
- Define retained branch naming and restoration behavior when repository bindings, credentials or the target branch have changed.
- Define how existing completed workspaces can explicitly release disk space without implying blanket migration approval.

## Verification

Cover dirty/unmerged source, ignored valuable files, active and abandoned leases, live app consumers, revoked grants, deleted remote branches, Git garbage collection, multiple repositories, disk exhaustion and interruption at every release/materialization boundary. Replaying request IDs must never duplicate destructive effects. Verify attached chats and exported artifacts remain readable after release and archive, and restored source matches the retained commits. Verify default/archived filters and shared or personal visibility according to D1.

Use a separate registered Core workspace and owner-managed test sandbox. Measure reclaimed storage without deleting shared repositories or unrelated caches. Finish test resources through their owners. Publication, live-data trials and removal of existing user work require their own authorization.

## Related Features

- [Workspace sessions](../workspace-sessions/feature.md)
- [External development workspaces](../external-development-workspaces/feature.md)
- [Workspace live activation](../workspace-live-activation/feature.md)
- [Harness development UI](../harness-development-ui/feature.md)

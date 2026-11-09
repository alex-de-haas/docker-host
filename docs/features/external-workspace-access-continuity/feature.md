---
created: 2026-10-29
updated: 2026-10-29
summary: Existing app and initiating-user permissions cover all Core workspaces, with stable allocation identity and one UI/MCP Delete operation.
components: [apps/core, apps/harness]
---

# Workspace Permissions And Deletion

Workspace authority is the intersection of the application's existing operation permission and the
initiating user's current rights. Authorized callers can list, inspect, edit and delete all retained
Core workspaces, including source created by other apps, users, sessions and credentials. Harness
currently requires an enabled administrator. A privileged service credential cannot substitute for
an absent, disabled or unauthorized initiating user.

## Stable Source And Current Authority

`WorkspaceOwner` and participation records retain allocation identity and attribution. They preserve
existing IDs, absolute paths, branches, accepted operation receipts and activity through migration.
Creator/session/grant equality and historical membership do not add an access restriction. Selecting
or attaching a workspace establishes a session's context; no sharing grant or copying is required.
Collection inventory and deletion work without a primary workspace or a creating conversation.

Application permission and user checks remain current on calls. Read-only workspace inspection cannot
perform source mutations. Direct external tools require the existing `mcp:read` and `mcp:workspaces`
scopes. App calls use their operation permission and the forwarded initiating-user identity. Delegated
and background calls retain their user context; revocation does not fall back to a service administrator.

Private chats, provider credentials and publication permissions remain separate. Local retained source
can survive a creator's credential replacement or provider disconnection. Remote Git operations require
the acting user's authorized connection; access to another user's workspace does not borrow theirs.
Native filesystem access remains cooperative and is not retroactively revoked by an API permission.

## One Delete Operation

Harness shows one red Delete action in every workspace state. Its single informational dialog reports
unfinished changes, local branches, temporary test data and activity. Inspection is optional, including
when details cannot load. Confirming invokes the same coordinator as MCP `delete_workspace`, with only
a target and stable request ID. Complete, Pause, Commit and manual lease recovery are not prerequisites.

The coordinator records intent, fences new managed consumers, finishes attached test resources, and
requests Stop/Return for known app source consumers. Actual failures retain a retryable request.
Unknown external process exit and the running Core's process are reported separately; removing source
does not claim those processes stopped. Worktree leases are retired on removal. Registered allocation
and path checks remain, so a replaced symlink does not authorize deleting unrelated directories.

Single and bulk requests preserve their accepted identities after timeout or restart. A bulk request
freezes its original allocation set; replay excludes later and recreated workspaces. Results report
per-workspace removal/failure and consumer outcomes. Legacy accepted cleanup/discard receipts remain
recoverable. The old `cleanup_workspace` MCP entry is retired from discovery.

Explicit MCP **Ask** asks once in Normal and Autonomous chats; **Run unprompted** adds no prompt;
**Disabled** hides the tool and refuses stale dispatch. Core has no second confirmation requirement.
Default, unspecified tool policy retains the existing chat-autonomy behavior. A user-requested cleanup
condition, such as only completed and merged workspaces, belongs to target selection for that task;
it does not constrain an explicit unconditional Delete.

See [workspace sessions](../workspace-sessions/feature.md),
[lifecycle and recovery](../workspace-lifecycle-controls/feature.md#unified-delete-and-recovery),
[external clients](../external-development-workspaces/feature.md), and
[MCP policy](../assistant-approval-rules/feature.md).

## Testing Expectations

- Verify cross-app/user/session/credential access, immutable allocation identity and legacy receipts.
- Deny missing app permission, read-only mutation, invalid/disabled users and revoked credentials;
  retain private chat/provider boundaries and initiating-user propagation.
- Exercise dirty/unmerged/ignored source, active/unknown leases, partial preparation, managed resource
  stop failure, missing paths, symlink replacement, lost responses, restart and fixed bulk replay.
- Recover completed UI requests without hiding Delete for replacement allocations; verify Return from
  active dev runtimes preserves ordinary app data and uses the same planned and applied arguments.
- Test one visible Delete action and advisory dialog states; exercise canonical direct/brokered MCP
  transport with explicit Ask, Run and Disabled in both chat modes.
- Build Core/Harness and run affected tests, plus multi-user acceptance and browser checks in a
  Core-managed sandbox with normal password authentication and parent-owned resource cleanup.

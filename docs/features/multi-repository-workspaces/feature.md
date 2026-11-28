---
created: 2026-11-27
updated: 2026-11-27
summary: One workspace prepares the named Git repositories of an installed application as separate worktrees.
components: [apps/core, apps/harness]
---

# Multi-Repository Application Workspaces

Core 0.188.0 adds named Git sources to the existing manifest schemas. An installed application
can group its editable service repositories in a single [logical workspace](../assistant-session-workspaces/feature.md).
Core prepares all the required repositories at once. Services that share a canonical Git
repository share one worktree.

## Manifest

Use the app-level `source` for one repository. With `sources`, use a keyed object and set a
service's `sourceRef` to an entry name. Set `primarySource` to the entry that supplies app-level
manifest and runtime source information when the app uses those operations. This fragment shows
the source declarations in an otherwise complete manifest.

```json
{
  "sources": {
    "api": { "type": "git", "repository": "https://github.com/example/api.git", "branch": "main" },
    "web": { "type": "git", "repository": "https://github.com/example/web.git" }
  },
  "primarySource": "api",
  "services": [
    { "key": "api", "sourceRef": "api" },
    { "key": "web", "sourceRef": "web" }
  ]
}
```

Validation rejects a manifest containing both `source` and `sources`, and rejects a
`sourceRef` or `primarySource` that names an undeclared entry. The designated primary is the
app-level runtime source. Other service worktrees are available for editing.

## Preparation And Recovery

Preparation uses the installed manifest. Core includes its designated primary and every source
referenced by a service. Each worktree targets that source's declared `branch` or its Git
repository's default branch. The existing explicit `targetBranch` overrides the primary's
branch. Conflicting explicit targets for one canonical repository are invalid.

A named preparation returns the registered worktrees, individual failures and activity leases
in `preparation`. The top-level worktree fields identify the primary or a representative worktree.
`workspaceId` identifies the group. Inspect `preparation.complete` before treating it as ready.
Single-repository preparation returns its usual worktree response.

Core checks source access per repository. For an additional private source, pass the initiating
user's authorized connection ID by source name in `sourceConnections`. The primary uses its
reviewed app Git connection. Additional local Git paths are available to trusted local manifest
installations and relative paths resolve from the original manifest directory.

For incomplete preparation, retry with the original request ID and arguments after restoring
source availability. Core retains the worktrees that are already prepared and their edits.
After a reviewed manifest update, prepare again with a new request ID to use the updated
sources. Current bindings appear with the new source, while replaced worktrees retain their
original branches, paths and files. Git operations address each worktree by ID.

## Testing Expectations

- Cover legacy and named manifest validation, the primary release pin and existing package execution.
- Prepare two service repositories with independent branches, including services that share one repository.
- Verify that repeated and interrupted preparation preserves edits and worktree identities, checks
  each repository's access, and reports its disposition.
- Exercise replacement with dirty worktrees and verify workspace inventory and native lease cleanup.

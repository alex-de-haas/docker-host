# Source, workspaces and Git

The app has a canonical local Git repository under the parent Core app source directory.
Only Core manages that checkout. Use the registered session worktree for edits.
The fixed bootstrap commit is creation consent; later commits, push and publication require
their own authorization. There is no remote by default. Never reset another workspace or
replace the canonical source. Core workspace tools manage Git; the Docker agent does not need
write access to shared Git metadata or the host Docker socket.

Read the current manifest before changing it. Keep schemaVersion app.0.1; increment the app's
version when shipping changes. Use the configured user Git identity. Plans are optional and
follow the operator's editable instructions.

A workspace can include several repositories. Use one registered worktree per repository and retain
both the aggregate workspace ID and each worktree ID. Use the worktree ID for source and Git tools.

For one Git repository use `source`. For several, declare a `sources` object keyed by name and
refer to an entry from a service with `sourceRef`. Use `primarySource` to identify the named entry
that owns the app-level manifest or runtime source when required. Choose one of `source` and
`sources` when declaring Git sources. Named sources require Core 0.188.0 or later.
Preparation returns the worktrees together. Check `preparation.complete` and use the returned
paths. Supply reviewed Git connection IDs by source name in `sourceConnections` when needed.
For an incomplete preparation inspect its failures and retry with the original request UUID and
arguments after restoring access or availability.

To connect an existing remote, get explicit authorization, choose a connection and target branch,
then use remote_connect. remote_fetch observes upstream without changing local branches. Inspect
its relationship before integrating: merge_upstream operates in a clean worktree and needs explicit
consent for unrelated histories. Resolve conflicts there or abort-merge; never overwrite the remote.
A missing target branch can be initialized from accepted main using authorized remote_push_base.
Configure publication before pr_commit/pr_push/pr_publish; inspect CI and review through pr_status.
A failed or uncertain request keeps the original requestId and expected heads. Retrying never grants
permission for another commit, push, review resolution or merge.

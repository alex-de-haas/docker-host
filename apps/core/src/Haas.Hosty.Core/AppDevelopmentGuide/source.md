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
both the aggregate workspace ID and each worktree ID. Never pass the aggregate ID to source/Git tools.

To connect an existing remote, get explicit authorization, choose a connection and target branch,
then use remote_connect. remote_fetch observes upstream without changing local branches. Inspect
its relationship before integrating: merge_upstream operates in a clean worktree and needs explicit
consent for unrelated histories. Resolve conflicts there or abort-merge; never overwrite the remote.
A missing target branch can be initialized from accepted main using authorized remote_push_base.
Configure publication before pr_commit/pr_push/pr_publish; inspect CI and review through pr_status.
A failed or uncertain request keeps the original requestId and expected heads. Retrying never grants
permission for another commit, push, review resolution or merge.

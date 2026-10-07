# Hosty Plans

Read the current plans across installed apps' source repositories. The app is available only to
Hosty administrators and requires the configured assistant-to-Plans MCP relationship.

Use `list_plans` to find plans by title, summary, status, repository or app. Use `get_plan` with the
returned repository ID and document path for its tracked-branch version and every workspace
changing it. Use `plan_workspaces` for a concise list of those workspace versions and session links.

Markdown in Git is authoritative. These tools read derived views; they never edit documents or run
Git operations. Workspace changes are measured against the workspace's merge base. A workspace
exists independently of an agent's current activity. Describe its state and observation time;
never infer that an agent is currently working. A deleted plan is completing only when the same
workspace changes its feature.md; otherwise it is removed. This is a workflow label, not a new status.

Tools return parse errors and repository failures explicitly. Do not interpret unknown progress or
an unavailable repository as no work. Links open the app's detail view and may select a workspace.

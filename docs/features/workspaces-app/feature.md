---
created: 2026-10-09
updated: 2026-10-20
summary: Retirement of the standalone Workspaces app; Core workspace inspection and Harness agent sandbox workflows remain available.
components: [apps/core, apps/harness, apps/shell]
---

# Workspaces App Retirement

The standalone `hosty.workspaces` runtime app is retired. Its source, manifest, feed, image publication
and dedicated CI job are removed from this repository. Retirement does not uninstall existing
installations, stop their processes or delete application data, Core workspace records or worktrees.
Existing installations receive no new image or feed updates from this repository.

[Harness Development](../harness-development-ui/feature.md) displays its conversations' repository
workspaces and external workspaces, source diffs, app bindings, PR/CI/review observations and known
source consumers. It shows existing child Core and app sandbox previews and their supported
lifecycle controls. The separate Workspaces inventory, released-history filters and detailed Git
metadata/commit/activity inspector are removed; the underlying authorized Core inspection API
retains those records and diagnostics.

The standalone operator form for creating a child Core from selected worktrees and entering a test
account is removed. Harness's built-in `hosty-workspaces` development MCP server remains independent
of the retired app. Its `environment_create`, `environment_start`, `environment_setup`,
`environment_restart` and `environment_finish` tools retain the child Core workflow, including
normal test-account bootstrap/password login, separate data and explicit cleanup. The Shell child
Core panel retains inventory, test-account connection, preview, Start/Stop and Finish controls for
existing environments. No replacement operator creation form is added.

Workspace viewer requests resolve the current owning assistant's session when available. Harness
sessions open its existing Development page. External records have no invented conversation link;
use Harness's External workspaces view or the Core workspace API. Shell no longer links sandbox
records to the removed application.

## Testing Expectations

- Keep Core workspace inventory, source authority, inspection, diff and lifecycle coverage.
- Verify owning-session viewer destinations without the retired app, escaped session IDs,
  replaced/missing assistant installations and explicit external-owner unavailability.
- Keep Harness child Core creation, setup-secret separation, session ownership and lifecycle tests.
- Validate package/lockfile, version, CI and publication wiring and living documentation references.
- Retirement never runs uninstall, stops an existing instance or removes installed application data.

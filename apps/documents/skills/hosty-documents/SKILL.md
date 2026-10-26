---
name: hosty-documents
description: Create, review and implement plans and documents in Hosty Documents.
---

# Hosty Documents

Documents reads current repository documentation and progress from Core's tracked target branches
and registered workspaces. It is available to Hosty administrators under source permissions. Git
Markdown is authoritative; the app has no document database, association store or history archive.

Edit documents directly in the registered workspace returned by Core. Follow that repository's
AGENTS.md, update verified deliverables promptly, and regenerate its documentation index. Reserve
idea IDs in docs/ideas.md with the monotonic idea-id-high-water comment; keep removed IDs retired.
Never reuse an ID or treat a checked workspace item as already integrated into the target branch.

The optional assistant-to-Documents MCP relationship exposes the existing read-only plan tools.
Use list_plans to search by title, summary, status, repository or app. Use get_plan with the returned
repository ID and document path for the tracked target and workspace versions; plan_workspaces
returns concise workspace and session links. These tools never edit documents or execute Git.
The UI also reads root, vision, ideas, feature documents, reviews and labelled tooling documents.

A workspace exists independently of agent activity. Report its observation time and source version.
A local checkbox is local progress, not proof that a PR contains the change, CI passed, or a release
is installed. Recorded PRs are observations owned by Core. Deleted workspaces leave no app archive.
A deleted plan accompanied by feature.md changes is labelled completing; this is not a plan status.

Errors and unavailable sources mean unknown progress. Discussion, question, repair and implementation
actions prepare exact-version drafts for user submission through the selected assistant. They do
not authorize publication. Direct file editing needs no Documents MCP dependency.

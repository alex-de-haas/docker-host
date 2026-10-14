---
status: In Progress
created: 2026-10-14
updated: 2026-10-14
summary: Observe externally linked pull requests through Core provider connections and show current status, checks and reviews in Workspaces.
components: [apps/core, apps/workspaces]
---

# External Workspace Pull Request Tracking

The owner approved implementation and inclusion in PR #590 on 2026-10-14.

## Target Behavior

Extend the existing external workspace reference flow with read-only PR observation. Reuse Core's
publication provider and observer, including repository/branch correlation and credential refresh.
Use the workspace's reviewed source connection, or the owner's sole connected matching provider
account for a public source. Missing or ambiguous connections remain explicit; do not borrow another
user's credentials or infer publication/merge authority from an external workspace grant.

Track every recorded PR independently, refresh in the background, and discard private review bodies
from the projection. Revalidate source access and connection ownership before exposing cached facts.
A changed remote head updates status/checks together and remains distinguishable from the local head.
Workspaces shows observed state, CI, review summaries, age and actionable unavailable reasons.

## Deliverables

- [x] D1. Add persistent read-only external PR observations through the existing Core provider/observer, with current owner/source/connection checks and independent reference refresh.
- [x] D2. Show tracked PR status, CI and reviews in Workspaces and distinguish missing observations from stale observations; cover missing/revoked credentials, mismatches and refresh in regression tests.
- [ ] D3. Build Core and Workspaces, run affected tests and Native AOT validation, verify real PR #590 through Core-managed Workspaces with normal browser authentication, and update feature documentation and the same PR.

## Verification

Exercise multiple references, connection loss, provider errors, mismatched repository/head branch,
changed remote head, restart persistence and absence of publication mutations. Retain concise results
in Markdown; raw browser/log/JSON outputs stay outside the repository. Runtime changes use the
repository's Core development feedback loop and an isolated browser QA data root.

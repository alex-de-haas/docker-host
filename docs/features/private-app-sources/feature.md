---
created: 2026-09-28
updated: 2026-10-07
summary: Core reads private repository manifests and sources through explicitly selected personal provider connections.
components: [apps/core, apps/harness]
---

# Private App Sources

Core reads private repository manifests and Git sources through explicitly selected
[personal provider connections](../user-profile-connections/feature.md), configured in Shell
settings → Source connections. Shell reads sanitized summaries and offers explicit account selection. Public/local installation remains
available without personal connections; selecting a connection does not make it a host default.

## Supported Resources

| Resource | Input | Authenticated destination |
| --- | --- | --- |
| GitHub manifest | `https://raw.githubusercontent.com/OWNER/REPO/REF/path/manifest.json` or `https://github.com/OWNER/REPO/blob/REF/path/manifest.json` | GitHub repository contents API with raw media type |
| Git sources | GitHub.com or `dev.azure.com` HTTPS repository URL | That exact repository, through Git |

GitHub URL refs occupy one path segment. GitHub Enterprise, Azure DevOps, SSH URLs, authenticated
release assets and arbitrary HTTP credential destinations are unsupported for private source reads.
Saved Azure bindings remain intact but fail with an actionable unsupported-provider error.
Public Git transport does not require a source-provider adapter.

The repository permission requirements remain those of
[GitHub repository contents](https://docs.github.com/en/rest/repos/contents).

## Review And Persistence

The reviewed installation request accepts `sourceConnections.manifestConnectionId` and
`sourceConnections.gitConnectionId`. Updates keep omitted connections; explicit
`clearManifestConnection` / `clearGitConnection` flags remove the corresponding grant after review.
A request cannot both clear and select the same connection. The confirmation displays which resources
use no personal connection. This also permits recovery after a formerly private source becomes public,
without requiring the old connection to remain valid. Core derives the owner from the authenticated user and validates
each resource against the selected provider; clients cannot supply trusted owner/grant records.
App callers need `apps.install` plus either `apps.sources.full` or `sources.connections`, including updates that keep existing private
bindings and requests that remove them. Core derives the connection owner from the current actor,
checks cached-plan bindings too, and rechecks the permissions on submission, status reads and execution.
Runtime assignments confer no repository credential access. Shell's manifest-install dialog selects
manifest/Git accounts independently and retains them when changing runtime during review. Public
installation omits private choices and remains available without the optional connection permission.
The installed app's Source tab offers keep/replace/public choices and reviews an update before submission.
Harness has no duplicate installation form.

The separate Core confirmation page displays the resource, connection label and external account,
and explains continued access for the app, background updates and source workspaces requested by
the owner. The single-use install plan freezes manifest bytes and grant references. App records and
reviewed update snapshots contain owner/connection IDs and resource descriptions, never tokens.
An update's digest and base state include connection changes; a stale approval cannot silently
replace a newer binding. A changed manifest URL or Git repository needs an explicit new selection.

Background reads survive browser logout and Core restart. Each authenticated operation checks that
the connection still exists and its owner is enabled. Expiring OAuth tokens refresh under the same
per-user lock as connection management; rotated credentials persist before use. Disconnecting blocks
new reads after in-flight connection operations finish. Disabling/deleting an owner also blocks new
reads. Already fetched files and already running apps remain available; revocation does not erase
local copies or stop a runtime.

## Recovery And Source Workspaces

The source owner reconnects in Shell settings → Source connections. Shell and the direct operator API
accept replacement bindings through a reviewed app update. Public / no connection removes a saved
binding. The source-access response never substitutes a host path for a URL.
A new connection ID never inherits old grants automatically. Ownership cannot
be transferred through this flow. Provider-side revocation is discovered on a provider read/check;
a locally available connection is not proof of remote repository permission.

Private Git reads cover managed checkout creation/fetch, source revision probes and session workspace
fetch/refresh/integration/cleanup. A session can create a private worktree only for its source owner.
Existing workspace ownership checks still apply. Workspaces use the current matching app grant after
an explicit rebind or grant removal and retain their original grant reference if the app is removed. Removal of that
connection blocks remote operations, while local files remain recoverable.

Source updates prefetch missing reviewed Git objects before stopping the old runtime. A denied read
therefore preserves the running app and installed version. An installation whose initial start fails
retains the app record and reviewed bindings for recovery; it does not require a second installation.
Local control remains trusted operator authority. Personal connection selection and replacement
are exposed in Shell; Core keeps the confirmation page. No CLI token argument is required or added.

## Credential Handling

Manifest requests use fixed provider APIs, HTTPS, no redirects/cookies and bounded response size/time.
Display assets use the same repository/ref under the manifest folder, with existing per-asset limits;
missing assets remain best effort. Provider failures return sanitized messages without response bodies.

Authenticated Git uses a transient process environment: a repository-scoped authorization header,
disabled global/system credential configuration, disabled helpers, redirects, hooks and submodule
recursion, HTTPS-only transport and bounded output/time. Fetch uses the granted URL explicitly rather
than trusting a checkout's remotes. Repository-local transport overrides, includes, filters and
worktree-specific configuration are rejected before exposing credentials to Git; Core preserves
those settings for the operator to inspect. Tokens are absent from command arguments and Git configuration
files. This is not OS isolation from a same-user local process; source containment remains the existing
cooperative agent boundary.

## Testing Expectations

- Provider fixtures cover GitHub account routing, multiple owners, legacy Azure rejection, unsupported
  URLs, redirects, remote errors, bounded content, asset containment and sanitized errors.
- HTTP/lifecycle tests cover owner-only selections, Core review text, exact cached manifest binding,
  logout, disconnect/disable/delete, denied workspaces, failed updates preserving the running app,
  and revoked cached installation/update plans.
- Real Git process tests verify URL-scoped transient configuration and absence of persisted tokens.
- Shell source-selection tests cover explicit preparation, independent account choices, retained selections
  on runtime review and public installation without connection-management permission. Harness tests
  reject account mutations and installations while preserving authorized read-only selection.
- Core-managed browser verification covers the installation and source settings surfaces.
- Core/CLI tests, Shell build/tests/lint, Native AOT and documentation/version checks guard integration.
  Live provider clone/refresh tests require disposable external credentials; fixtures do not claim
  to replace that provider integration check.

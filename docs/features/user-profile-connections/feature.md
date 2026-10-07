---
created: 2026-09-28
updated: 2026-10-07
summary: Shell manages personal GitHub accounts and Git identity through Core-owned connections and narrow app permissions.
components: [apps/core, apps/shell, apps/harness]
---

# User Profile And Provider Connections

Core exposes the current user's ID, email and display name through `/api/profile`; Shell renders
name editing at `/settings?tab=profile`. This self-service API has no user-management permission
requirement and does not expose source-provider connections or Git attribution.

Shell settings → **Security → Source connections** manages the current administrator's GitHub accounts through
`/api/source-connections`. Its optional `sources.connections` permission requires explicit Core review.
An ungranted Shell displays a link to its Core permission review. Public installation remains available.
Core owns credential storage, ownership checks and provider operations; Harness consumes selected
connections for source work and PRs, with no account-management or installation form.
The [source-provider registry](../source-providers/feature.md) supplies GitHub as its only active adapter.

A connection has an opaque ID, an owner, a label, a provider-verified identity and the last observed
status. Connecting an external account does not change Hosty login, roles or application assignments.
Saved Azure DevOps connections retain their IDs and credentials but appear as `unsupported`; they
cannot be used or checked and may be explicitly disconnected. Migration does not delete accounts.

## Git Attribution

Source-provider settings store an optional Git author name/email separately from display name and provider login.
Saving both empty selects provider-verified attribution. Publication commits use this explicit identity
or a verified primary GitHub email; Core does not invent an email from the account login. GitHub device
sign-in requests `user:email` in addition to repository access. Existing connections without that
scope can reconnect or use explicit Git attribution. Git identity edits require `sources.connections` for app callers, the current administrator, and owner checks. Direct Core browser mutations require CSRF. Ordinary profile edits cannot change Git identity.

## Account Operations

Connections support add, rename, check and disconnect. GitHub offers device authorization and an
explicit personal access token fallback. Multiple accounts coexist; no connection becomes a global
default and repository host names never select an account implicitly.

GitHub sign-in works with Hosty's built-in public OAuth client registration, without per-host setup.
The modal initially shows provider selection, explicit private-repository access consent and
**Connect GitHub**. **Additional options** contains the PAT method and an optional connection name.
Provider and connection-method choices use shadcn Select menus with keyboard navigation inside the modal.
An omitted or blank name is derived from the provider-verified account name, bounded to 100 characters;
an explicit name is preserved. Rename still requires a nonempty name. The form consumes the provider's
authentication-method descriptor and offers PAT when device authorization is unavailable.

**Add connection** opens a modal containing the provider form, device authorization instructions
and any connection errors. Successful connection closes the modal and refreshes the account list.
An icon beside the device code copies it to the clipboard and briefly shows a checkmark with an
accessible confirmation. Clipboard failures leave the code selectable and explain how to copy it manually.
Cancel, Escape, the close button and backdrop dismissal cancel a pending device attempt and clear
unsaved credentials. Dismissal is disabled while a request is being submitted. Reopening starts a
fresh form, and closing returns keyboard focus to Add connection.

Core validates external identity before storing credentials. **Check connection** verifies identity
again and renews expiring OAuth credentials first. It persists token rotation before making further
provider calls. Observed states are `connected`, `unavailable`, `reconnect-required` and `unsupported`; these are
checks at a point in time, not continuous provider monitoring or proof of permission to a repository.
A PAT's provider permissions, expiry and organization policies still apply. A revoked or expired
credential needs an explicit new connection. Rename changes only the user's label.

Disconnect deletes Core's stored credential. Provider-side authorization is separate: the confirmation
explains how to revoke it in the provider's account settings. Disconnect requires an existing connection owned by the caller; missing or foreign IDs return 404
without a success audit event. Local credential operations are serialized per user; unrelated users
continue independently during provider requests; an already running request finishes before removal takes effect. Deleting/purging a Hosty
user removes their connections; disabling the user prevents credential operations and completion of
in-flight authorization. Atomic persistence revalidates the owner, so a late provider response cannot
restore credentials for a deleted or disabled user.

## Provider Registration

Core includes Hosty's registered GitHub OAuth App client ID. Operators can override that registration
through standard .NET configuration, including environment variables on the Core process:

| Setting | Environment variable | Registration |
| --- | --- | --- |
| `ProviderConnections:GitHubClientId` | `ProviderConnections__GitHubClientId` | Optional custom GitHub OAuth App client ID with device flow enabled; absent or blank uses Hosty's registration |

Restart Core after changing a registration override. Client IDs are public identifiers; this
flow needs no embedded client secret, cloud intermediary or publicly reachable Hosty callback.
Each Core exchanges tokens directly with the provider and stores them locally for the authorizing
user. Existing OAuth connections retain the client ID used to create them for token renewal, even
when the current registration changes. Retired Entra configuration has no active provider adapter.

For a custom GitHub registration, register an OAuth App and enable device authorization. Public repository scope is
`public_repo`; the optional private-repository checkbox requests `repo` instead. Both request
`offline_access` for token renewal where supported. See
[GitHub device authorization and refresh](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Only fixed GitHub API and authorization authorities receive credentials. HTTP redirects are disabled.
GitHub Enterprise Server and Azure DevOps are outside the active provider set.

## Authorization And Storage

`GET /api/profile` returns only the current enabled user's ID, email and display name.
`PUT /api/profile` changes only `displayName`, never email, role, assignments or Git identity.
App callers authenticate with their service credential and app user grant, with no separate app
permission for this self-service API. Direct Core browser mutations retain CSRF protection.

Source-provider endpoints require the current administrator; app callers additionally require
a live grant issued to that same app. Reads accept `apps.sources` or `sources.connections`; all
account/Git-identity mutations require `sources.connections`:

- `GET /api/source-connections` returns sanitized connection summaries, provider descriptors (ID, display name, authentication methods and capabilities) and Git identity.
- `PUT /api/source-connections/identity` sets or clears `gitIdentity` without changing the display name.
- `POST /api/source-connections/pat` verifies and adds a PAT connection.
- `POST /api/source-connections/device` starts authorization.
- `POST /api/source-connections/device/{id}/poll` advances authorization.
- `DELETE /api/source-connections/device/{id}` cancels a local attempt.
- `PUT /api/source-connections/{id}` changes `label`.
- `POST /api/source-connections/{id}/check` verifies or renews a connection.
- `DELETE /api/source-connections/{id}` disconnects it.

Legacy `/api/profile/connections` routes are removed. The owner comes from the authenticated user,
never a request-supplied ID; administrators cannot inspect or edit another administrator's connections.
Scoped MCP tokens cannot use these endpoints. Every app request revalidates identity, assignment,
role and the granted permission. Responses are marked `no-store`.
Shell forwards these operations through its app-session BFF. Harness forwards only read-only connection
and source-binding selection, using its own service credential and app grant; removed management and
installation routes return 404. Core cookies and caller-selected destinations are never forwarded.

Credentials reside in `<data-root>/core/auth/state.json`, with Core's owner-only file permissions and
atomic serialized writes. This is protected local storage, not application-level encryption. It is
outside application data and application backups; host filesystem administrators can read it.
Access tokens, refresh tokens and provider device codes are absent from API response DTOs and audit
metadata. Audit events contain the actor and connection/profile identifier. Auth state uses the Native
AOT JSON serialization context, including backward-compatible absent connection collections.

Device attempts are in memory, limited to three per user and 256 per Core process, including starts
waiting for a provider response. Completed connections
are limited to 32 per user. Attempts expire at the provider deadline or 30 minutes, whichever is sooner;
Core enforces provider polling intervals and `slow_down`. User-visible codes and fixed verification
links are returned by the API; opaque device codes stay on Core. Core resolves an app grant's authorizing
browser session internally when starting device authorization; the primary credential never leaves
Core. Diagnostic app tokens without a parent browser session cannot start this flow. Completion requires the original browser session
to remain live and the user enabled. Cancel, logout, expiry and Core restart require a new attempt.
Closing the page stops polling; an abandoned attempt expires. Already completed connections survive
browser logout and Core restart.

A connection record grants no app installation, source access, Git publication or merge authority.
[Private app sources](../private-app-sources/feature.md) adds separately reviewed repository bindings and
background read grants; [PR lifecycle](../assistant-pr-lifecycle/feature.md) owns remote collaboration.
Core's service resolves connection IDs together with an enabled owner; there is no public token-export
endpoint or automatic exposure to assistants/apps.

## Testing Expectations

- Protocol fixtures verify GitHub device requests, PAT identity, pending/slow-down, cancellation,
  expiry, denial, refresh rotation, unavailable/malformed responses and credential non-disclosure.
- Registration tests cover Hosty's default GitHub client, operator overrides, ignored retired Entra configuration,
  connection-specific client IDs during renewal and automatic versus explicit account names.
- Persistent-store tests cover several accounts, owner separation, reload, owner-only file permissions,
  deletion/disable races and retention purge without deleting another user's accounts.
- HTTP tests exercise the production Core router with browser sessions, CSRF, ordinary-user access,
  scoped-token rejection, sanitized responses and disabled-user rejection.
- Shell tests cover profile writes, the connection modal, additional options, unnamed GitHub sign-in,
  PAT clearing, copying, polling/cancellation, dismissal/focus, rename/disconnect and unsupported accounts.
  Harness tests cover its read-only consumer proxy and rejected management/installation routes.
  Core tests cover the management/use permission split, owner isolation and secret non-disclosure.
- Provider HTTP fixtures cover polling/cancellation, rename failure and confirmed disconnect.
- Build Core (including Native AOT), Shell and Harness; run affected tests and type checks, version
  consistency and the documentation-index check. Validate the UI in a Core-managed runtime.
- Live OAuth consent/renewal requires operator-owned client IDs and a consenting external account;
  deterministic fixtures do not establish that a particular registration or tenant policy works.

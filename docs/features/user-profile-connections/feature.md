# User Profile And Provider Connections

Created: 2026-09-28
Updated: 2026-10-01

Core exposes the current user's ID, email and display name through `/api/profile`; Shell renders
name editing at `/settings?tab=profile`. This self-service API has no user-management permission
requirement and does not expose source-provider connections or Git attribution.

Harness settings → **Source providers** manages the current administrator's GitHub.com and Azure
DevOps Services accounts through `/api/source-connections`, protected by `apps.sources`. Shell has
no source permission and links to authorized source tools instead of reading connection summaries.
Core serves no profile or provider-settings page. Core retains credential storage, provider protocol
handling and Git/private-source/PR operations; Harness owns the settings UI and its app-local transport.
The built-in source providers are separate from Harness agent providers and are not a general-purpose
integration registry.

A connection has an opaque ID, an owner, a label, a provider-verified identity, an organization for
Azure DevOps, and the last observed status. Connecting an external account does not change Hosty
login, roles or application assignments.

## Git Attribution

Source-provider settings store an optional Git author name/email separately from display name and provider login.
Saving both empty selects provider-verified attribution. Publication commits use this explicit identity
or a verified primary GitHub email; Core does not invent an email from the account login. GitHub device
sign-in requests `user:email` in addition to repository access. Existing connections without that
scope can reconnect or use explicit Git attribution. Git identity edits require `apps.sources` for app callers, the current administrator, and owner checks. Direct Core browser mutations require CSRF. Ordinary profile edits cannot change Git identity.

## Account Operations

Connections support add, rename, check and disconnect. GitHub and Azure DevOps offer provider
sign-in through device authorization, with an explicit personal access token fallback. Multiple
accounts of either provider coexist; no connection becomes a global default and no account is
selected implicitly by a repository host name. Azure DevOps connections name an organization and,
for Entra sign-in, an optional tenant UUID; the default tenant is `organizations`.

Core validates external identity before storing credentials. **Check connection** verifies identity
again and renews expiring OAuth credentials first. It persists token rotation before making further
provider calls. Observed states are `connected`, `unavailable` and `reconnect-required`; these are
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

Core reads these operator settings through standard .NET configuration, including environment variables
on the Core process:

| Setting | Environment variable | Registration |
| --- | --- | --- |
| `ProviderConnections:GitHubClientId` | `ProviderConnections__GitHubClientId` | GitHub OAuth App client ID with device flow enabled |
| `ProviderConnections:EntraClientId` | `ProviderConnections__EntraClientId` | Microsoft Entra public-client application ID |

Restart Core after changing its registration configuration. Client IDs are public identifiers; this
flow needs no embedded client secret or publicly reachable Hosty callback. Without an ID, Core explains
that provider sign-in is unavailable and offers the PAT method.

For GitHub, register an OAuth App and enable device authorization. Public repository scope is
`public_repo`; the optional private-repository checkbox requests `repo` instead. Both request
`offline_access` for token renewal where supported. See
[GitHub device authorization and refresh](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

For Entra, register a public client, enable public-client/device authentication, and configure the Azure
DevOps delegated `user_impersonation` permission. The requested resource is
`499b84ac-1321-427f-aa17-267ca6975798` with `offline_access`. The registration's supported account types
must match the chosen tenant: a single-tenant app needs its tenant UUID; a multi-tenant organization
registration can use `organizations`. Organization/tenant consent and conditional-access policies can
require administrator approval or disallow the flow. See
[Microsoft's Azure DevOps Entra integration guide](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops).

Only fixed GitHub.com, Microsoft login and `dev.azure.com` authorities receive credentials. HTTP redirects
are disabled. Organization names and tenant IDs are validated, not treated as arbitrary URLs. GitHub
Enterprise Server and Azure DevOps Server are outside this provider set.

## Authorization And Storage

`GET /api/profile` returns only the current enabled user's ID, email and display name.
`PUT /api/profile` changes only `displayName`, never email, role, assignments or Git identity.
App callers authenticate with their service credential and app user grant, with no separate app
permission for this self-service API. Direct Core browser mutations retain CSRF protection.

Source-provider endpoints require the current administrator; app callers additionally require
`apps.sources` and a live grant issued to that same app:

- `GET /api/source-connections` returns sanitized connection summaries, provider availability and Git identity.
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
Harness forwards only these fixed routes, using its service credential and its user's app grant.
Its server checks administrator identity and same-origin writes before forwarding; neither Core
cookies nor caller-selected destinations are accepted.

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

- Protocol fixtures verify GitHub/Entra device requests, PAT identity, pending/slow-down, cancellation,
  expiry, denial, refresh rotation, unavailable/malformed responses and credential non-disclosure.
- Persistent-store tests cover several accounts, owner separation, reload, owner-only file permissions,
  deletion/disable races and retention purge without deleting another user's accounts.
- HTTP tests exercise the production Core router with browser sessions, CSRF, ordinary-user access,
  scoped-token rejection, sanitized responses and disabled-user rejection.
- Shell tests cover identity-only profile writes and source-tool links without connection reads.
  Harness tests cover provider settings, PAT clearing, polling/cancellation, rename/disconnect and
  the restricted server transport. Core HTTP tests cover app permission checks,
  owner isolation, secret non-disclosure and revoked app grants.
- Provider HTTP fixtures cover polling/cancellation, rename failure and confirmed disconnect.
- Build Core (including Native AOT), Shell and Harness; run affected tests and type checks, version
  consistency and the documentation-index check. Validate the UI in a Core-managed runtime.
- Live OAuth consent/renewal requires operator-owned client IDs and a consenting external account;
  deterministic fixtures do not establish that a particular registration or tenant policy works.

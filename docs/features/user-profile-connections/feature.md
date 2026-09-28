# User Profile And Provider Connections

Created: 2026-09-28
Updated: 2026-09-28

Every enabled Hosty user has a personal profile at Shell `/settings?tab=profile`, also reachable
from **Your profile** in the account menu. Users edit their display name and manage multiple
GitHub.com and Azure DevOps Services accounts. A connection has an opaque ID, an owner, a label,
a provider-verified identity, an organization for Azure DevOps, and the last observed status.
Connecting an external account does not change Hosty login, roles or application assignments.

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
explains how to revoke it in the provider's account settings. Disconnect and local credential operations
are serialized; an already running request finishes before removal takes effect. Deleting/purging a Hosty
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
flow needs no embedded client secret or publicly reachable Hosty callback. Without an ID, Shell explains
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

`GET /api/profile` returns only the current enabled user's profile and sanitized connection summaries.
Mutations require a Core browser session and CSRF protection:

- `PUT /api/profile` updates `displayName` without changing email or role.
- `POST /api/profile/connections/pat` verifies and adds a PAT connection.
- `POST /api/profile/connections/device` starts authorization.
- `POST /api/profile/connections/device/{id}/poll` advances authorization.
- `DELETE /api/profile/connections/device/{id}` cancels a local attempt.
- `PUT /api/profile/connections/{id}` changes `label`.
- `POST /api/profile/connections/{id}/check` verifies or renews a connection.
- `DELETE /api/profile/connections/{id}` disconnects it.

The owner comes from the authenticated session, never a request-supplied user ID. Ordinary users can
manage only their own connections; being an administrator does not expose another user's credentials.
Scoped app/MCP tokens cannot use these endpoints. Responses are marked `no-store`.

Credentials reside in `<data-root>/core/auth/state.json`, with Core's owner-only file permissions and
atomic serialized writes. This is protected local storage, not application-level encryption. It is
outside application data and application backups; host filesystem administrators can read it.
Access tokens, refresh tokens and provider device codes are absent from API response DTOs and audit
metadata. Audit events contain the actor and connection/profile identifier. Auth state uses the Native
AOT JSON serialization context, including backward-compatible absent connection collections.

Device attempts are in memory, limited to three per user and 256 per Core process. Completed connections
are limited to 32 per user. Attempts expire at the provider deadline or 30 minutes, whichever is sooner;
Core enforces provider polling intervals and `slow_down`. User-visible codes and fixed verification
links go to Shell; opaque device codes stay on Core. Completion requires the original browser session
to remain live and the user enabled. Cancel, logout, expiry and Core restart require a new attempt.
Closing the page stops polling; an abandoned attempt expires. Already completed connections survive
browser logout and Core restart.

A connection record grants no app installation, source access, Git publication or merge authority.
The separately tracked [private-source plan](../private-app-sources/plan.md) owns repository bindings and
background read grants; [PR lifecycle](../assistant-pr-lifecycle/plan.md) owns remote collaboration.
Core's service resolves connection IDs together with an enabled owner; there is no public token-export
endpoint or automatic exposure to assistants/apps.

## Testing Expectations

- Protocol fixtures verify GitHub/Entra device requests, PAT identity, pending/slow-down, cancellation,
  expiry, denial, refresh rotation, unavailable/malformed responses and credential non-disclosure.
- Persistent-store tests cover several accounts, owner separation, reload, owner-only file permissions,
  deletion/disable races and retention purge without deleting another user's accounts.
- HTTP tests exercise the production Core router with browser sessions, CSRF, ordinary-user access,
  scoped-token rejection, sanitized responses and disabled-user rejection.
- Shell tests cover profile routing, name editing, multiple accounts, unconfigured providers, PAT
  clearing on failure, timed polling/cancellation, rename failure and confirmed disconnect.
- Build Core (including Native AOT) and Shell; run Core and Shell tests, Shell lint, version consistency
  and the generated documentation-index check. Validate the page against a Core-managed Shell runtime.
- Live OAuth consent/renewal requires operator-owned client IDs and a consenting external account;
  deterministic fixtures do not establish that a particular registration or tenant policy works.

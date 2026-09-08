# OAuth Core Control Scopes

Status: In Progress
Created: 2026-09-08
Updated: 2026-09-08

## Goal

Let an operator explicitly authorize a stock MCP client to manage and update applications through
Core OAuth, without issuing a full-role credential. Client removal belongs
to [OAuth management](../mcp-oauth/feature.md) and is not a prerequisite for issuing new scoped grants.

## Target Behavior — Changes From Current Behavior

[OAuth](../mcp-oauth/feature.md) currently advertises and accepts only `mcp:read`. Extend its
resource-aware validation and consent to accept `mcp:lifecycle` and `mcp:update` for `hosty:core`.
Both require `mcp:read`, remain independent, and require the consenting user to be an administrator.
App/facade audiences remain read-only; the facade filter and delegated-token restrictions stay intact.

Consent describes reading, start/stop/restart, and plan/apply updates in words. A requested scope
is not an approved scope until consent succeeds. No full-role OAuth token is issued. Refresh must
not expand the consented scope set, and an increase uses client login and fresh consent, not a
silent edit to an existing bearer. Existing grants are not edited for reductions either (owner
scope decision, 2026-09-08). Do not depend on automatic client step-up or old/new-grant linking.

Preserve the current issuance model: each successful new authorization creates a new grant,
access token and refresh chain, shown as a separate Active credentials row. The previous grant
remains independent until explicitly revoked or expired. Ordinary refresh rotates tokens within
its existing grant and does not create another row. A new OAuth client registration is separate
and depends on client registration behavior, not on the scope change itself.

Use selectable consent as the primary design: show requested Core control scopes as optional
choices, unchecked initially; retain required `mcp:read`. An administrator may approve a subset,
never add an unrequested scope. Validate the selected subset against the parked request server-side,
store only approved scopes in the code/grant and return the actual issued access-token scopes
in token responses. Refresh scope selection follows the rules below. This is initial consent, not reduction of an existing credential. A forged consent payload
cannot add a scope. See [RFC 6749 section 3.3](https://www.rfc-editor.org/rfc/rfc6749.html#section-3.3).

Publish all three supported scopes in AS metadata while keeping Core Protected Resource Metadata
at the minimal `mcp:read`. Test these distinct documents explicitly with both stock clients rather
than assuming all clients choose their default from PRM. No global issuance switch is required by
the primary design; it remains an optional policy choice only if separately requested.

A missing scope parameter defaults to read-only. Do not promise that every client's default login
requests read-only: discovery behavior differs between clients and between default/config/CLI paths.

## Evidence And Client Compatibility

See the [2026-09-08 stock-client report](../../reviews/2026-09-08-oauth-client-compatibility.md)
for observed versions, scope selection, consent subsets, refresh and isolation limitations.
The fixture results establish client compatibility, not production-state isolation or implemented
Core/Shell behavior.

## Refresh Scope Validation

The current refresh handler ignores the optional `scope` form parameter; the probe confirms Codex
actually sends it. Resolve the grant from the presented refresh token, then validate requested
scopes before consuming/rotating it or issuing a session. Omitted scope uses the grant's set. A
present scope must be a non-empty, well-formed subset of `grant.Scopes` satisfying existing Core
scope dependencies; unknown, malformed or wider scopes return `invalid_scope` without rotating
the refresh token. Include the actual access-token scope in the response.

A valid narrower refresh request narrows that newly issued access token only. It does not edit the
persistent grant or the replacement refresh token's authority, and is not the removed credential
permission editor. Later refresh without scope can use the originally approved grant set again.
Client behavior may continue requesting the narrower access-token scope; that is within the grant.

## Relationship To MCP Tool Availability

Scopes are server-enforced authority on a credential (`mcp:read`, `mcp:lifecycle`, `mcp:update`).
Current gateway provider toggles control which providers reach the assistant panel. The Draft
[assistant approval rules](../assistant-approval-rules/plan.md) proposes per-tool Ask/Run unprompted
modes, not per-tool denial. That planned approval policy cannot give a bearer missing scopes.

[AI Agent Bridge](../ai-agent-bridge/plan.md) mentions per-tool agent scopes as an extension idea,
not a specified per-tool availability implementation. Such a future server-side allowlist would
further restrict operations within the granted scope categories; it must apply at invocation,
not only hide entries from `tools/list`. This feature does not implement that allowlist.

Direct Core `/api/mcp` calls do not traverse gateway provider toggles or its assistant approval rules.
The assistant provider toggle is panel-specific; facade export applies its own policy and read-only
filter, and delegated tokens remain unable to mutate Core. This plan does not add per-tool token
ACLs or promise that scopes hide tools from `tools/list`: Core currently advertises mutation tools
and rejects unauthorized calls. Client-side tool selection, if configured, is another local filter,
not a server-side restriction on where a stolen or independently used bearer can be presented.

## Decisions And Completed Compatibility Probe

Owner approved the selectable-consent UI in chat on 2026-09-08. A global breaker is not part of the
base implementation. Existing token/grant scopes remain immutable.

The [stock-client probe](../../reviews/2026-09-08-oauth-client-compatibility.md) on 2026-09-08
passed with Codex 0.147.0 and Claude Code 2.1.263. Both accepted read-only issuance after an all-scope
request, used the resulting token, rejected a synthetic control call while reads remained usable,
and refreshed without scope expansion. Both also accepted full requested scopes and denied consent.
Codex default login requested the AS catalog; Claude default requested PRM read. Codex CLI `-c`
scope configuration was honored in the tested login path. Explicit Codex `--scopes` and Claude `oauth.scopes` both worked.

HTTP insufficient-scope handling differs: Codex app-server returned an error; Claude print mode
reconnected/retried once and surfaced an authorization error. Neither path completed automatic
step-up. Use explicit re-login instructions; no dependency on automatic step-up or endless retries.

The original probe inherited real Codex integrations, including production Core. Its client results
remain useful, but absence of production OAuth/session-state changes is not established. Future
live tests must satisfy the isolation requirement below before connecting.

## Open Questions

None for the selected design. The client probe and UI approval resolve the earlier questions.
Owner approved implementation on 2026-09-08; actual Core/Shell end-to-end checks
below remain required and are not replaced by the fixture's simulated consent.

## Deliverables

- [ ] Complete the stock Codex integration check against the implemented Core in an independently
  isolated configuration/credential environment: read-only and expanded consent, cancellation,
  refresh/restart persistence, read/write gate behavior and explicit grant revocation. Confirm new
  login creates an independent row and revoking the old grant leaves the new one usable. Retain
  sanitized inventory and connection evidence; then remove this completed plan and regenerate the index.

Core/Shell implementation, automated coverage and the independent client-removal/credential UI
features are implemented. Their reality documents own the contracts. See the
[local validation report](../../reviews/2026-09-08-oauth-management-validation.md) for 36 passing
OAuth HTTP cases, actual Shell consent, isolated Claude login/refresh, revocation and restart results.

The remaining Codex run could not start: automatic approval review rejected the isolated launcher
because this agent session prohibits overriding `CODEX_HOME`. Production configuration is not an
acceptable fallback. This requires a permitted isolated environment or an operator-run check;
it is a validation constraint, not an unresolved product-design question. Status remains In Progress.

## Verification

Completed checks and their environment limitations are recorded in the validation report. The
remaining live Codex scenario is a completion deliverable, not evidence supplied by the older fixture.
The existing fixture-only compatibility report does not replace validation against the implemented Core.

### Client-Test Isolation

Run Codex probes with a separate temporary `CODEX_HOME`, an explicit fixture-only configuration
and file-based MCP OAuth credential storage inside that directory; never copy the real config,
credentials or plugin state. A `-c mcp_servers=...` override alone does not isolate inherited servers.
Use an isolated working directory and disable inherited plugins/integrations; verify effective
server inventory before starting connections and restrict the test process network to intended
fixture/model destinations. Use equivalent separate Claude configuration/credential storage with
fixture-only MCP inventory. Keep any model-service login needed for a tool-call test separate from
MCP credentials. Assert that no production MCP host is contacted and retain sanitized connection
logs. Validate cleanup of the temporary configuration and credentials. If isolation cannot be
established, stop the probe rather than reuse the operator's production credential stores.

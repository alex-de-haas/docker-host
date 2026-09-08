# OAuth Client Compatibility Probe

Date: 2026-09-08
Repository baseline: `7a3d961cb46d1cd77d5f444a418fb6dd39266a88`
Clients: Codex CLI 0.147.0; Claude Code 2.1.263; macOS.

## Question And Scope

Can stock clients use an OAuth grant narrower than requested, when authorization-server metadata
advertises `mcp:read`, `mcp:lifecycle`, `mcp:update` and protected-resource metadata advertises only
`mcp:read`? This probes client behavior before implementing selectable consent in Hosty.

The server was a disposable Python HTTP fixture bound to an ephemeral loopback port, not Core.
It provided separate AS/PRM documents, DCR, authorization codes with S256 PKCE validation, synthetic
bearers and rotating refresh tokens. The driver simulated the operator's consent selection by
issuing either read-only or all three scopes. No real user credentials were issued by the fixture.
Token responses always included the actual granted `scope`. The fixture itself did not operate on
production grants, but the Codex app-server inherited real integrations; see the isolation correction
below. Production OAuth/session-state changes cannot be excluded.

## Results

| Scenario | Codex 0.147.0 | Claude Code 2.1.263 |
| --- | --- | --- |
| Default login: AS all scopes, PRM read | Requested all three | Requested read only |
| Explicit scope configuration | `-c mcp_servers.<name>.scopes` set to read was honored in the CLI login path | `oauth.scopes` with all three was honored in authorize |
| Explicit Codex CLI all scopes | `mcp login --scopes` requested all three | Not applicable; JSON scope configuration used |
| Request all, issue read | Login succeeded | Login succeeded |
| New client process using saved read grant | Initialized, listed tools, invoked read | Initialized, listed tools, invoked read |
| Control tool with read grant | `isError: true`, `scope_required: mcp:lifecycle`; next read succeeded | Same tool-level refusal; next read succeeded |
| Request all, issue all | Read and control calls succeeded | Read and control calls succeeded |
| Invalidated access token, refresh and retry | Refreshed and retried successfully, requesting the actual granted scopes | Refreshed and reconnected successfully; refresh omitted scope |
| Refresh after narrowed consent | Remained read-only | Remained read-only |
| Denied consent | Exit 1 with `access_denied`; no token issued | Exit 1 with `access_denied`; no token issued |

Claude's DCR payload used read-only `scope` even when its subsequent authorize request explicitly
requested all three. The fixture did not treat the registration scope as a fixed grant ceiling;
Hosty's current registration record has no such scope field either. The authorize request and
approved grant are the relevant inputs for this design.

Codex configuration evidence is specifically the `mcp login` command with CLI `-c` overrides,
not a proof about every desktop auto-login/config-file path. It differs from a blanket reading
of the documentation's advertised-scope precedence statement. Keep the tested path/version explicit.

## Insufficient-Scope Handling

Two refusal forms were tested separately:

- A normal MCP `tools/call` result with `isError: true` and `scope_required`: both clients returned
  the refusal and could immediately read again without new authorization.
- An HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`, a read/lifecycle scope
  challenge and resource-metadata URL: Codex app-server returned `Insufficient scope`. Claude's
  print-mode client reconnected and repeated the challenged call once, then surfaced an
  authorization error described as token expiry. Server observations showed no new authorize or
  token issuance from this challenge. The next separate health probe still connected successfully.

The challenge fixture deliberately always refused that tool; only its read-only-grant run is
relevant to genuinely missing scope. Its all-scopes run tests handling of a persistent challenge,
not a meaningful missing-permission decision. Do not generalize these headless/app-server results
into a claim that every interactive client lacks step-up. Do not depend on automatic step-up for
Hosty's initial release. Provide an actionable explicit re-login instruction.

The Claude model's final sentence claimed no retries; the HTTP trace showed a transport-level retry.
This report follows server observations rather than treating the model's description as evidence.

## Execution And Evidence

Temporary fixture and driver: `/private/tmp/hosty-oauth-client-probe/probe.py`.
Sanitized observation sets: `codex-results.json`, `claude-login-results.json`, and `events.json`
in that temporary directory. These are local diagnostic artifacts, not durable repository test assets.
This report preserves the observed outcomes independently of those files.

Commands/methods exercised:

- `codex --version`, `claude --version`.
- `codex -c 'mcp_servers={...}' mcp login <test-name>` with default/configured scopes and
  `--scopes mcp:read,mcp:lifecycle,mcp:update`.
- Codex `app-server`: `initialize`, ephemeral `thread/start`, `mcpServerStatus/list`, and
  `mcpServer/tool/call`. No model turn was needed for these Codex calls.
- `claude mcp add-json --scope local <test-name> <json>`, followed by
  `claude mcp login <test-name> --no-browser` in a PTY and `claude mcp get <test-name>`.
- Two bounded `claude -p` sessions with only the fixture MCP configuration, built-in tools disabled,
  the three fixture tools allowed, and no session persistence. Server traces verified actual calls.
- Forced server-side access-token invalidation with HTTP 401, followed by client-driven refresh:
  refresh/retry succeeded without changing the granted scope set. This did not wait an hour or
  establish behavior of every proactive refresh scheduling path.
- Post-run assertions passed for successful logins, read/control acceptance-refusal pairs, refresh,
  denied consent and Claude's observed tool-call sequence.
- Temporary Claude configurations were removed and test OAuth credentials logged out. Test servers
  stopped. The driver intentionally invoked only fixture tools, but that does not establish unchanged
  production credential state: inherited integrations performed startup authentication/discovery.

Driver issues resolved during setup: Claude `mcp login` did not consume global `--mcp-config` for
server lookup, and non-TTY stdin prevented completion. A temporary directory-scoped entry plus a
PTY resolved both. Codex's stock app-server also initialized configured integrations during startup;
only fixture tools were explicitly invoked by the driver. Broad inventory output was excluded from
this summary, which must not be interpreted as evidence of network isolation.

## Isolation Correction — Review Of The Same Run

Corrected before committing this report, following owner review on 2026-09-08. The original claim
that production grants were untouched was unsupported and is withdrawn. The `-c mcp_servers=...`
override did not replace all inherited entries. Codex app-server used the real Codex home and
connected to `hosty-core`; stderr includes its `resources/list` and `resources/templates/list`
responses, and the run's inventory included the real server. Startup traffic included authenticated
discovery and may have updated request activity or refreshed/rotated an expired OAuth credential.
The preserved stderr also records refresh attempts rejected by the real Notion integration.

No production lifecycle/update tool was intentionally called. Nevertheless, the available evidence
does not establish whether the production Core grant refreshed, whether credential-cache state
changed, or the complete set of authentication side effects. No production audit verification was
completed as part of this correction. Fixture protocol results remain valid; the no-side-effects
claim does not. A new audit read would itself be another authenticated production request.

Require future Codex tests to use a separate temporary `CODEX_HOME`, fixture-only configuration and
file-backed MCP OAuth storage in that directory, without copying real credentials/plugins. Verify
inventory before connection and constrain network destinations; CLI table overrides are insufficient.
Use equivalent isolation for Claude. These are requirements for subsequent validation, not a claim
that the recorded runs were isolated.

## Decision And Remaining Implementation Verification

Selectable consent is compatible with both tested versions. Keep AS advertising the supported
catalog, PRM advertising read-only bootstrap scope, and let the operator approve a subset. Codex's
default request remains broader than Claude's; PRM alone does not establish a read-only default for
both clients. The consent page must show the actual requested set and the selected grant clearly.

No global breaker is required by these results. Existing scopes remain immutable; new authorization
creates a separate grant. Implement and test server-side subset validation, not just UI checkboxes.

This does not validate Hosty's unimplemented consent page, scoped issuance changes, persistence,
revocation, real update/lifecycle operations or external HTTPS/Cloudflare behavior. Those remain
implementation/live-validation deliverables in the feature plan. Project builds and application
unit suites were not run: no application code changed in this compatibility investigation.

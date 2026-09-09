# Stock Codex OAuth Integration Validation

Date: 2026-09-09
Baseline: `588e8e16bc703ecad32b049ddbaf4b47aebfc2b1`.
Client: stock Codex CLI/app-server 0.147.0 on macOS. Core: 0.98.0; Shell: 0.70.1.

The remaining stock Codex integration deliverable passed against the implemented Core.
This completes the missing client check recorded in the
[2026-09-08 management validation](2026-09-08-oauth-management-validation.md).
Those earlier archives retain their original observations and baseline-specific limitations;
this report does not claim to rerun their Claude, browser UI or configuration-override cases.

## Environment And Isolation

The operator launched the prepared driver from their own terminal with a fresh temporary
Codex profile. The preparing agent did not override its own `CODEX_HOME` restriction. The driver
required that exact disposable profile, selected file-backed MCP credential storage, and
used an empty working directory without inherited project configuration. Neither the normal
configuration nor credentials/keychain were copied. A macOS sandbox denied outbound network
connections except loopback; a denied non-loopback socket probe verified enforcement.

Core listened on `127.0.0.1:3341`, with a separate data directory. Core installed and started a
copied standalone Shell build on `127.0.0.1:3340` and installed the disposable source-runtime app
`com.hosty.oauth-probe`. Only this Shell was present in the temporary distribution catalog.
Effective and connected Codex inventories contained only `local_probe`, targeting that Core's
`/api/mcp`. No model invocation or ChatGPT login was needed: the driver used stock app-server
`mcpServer/oauth/login`, `thread/start`, `mcpServerStatus/list` and `mcpServer/tool/call` requests.

Consent was submitted to the actual Core consent endpoints with a temporary administrator
browser session and CSRF token. The real Codex loopback callback exchanged the authorization
code; the driver did not mint replacement tokens for Codex. Interactive Shell checkboxes were
covered by the earlier report and are not claimed as an additional browser run here.

The tested OAuth endpoint/store, Core MCP endpoint, consent UI and credential UI files match
`main` at `d3f742e7`. The baseline includes unrelated Shell work; copied build artifacts were
prepared before subsequent working-tree changes and their hashes were verified after the run:

| Artifact | SHA-256 |
| --- | --- |
| Core DLL | `ada4ff9423879b042feedb52703e8976f03f8a26075524926b54bf9c2c8bda58` |
| Standalone Shell server entry | `0b1885cddb1cac70550e204407a0ca3d5b651da9840bb1ebe520349a6a11392f` |
| Operator driver | `354cea3481171b750860cd520b5b578e81ca9f20d4aad05bc95f75aadcf81b42` |

The Shell hash identifies the entry file, not a digest of the entire bundle. Temporary drivers
and private logs are local diagnostics, not published repository artifacts. The sanitized
outcomes and connection evidence needed to assess completion are retained below.

## Results

| Scenario | Observed result |
| --- | --- |
| Denied consent | Codex requested all three scopes. Core returned `access_denied`; the Codex callback returned HTTP 400 and reported unsuccessful login. No grant was issued. |
| Read-only consent | Core issued only `mcp:read`; stock Codex listed apps, while `start_app` and `plan_app_update` returned the expected missing-scope errors. |
| Read refresh and restart | The refresh-token hash changed, the grant stayed unrevoked, the same credential id remained, and read/control gate results were unchanged after Core and Codex restarts. |
| Expanded reauthorization | A new login under the same configured MCP server issued a distinct grant and credential row with all three scopes. The old row remained independent. |
| Expanded tool calls | Stock Codex started and stopped the disposable app. Update planning passed the scope check and reached the source-runtime limitation. |
| Expanded refresh and restart | The refresh-token hash changed again within the expanded grant; both credential ids and approved scope sets remained unchanged. |
| Old grant revoked | Restoring only the old disposable credential cache in a stopped test client produced no usable MCP tools. Restoring the new test cache still allowed read and control calls; only the new row remained. |
| New grant revoked | Codex could no longer call tools; the active OAuth credential list was empty. |
| Cleanup | All disposable clients were deleted/revoked, Core-managed apps and Core stopped, both ports were released, and the test profile and Core data were removed. |

Credential snapshots were confined to the disposable file-backed cache and retained in driver
memory only. Before each cache restore the previous app-server was stopped. No production cache
or token was read, restored or revoked.

### Refresh Timing And Limits

The successful refresh check accelerated the same upcoming access-token deadline on both sides:
Core's test access sessions and the one disposable Codex cache entry received a deadline about
20 seconds ahead. Bearer values, refresh-token values and grant scopes were unchanged by this
clock adjustment. Codex then performed refresh itself; the driver asserted changed refresh hashes,
unchanged credential ids and the expected permissions through subsequent real tool calls.
This covers proactive refresh and persistence across process restarts, without waiting an hour.
It does not claim an hour-long wall-clock soak.

An earlier attempt expired only Core's sessions while leaving Codex's cached deadline an hour
in the future. Codex returned `AuthRequired` with an empty tool catalog after restart. This
server-only invalidation/recovery case **did not pass**. That attempt did not retain grant state
before cleanup, so whether refresh was attempted or rotation/replay occurred is not established.
It is kept as a client-compatibility limitation, not counted as a passing proactive-refresh test
or a diagnosed Core defect. Automatic recovery from unexpected server-side invalidation is not
part of the completed scope-issuance contract. The original fixture report's refresh success
must not be generalized to every 401 or connection-startup path.

The driver also needed two harness corrections: treating HTTP 400 on a denied callback as the
expected error-page response, while still requiring failed login/no grant; and reading the
credential fingerprint from API field `id`, not a nonexistent `fingerprint` field. The final run
below completed after both corrections. Independent driver checks against actual Core covered
read/expanded tool gates, stable ids through refresh, and separate revocation before the final run.

No compiled-image update was applied: `plan_app_update` returned the expected source-runtime
restriction after the scope check. No production deployment or production connection was used.

## Retained Evidence

Successful inventories listed only `local_probe` and these Core tools: `apply_app_update`,
`get_app`, `get_host_status`, `list_apps`, `plan_app_update`, `restart_app`, `search_audit`,
`start_app`, `stop_app`, and `tail_app_logs`. After each explicit revocation the corresponding
cache yielded an empty catalog and a failed tool call; `authStatus: oAuth` alone was not treated
as evidence of a working credential.

Selected Core log lines from the actual stock-client run (timestamps/latencies omitted):

```text
Server (hosty-core 0.98.0.0), Client (codex-mcp-client 0.147.0) method 'initialize' request handler completed.
"list_apps" completed. IsError = False.
"start_app" completed. IsError = False.
"plan_app_update" completed. IsError = False.
"stop_app" completed. IsError = False.
```

Core serializes scope refusals in the tool response body, so `IsError = False` by itself is not
proof of authorization. The driver inspected the missing-scope text and actual app runtime state.
For revoked credentials, client logs contained `AuthRequired` and the tool RPC failed.

Sanitized completion data (non-secret grant ids and credential fingerprints retained):

```json
{
  "success": true,
  "codexVersion": "0.147.0",
  "checks": [
    {
      "step": "denied-consent",
      "requested": [
        "mcp:read",
        "mcp:lifecycle",
        "mcp:update"
      ],
      "tokenIssued": false
    },
    {
      "step": "consented-grant",
      "id": "8106b67cfbe3e3c09b07a7e070647ee1",
      "requested": [
        "mcp:read",
        "mcp:lifecycle",
        "mcp:update"
      ],
      "granted": [
        "mcp:read"
      ]
    },
    {
      "step": "read-refresh-restart",
      "sameCredential": true,
      "sameScopes": true
    },
    {
      "step": "consented-grant",
      "id": "2f9892b193117a0f06d2135d1260ab1e",
      "requested": [
        "mcp:read",
        "mcp:lifecycle",
        "mcp:update"
      ],
      "granted": [
        "mcp:read",
        "mcp:lifecycle",
        "mcp:update"
      ]
    },
    {
      "step": "independent-reauthorization",
      "oldFingerprint": "a723834dcf60",
      "newFingerprint": "925728ceeba9"
    },
    {
      "step": "expanded-refresh-restart",
      "sameCredential": true,
      "sameScopes": true
    },
    {
      "step": "old-revoked-new-usable",
      "oldDenied": true,
      "newUsable": true
    },
    {
      "step": "new-revoked",
      "denied": true
    },
    {
      "step": "cleanup",
      "credentialsRemoved": true,
      "testDataRemoved": true,
      "portsReleased": true,
      "errors": []
    }
  ]
}
```

## Documentation Verification

The completion change removes the finished scope plan, updates the feature's testing expectations
and regenerates the docs index. `node scripts/docs-index.mjs --check`,
`node scripts/check-versions.mjs` and `git diff --check` pass. No version change: documentation-only.
Build/unit suites were not repeated for this documentation change; the Core and Shell test builds
and actual stock-client run above provide the relevant validation evidence.

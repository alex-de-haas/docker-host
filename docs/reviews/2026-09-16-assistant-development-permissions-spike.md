# Assistant Development Permissions: Initial Codex Experiment

Date: 2026-09-16
Baseline: `1b1ec0df59079ef05f07d18cb64388a4e6dbd2a0`

This is a partial experiment for
[assistant approval rules](../features/assistant-approval-rules/plan.md), not implementation or an
approval to move that plan to Ready. No Core-managed app was created, started or changed. The existing
working tree includes unrelated gateway changes; this experiment did not modify product code.

## Environment And Availability

- macOS 26.6.2 (25G83), arm64; Node v24.18.0.
- Installed repository Codex CLI: **0.153.4**, authenticated through ChatGPT.
- Installed Claude Agent SDK: **0.3.261**, bundling Claude Code 2.1.261.
- Standalone Claude CLI: 2.1.263; `claude auth status` reported not logged in.
- None of the authentication/provider environment variables checked by `ClaudeHarnessAdapter.probe`
  were present in this execution environment. No real Claude model turn was attempted. This says
  nothing about credentials in a separately running Hosty gateway.
- The current gateway manifest declares newer dependency versions: Codex 0.154.0 and Claude SDK
  0.3.268. Dependencies were not installed or changed. These results apply to the installed versions
  above; verification of the declared versions remains required.

Native protocol types were generated from the installed Codex binary using
`node node_modules/@openai/codex/bin/codex.js app-server generate-ts --out <temporary-directory>`.
The app-server ran with explicit `--stdio`. The outer task sandbox initially prevented opening
Codex's SQLite state under the operator's normal Codex home. The reviewed experiment commands ran
with host execution permission; the child commands were still constrained by Codex's own sandbox.
No permission configuration was written to the operator's settings. App-server may update its normal
service database; model test threads were ephemeral.

## Fixtures And Direct Command Tests

All probe targets were inside one temporary experiment directory:

```text
app-a/source/             primary cwd
app-b/source/             optional second writable app
app-c/source/             ungranted app
app-a/state.fixture       synthetic parent state
cache/                   dedicated writable output
synthetic-secrets/        synthetic secret text, no actual credentials
app-a/source/outside-link -> app-c/source
```

After `initialize`/`initialized`, `command/exec` ran Node `fs.writeFileSync` probes to fixed fixture
paths and a `fs.readFileSync` of the synthetic secret. Failed operations returned their actual OS
error code. Every subprocess exited 0 because the probe intentionally caught and reported failures.
Successful writes were subsequently denied when their permission was removed, including overwrites
of already existing fixture files.

Policies sent through the generated `SandboxPolicy` contract:

```json
{"type":"readOnly","networkAccess":false}
```

```json
{
  "type": "workspaceWrite",
  "writableRoots": ["<root>/app-a/source", "<root>/app-b/source", "<root>/cache"],
  "networkAccess": false,
  "excludeTmpdirEnvVar": true,
  "excludeSlashTmp": true
}
```

The third invocation omitted app B from `writableRoots`. The app-server and command cwd were both
app A's source. Results were:

| Probe | Read-only | A + B + cache writable | A + cache writable |
| --- | --- | --- | --- |
| Write app A source | EPERM | Allowed | Allowed |
| Write app B source | EPERM | Allowed | EPERM |
| Write app C source | EPERM | EPERM | EPERM |
| Write C through symlink in A | EPERM | EPERM | EPERM |
| Write parent state fixture | EPERM | EPERM | EPERM |
| Write dedicated cache | EPERM | Allowed | Allowed |
| Read synthetic secret outside source | Allowed | Allowed | Allowed |

Elapsed command RPC times in the corrected run were 31, 34 and 32 milliseconds respectively.
This tests per-invocation policy changes, not revocation of an already running subprocess or native
thread. It does not establish file-tool enforcement from command enforcement alone.

An initial variant started the app-server in the **fixture parent**, while only the command cwd was
app A's source. Every fixture write succeeded under workspaceWrite, including C and parent state.
Moving the server cwd to source produced the restricted results above. Treat the effective default
workspace root as part of enforcement; an explicit writableRoots list must not be assumed to replace
all implicitly granted roots. The temporary-directory defaults were explicitly excluded in both runs.

## Real Model Turns

Two ephemeral app-server threads used the same fixture cwd. The prompt requested exactly three
steps: apply a patch creating a text file with `v1`, run one exact `/usr/bin/touch` command for a build
marker, then patch the text to `v2`. This was a small edit/command loop, not an actual app build or
Core lifecycle test. No application files or real secrets were sent to the model.

| Configuration | Outcome | Approval requests | Elapsed |
| --- | --- | --- | --- |
| Current adapter posture: read-only + untrusted | First file write requested approval and was declined; model stopped as instructed | 1 before stopping | 11.833 s |
| Candidate: workspaceWrite + on-request, explicit source root, network off | Both patches and command completed; observed text was `v2\n` and marker existed | 0 | 19.712 s |

The first file approval carried `grantRoot: null`. The experiment's narrow approval handler declined
it rather than treating an unknown target as a grant. The baseline therefore does **not** measure
the full cycle's approval count or total generation time. Neither run used full-access mode or
session-wide approval replies. Native completion events exposed file changes and command exit status,
but this does not establish complete Hosty audit coverage.

## Implications And Remaining Verification

The experiment demonstrates that bounded source writes and multiple writable roots are possible on
this Codex/macOS version and that a real simple edit/command loop can avoid repeated approvals.
Legacy workspaceWrite alone fails the proposed sensitive-read boundary: a synthetic secret outside
source remained readable. Additional verified read/credential restrictions are required before claiming
the session development grant has the planned protection.

The owning plan retains unchecked work for Claude live verification, the declared dependency versions,
other supported operating systems, a complete baseline create/build loop, dependency/cache/network
behavior, file-tool secret reads, user/project settings overrides, Core authority and credential/socket
access, and running/resumed-thread revocation. Core-started localCommand applications remain outside
the tested sandbox, under the explicitly accepted administrator-responsibility model.

Temporary evidence for this execution: `/private/tmp/hosty-permission-spike.wdveOg/` contains
`probe.mjs`, generated protocol types, `parent-cwd-results.json`, `offline-results.json`,
`live-probe.mjs` and `live-results.json`. This archive preserves the relevant configuration and results;
temporary files are not a permanent product dependency.

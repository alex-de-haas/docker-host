# Assistant Development Permissions: Pinned-Version Verification

Date: 2026-09-16
Baseline: `1b1ec0df59079ef05f07d18cb64388a4e6dbd2a0`

This experiment covers the owner's requested next step: sensitive reads, independent source-edit and
command permissions, revocation and resume, with reproducible probes on the dependency versions
declared by the gateway. It complements the earlier
[Codex](2026-09-16-assistant-development-permissions-spike.md) and
[Claude](2026-09-16-assistant-development-permissions-claude-spike.md) experiments. Their separate
baseline approval and settings-inheritance observations remain relevant. This report does not approve
product implementation or claim that all permission questions are closed.

## Method And Artifacts

Environment: macOS 26.6.2 (25G83), arm64, Node v24.18.0. Installed **Codex 0.154.0** and
**Claude Agent SDK 0.3.268** into an isolated npm prefix with `--ignore-scripts`; repository dependencies,
lockfile and product code were not modified by this experiment. No Core app or service was changed.

Both model APIs were local scripted HTTP fixtures. Tool execution, native permission handling and
OS sandbox enforcement were real. These tests measure fixed attempted actions, not model behavior,
actual inference cost or a real application generation/build. No provider credentials were required.
Each harness used a separate temporary configuration/state directory and only synthetic secrets.

Preserved runners:

- [Claude runner](../../scripts/experiments/assistant-permissions/claude.mjs)
- [Codex runner](../../scripts/experiments/assistant-permissions/codex.mjs)
- [Fixture/RPC utilities](../../scripts/experiments/assistant-permissions/common.mjs)
- [Static native-tool catalog](../../scripts/experiments/assistant-permissions/model-catalog.json)

The Codex catalog explicitly enables native `apply_patch` and unified execution using a synthetic
model id. It contains no model inference or operator instructions. This establishes behavior of those
native tools, not parity with every live model's tool catalog or code-mode executor. The runners save
raw synthetic transcripts/RPC evidence and machine-readable check results under `--out`. They reject
an existing fixture directory to prevent previous files from producing false successes.

## Results

Final fixtures were outside system temporary directories, matching ordinary Core-managed source
placement. Automated checks: **Claude 21/21 passed; Codex 18/19 passed**. The failed Codex check is a
real running-process revocation failure, retained as a failing regression rather than marked successful.

| Requirement | Claude 0.3.268 | Codex 0.154.0 |
| --- | --- | --- |
| Write to explicitly granted A and B | Passed | Passed |
| Ungranted C remains unwritable | Passed | Passed |
| Shell cannot read synthetic secret outside source | Passed | Passed with named filesystem profile |
| File-tool secret access | Read and symlink Read denied by PreToolUse hook; public Read succeeds | apply_patch's attempt to read the protected file fails with EPERM |
| Edit source enabled, commands disabled | Write succeeds; Bash denied by hook | apply_patch succeeds; exec_command unavailable |
| Commands enabled, edits disabled | Bash executes, source writes get EPERM, dedicated cache writable; Write denied | exec_command executes with source read-only and writable cache; apply_patch rejected |
| Both permissions disabled | Neither attempted operation succeeds | Neither attempted operation succeeds |
| Resume with B revoked | B file write denied and B shell write gets EPERM | Actual persisted thread resumed after app-server restart; B write gets EPERM |
| Stop an executing command | interrupt plus query close stopped the tested foreground process | command/exec/terminate stopped its standalone process |
| Revoke during a model turn | Tested foreground writer stopped | turn/interrupt left the unified-exec writer running |
| Project settings cannot widen candidate grant | Passed with settingSources empty and host hook | Not covered by these fixtures |

All Claude scenarios recorded zero approval callbacks. Denied operations were rejected by hooks or
native restrictions, rather than converted to user approval cards. Codex tests used `approvalPolicy:
never`, so rejected operations stayed rejected; a normal Hosty UI may separately offer explicit scope
expansion. These results do not authorize bypassing an operator denial.

### Claude candidate

Combine `acceptEdits` and `additionalDirectories` for source writes with the shell sandbox's matching
`allowWrite`. With edits disabled, use default permission mode plus sandbox `denyWrite` for source;
dedicated cache remains writable. A PreToolUse hook rejects disabled commands/edits and resolves
file-tool paths against the allowed source roots, including existing symlink targets. Allowed actions
still pass through native permissions; the hook does not broadly return an allow override.

The hook stops Read before the gateway's unconditional Read auto-allow can expose the fixture secret.
The tested native tool set did not expose Grep or Glob; attempted calls were rejected as unavailable.
Their path guards in the runner are not validated enforcement for a future tool set that exposes them.

`settingSources: []` prevented a pre-seeded `.claude/settings.json` from reopening C or the secret.
The source-local settings contained native allow rules and sandbox allowWrite/allowRead entries.
Sandbox credential filtering removed the synthetic control-token environment variable.

Inline `node -e` probes containing braces triggered a native "Brace expansion" approval callback even
with sandbox auto-allow enabled. The final probes use ordinary `node <script>` commands and did not
raise that callback. Do not interpret the zero-card result as proof that every possible shell syntax
will bypass native permission prompts. Any Hosty auto-allow callback must still preserve the sandbox.

On revocation, the runner denied subsequent dispatch, called query interrupt and closed the query.
A foreground process writing every 100 ms stayed at 2 bytes after a further 1.2 seconds; the next
scripted write did not run. This is not a proof of termination for deliberately detached daemons or
all descendant process topologies.

### Codex candidate

Use named filesystem profiles with explicit source/cache paths and exact `deny` entries for secrets.
`default_permissions` must be set when declaring profiles. The experiment's initial missing default
produced an "Invalid configuration; using defaults" startup diagnostic; final runs supplied the
default and check that this diagnostic is absent. Do not allow silent configuration fallback in Hosty.

The profile permits the minimal runtime files and the system OpenSSL configuration needed by this
Node installation; missing that read caused Node startup failure, not a successful containment test.
This reinforces the distinction between source access and required read-only toolchain access.

For edit-only native-tool sessions, disabling `features.shell_tool` and `features.unified_exec` left
apply_patch usable and made a forced exec_command call unsupported. The command-only profile retained
execution with read-only source. Native apply_patch also failed to read the denied secret. Resume
explicitly supplied the narrower profile; it was not inferred from changed conversational app ids.

### Blocking finding: interrupted Codex turns can leave old authority running

The probe started a foreground Node process that appended one byte every 100 ms, for at most four
seconds. After two writes, it invoked `turn/interrupt`. The server reported the turn as interrupted,
but the file grew from **2 to 14 bytes** over the following 1.2 seconds and eventually reached 40.
The next turn correctly used the narrower profile, while the earlier process continued under its
original permissions. Thus "the next turn has new rights" is insufficient for revocation.

A second run added `thread/unsubscribe` after interrupt. It returned `unsubscribed` but produced the
same 2-to-14 growth. Sending SIGTERM to the app-server at runner shutdown also did not establish
termination of this already running writer. These operations must not be presented as verified
revocation of subprocess access.

Standalone `command/exec/terminate` did stop the separately registered process (2 bytes before and
after the observation window), but that RPC is not evidence of control over unified-exec processes
started by model tools. The native command item's processId and the standalone process registry are
different interfaces; routing or ownership needs an explicit design.

Before shipping revocation, either give Hosty verifiable ownership/termination of all commands in the
grant, or keep revocation pending until every old execution has actually quiesced. Reject new dispatch
as soon as revocation starts; never claim completion based only on turn status. This remains tracked
work in the owning plan, not a product fix delivered by these experiments.

### Blocking finding: temporary-path behavior is broader than the named profile

When the Codex fixtures were under `/private/tmp`, the same named profiles allowed writes to C and
reading the synthetic secret, including with a dedicated process TMPDIR and `:slash_tmp = "deny"`.
The final valid-default configuration reproduced this behavior. Moving fixtures outside temporary
directories produced the enforced results above. The precise source of the temporary-path allowance
is not established by this experiment; it must not be attributed to a particular internal mechanism
without further evidence.

Preserve this negative case: omitting `--fixtures` makes the Codex runner use its output directory's
fixtures, and a `/private/tmp` output reproduces the problem on this environment. Do not advertise
arbitrary-path containment or session-private temporary storage based on the successful outside-temp
tests. Claude's shared sandbox TMPDIR limitation from the earlier report is also still unresolved.

## Reproduction

Run from the repository root with Node and npm. These scripts need native sandbox/process support and
permission to bind the loopback mock servers. They must not be run against an existing app source.
Paths below are examples: replace them with new empty locations. Keep normal fixture roots outside
system temporary directories; use the intentional negative case separately.

```sh
npm install --prefix /private/tmp/hosty-permission-deps --ignore-scripts --no-audit --no-fund @openai/codex@0.154.0 @anthropic-ai/claude-agent-sdk@0.3.268
node scripts/experiments/assistant-permissions/claude.mjs --deps /private/tmp/hosty-permission-deps --out /private/tmp/hosty-claude-evidence --fixtures /absolute/non-temporary/empty-claude-fixtures
node scripts/experiments/assistant-permissions/codex.mjs --deps /private/tmp/hosty-permission-deps --out /private/tmp/hosty-codex-evidence --fixtures /absolute/non-temporary/empty-codex-fixtures
```

Expected current results: Claude exits 0; Codex exits 1 because `turn quiescent` fails. Add
`--revoke unsubscribe` with fresh directories to reproduce that unsuccessful mitigation. To reproduce
the separate temporary-path failure, use a fresh output under `/private/tmp` and omit `--fixtures`.
Each foreground writer has a four-second self-termination limit, including failed revocation cases.

Evidence from this execution is under `/private/tmp/hosty-permissions-verified.v6JjpR/`, notably
`claude-final`, `codex-final`, `codex-unsubscribe` and the valid-default temporary-path run `codex-run8`.
The in-repository disposable fixture directories were removed after the bounded writers finished.

## Remaining Scope And Verification

The requested probes are implemented and run; the experiments identify two unresolved Codex boundaries
rather than proving the feature ready. Full live model generation, package/network setup, other OSes,
code-mode/subagent/WebFetch/MCP paths, arbitrary detached descendants and actual Core credentials or
control endpoints are not validated here. The shared authorization feature remains Draft.

Checks run: Node syntax checks for the runners, their native runtime assertions, docs-index validation,
relative documentation links and git diff whitespace validation. Product builds and product suites
were not run: no shipping artifact code was changed by this experiment. No release version change
is introduced for these development-only experiment scripts and documentation.

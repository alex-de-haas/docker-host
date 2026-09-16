# Assistant Development Permissions: Claude Enforcement Experiment

Date: 2026-09-16
Baseline: `1b1ec0df59079ef05f07d18cb64388a4e6dbd2a0`

This is a partial experiment for
[assistant approval rules](../features/assistant-approval-rules/plan.md), companion to the
[Codex experiment](2026-09-16-assistant-development-permissions-spike.md) of the same date. It is not
implementation or an approval to move that plan to Ready. No Core-managed app was created, started or
changed, and no product code was modified. The working tree contains unrelated uncommitted gateway
changes.

## Environment And Method

- macOS 26.6.2 (25G83), arm64; Node v24.18.0.
- Installed Claude Agent SDK **0.3.261**, bundling the native Claude Code 2.1.261 binary. The gateway
  manifest declares 0.3.268; dependencies were not installed or changed.
- No gateway credentials were available, and no real model turn was made. Instead, a local scripted
  Messages API mock served as `ANTHROPIC_BASE_URL` and returned predetermined `tool_use` blocks. Tool
  execution, permission evaluation, `canUseTool` callbacks and the Bash sandbox are the real bundled
  implementation. The mock received no auxiliary model requests (only `HEAD /api/hello`), so no
  permission decision depended on a model classifier. The results measure enforcement for a fixed
  action sequence. They say nothing about how a real model reacts to denials, about token cost, or
  about the number of approvals a real generation needs. Elapsed times against the mock are not
  meaningful and are omitted.
- Each scenario ran the SDK child with a clean environment, its own `CLAUDE_CONFIG_DIR`, nonessential
  traffic disabled and a synthetic `HOSTY_SYNTHETIC_CONTROL_TOKEN` variable. The operator's own
  `~/.claude` was not used or modified.
- `canUseTool` mirrored `AUTO_ALLOWED_TOOLS` in `apps/ai-gateway/src/harness/claude.ts`. In the
  baseline, every other tool was allowed, which simulates the operator clicking Allow; in candidate
  scenarios, every other tool was denied.
- Fixtures lived outside the temporary directories. This host's Core data root is `~/.hosty`, so a
  `/tmp` fixture would have mixed sandbox temp-directory allowances into the results. The layout
  matches the Codex experiment, plus `app-a/source/.git/hooks/` and `.git/config`. A loopback HTTP
  server stood in for a host-control endpoint.

Candidate options passed to `query()`:

```json
{
  "cwd": "<root>/app-a/source",
  "permissionMode": "acceptEdits",
  "additionalDirectories": ["<root>/app-b/source"],
  "settingSources": [],
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["<root>/app-b/source", "<root>/cache"],
      "denyRead": ["<root>/synthetic-secrets"]
    },
    "network": { "allowedDomains": [] },
    "credentials": { "envVars": [{ "name": "HOSTY_SYNTHETIC_CONTROL_TOKEN", "mode": "deny" }] }
  }
}
```

The "A only" variant removed app B from both `additionalDirectories` and `allowWrite`.

## Edit/Command Loop

The scripted sequence was the same as Codex's: write a file with `v1`, run one exact `/usr/bin/touch`
for a build marker, read the file, then edit it to `v2`.

| Configuration | Approval callbacks | Outcome |
| --- | --- | --- |
| Current adapter posture: `default` mode, gateway auto-allow set | 3 (Write, Bash, Edit); Read auto-allowed | Completed after each simulated Allow |
| Candidate: `acceptEdits`, granted roots, sandboxed Bash | 0 | Text `v2`, marker present |

## File Tools

Candidate A+B, with every callback denied:

| Target | Result |
| --- | --- |
| Write/Edit in A (cwd) | Auto-accepted, no callback |
| Write in B (`additionalDirectories`) | Auto-accepted, no callback |
| Write in C | Callback, "Path is outside allowed working directories" |
| Write to C through a symlink inside A | Callback, same reason (target resolved) |
| Write parent state fixture | Callback, same reason |
| Write dedicated cache (sandbox `allowWrite` only) | Callback, same reason |
| Write `app-a/source/.claude/settings.json` | Callback even inside cwd under `acceptEdits` |
| Read synthetic secret outside roots | Claude Code raised a callback; the gateway auto-allow set allowed it, and the secret was returned |
| Write B in the A-only variant | Callback, same reason |

Under `acceptEdits`, file operations outside the boundary are not refused natively. They fall back to
`canUseTool`, so file-tool containment is only as strong as the gateway's callback answer.
`sandbox.filesystem.denyRead` does not govern the Read tool. File-tool roots
(`additionalDirectories`) and shell roots (`allowWrite`) are configured separately, as the cache row
shows.

## Sandboxed Shell Probe

A Node probe ran through the Bash tool. Columns: candidate A+B; candidate A only; a session resumed
with B revoked; and the candidate with the source-local project settings described below.

| Probe | A+B | A only | Resumed, B revoked | Project settings |
| --- | --- | --- | --- | --- |
| Write A source | Allowed | Allowed | Allowed | Allowed |
| Write B source | Allowed | EPERM | EPERM | EPERM |
| Write C source | EPERM | EPERM | EPERM | **Allowed** |
| Write C through symlink in A | EPERM | EPERM | EPERM | **Allowed** |
| Write parent state fixture | EPERM | EPERM | EPERM | EPERM |
| Write dedicated cache | Allowed | Allowed | Allowed | Allowed |
| Write sandbox `TMPDIR` | Allowed | Allowed | Allowed | Allowed |
| Write `/tmp` | EPERM | EPERM | EPERM | EPERM |
| Write/rename into `.claude/settings.json`, write `settings.local.json` | EPERM | EPERM | EPERM | EPERM |
| Write `.git/hooks/pre-commit`, `.git/config` | EPERM | EPERM | EPERM | EPERM |
| Write `CLAUDE.md` in source | Allowed | Allowed | Allowed | Allowed |
| Read synthetic secret | EPERM | EPERM | EPERM | **Allowed** |
| Synthetic control-token env var | Absent | Absent | Absent | Absent |
| Loopback control endpoint | EPERM | EPERM | EPERM | EPERM |
| External HTTPS | ENOTFOUND | ENOTFOUND | ENOTFOUND | ENOTFOUND |

Sandboxed commands raised no approval callback. A command that requested
`dangerouslyDisableSandbox: true` under `allowUnsandboxedCommands: false` produced the same row as the
sandboxed command.

## Settings Layers

**User settings (H2).** This run used the current posture (`default` mode, no sandbox,
`settingSources: ["user", "project"]`) with a synthetic user `settings.json` containing
`Bash(echo:*)` and `Edit(//<root>/app-c/**)`. Both actions ran with **zero callbacks**, including a
write to ungranted app C. User allow rules therefore pre-empt `canUseTool`, and with it the approval
card and the `ai_action_approved` audit report. The operator's actual `~/.claude/settings.json` on
this host contains no allow rules (only the count was inspected), so this host is not currently
exposed through that file.

**Project settings in granted source.** The candidate ran with `settingSources: ["user", "project"]`
and a pre-seeded `app-a/source/.claude/settings.json`:

- `sandbox.enabled: false` was not honored, and commands stayed sandboxed.
- A file-tool write to C still raised a callback.
- `permissions.allow` with `Edit(...)` alone made C writable from the shell, because Edit allow rules
  merge into sandbox `allowWrite`. `Read(...)` allow alone did not override `denyRead`.
- `sandbox.filesystem.allowWrite`/`allowRead` alone made C writable and the secret readable from the
  shell.

Inside the session, the agent could not create these files itself: the file tool raised a callback,
and a shell write or rename returned EPERM. Source that already contains them still widens the next
session. That covers a cloned repository, an earlier operator-approved write, an operator's own
edit, or the Core-started app itself, which runs outside the assistant sandbox and can write its own
source.

## Resume

Resuming the same native session id with narrower options applied the narrower boundary. A B
file-tool write raised a callback, and the B shell write returned EPERM. Options apply per query
process. Revocation within a running query and for in-flight subprocesses was not tested.

## Audit Visibility

Auto-accepted edits and sandboxed commands raised no `canUseTool` callback. They did appear in the
SDK message stream as `tool_use` and `tool_result` blocks, with inputs and results. Auditing the
autonomous actions therefore needs the stream or hooks, not the callback, which is consistent with G.

## Other Observations

- Only the `acceptEdits` run created an empty, owner-only `.claude/.cc-writes/` directory in cwd. An
  assisted Git save must not commit it.
- The sandbox's `TMPDIR` resolved to `/private/tmp/claude-501`. That directory is shared by every
  sandboxed Claude Code process of the OS user, not per session. Sessions holding different grants can
  exchange files through it, although it is not another app's root. The Codex experiment excluded its
  temporary directories explicitly.
- With `allowedDomains: []`, loopback and external DNS both failed. Dependency setup therefore needs an
  explicit domain allowlist; that was not tested.
- The environment-variable deny removed the synthetic token from sandboxed commands. Two things were
  not checked: what the real gateway process inherits from Core, and what the unsandboxed Claude Code
  process and MCP servers can reach.

## Implications And Remaining Verification

- On this version, a zero-card edit/command loop with bounded writes is achievable through
  `acceptEdits` plus `additionalDirectories` for file tools, a matching sandbox `allowWrite` for
  commands, and callback denial for everything else. Both lists must be derived from the one Hosty
  grant; the separate cache result shows how they drift.
- The gateway's unconditional Read auto-allow defeats the sensitive-read boundary for file tools. The
  sandbox `denyRead` covers the shell only.
- Both writable settings sources widen the grant. User allow rules bypass callbacks, and project
  settings widen the shell sandbox. `managedSettings` is restrictive-only and cannot cancel an allow.
  Development sessions must not load writable settings sources unvalidated. Without `project`, the SDK
  also stops loading project `CLAUDE.md`, which needs a deliberate replacement.
- Compared with Codex: bounded multiple roots, symlink refusal, parent-state refusal and resume
  narrowing agree. Claude's shell sandbox also denied the secret read, `.git` hooks/config and
  `.claude` settings writes. Claude needs gateway policy for file-tool reads.

The following remain open:

- real model turns with gateway credentials, including a complete create/build loop and its actual
  approval count;
- the declared SDK version and Linux (`bubblewrap`) or other platforms;
- package setup with a network allowlist and dependency caches;
- mid-run revocation and in-flight subprocesses;
- subagents through the auto-allowed `Task` tool;
- the auto-allowed in-process `WebFetch` as an egress path that the sandbox network policy does not
  govern;
- Core control credentials and sockets reachable outside the sandboxed shell.

The mock server, probe and per-scenario JSON results lived in a temporary session workspace and are
not retained. The candidate options above and the tables preserve the configuration and outcomes.

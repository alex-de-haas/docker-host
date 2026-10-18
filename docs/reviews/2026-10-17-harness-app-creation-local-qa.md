# Harness Local App Creation QA — 2026-10-17

Baseline: `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), plus the uncommitted
app-creation implementation on its registered external workspace branch. This report describes the
initial creation/preview slice, not completion of the entire app-prototype-workspaces plan.

## Stand And Authority

The test used a separate source-launched parent Core on macOS and Linux Docker containers. The
primary Core remained on its installed release. The selected Codex and Claude connections were
copied into the disposable Harness with explicit owner approval. Normal password setup/login and
reviewed app installation were used; no seeded browser identity or auth bypass was used.

Harness ran one shared Docker worker at a time, separately from each generated application's Docker
container. Agent source edits used registered worktrees; the application mounted that worktree
read-only, a dedicated dependency cache and its own child-Core data. The parent app was registered
stopped with autostart off. Each canonical source contained exactly one bootstrap commit and no
remote; generated edits were not committed, pushed or published.

Temporary 2 GiB ceilings were approved for the main Shell, Workspaces and Marketplace containers.
Docker 29.8.2 accepted an update to zero without clearing the limits. After separate owner approval,
Core recreated precisely those three apps. Inspection confirmed new container ids, running services
and original Memory=0/MemorySwap=0. Workspaces and Marketplace were healthy. Their data was retained.

## Real Provider Results

| Provider | Generated app | Browser and runtime result |
| --- | --- | --- |
| Codex, normal approvals | Notes stored in child app data | Normal child login and app launch-code exchange; browser-created note survived reload. A second client edit changed the heading while preserving the same note and sandbox. |
| Claude, normal approvals | Counter stored in child app data | Normal child login; Increment changed 0 to 1 and reload retained 1. A malformed generated client tail initially caused `/client.js` to return 503; Claude repaired it in the same worktree/container, after which the bundle returned 200. Anonymous GET/POST counter access returned 401. |

The first Codex preview exposed an incorrect bootstrap launch-code route. The package was corrected
to `/api/auth/app-code`; the later Claude app used the corrected package and authenticated without a
manual auth repair. Claude's initial HTTP probes used container-local `*.localhost` and could not
connect. The verified host-gateway routing and distinction between health and client build were
added to the packaged guide. No runtime fallback to a host command was used.

The run also exposed normal-mode Codex attempting nested Linux sandboxing inside the managed Docker
worker. Its transport now uses Codex's external-sandbox protocol while preserving normal approvals.
A worker disk accounting failure led to a bounded one-retry policy; its transient cause was not
proven from retained stderr, and persistent/incomplete observations remain errors. Duplicate React
keys were corrected. Removing message-level content-visibility fixed a reproduced renderer crash
with the long approval history; the restored history and subsequent Claude conversation remained
usable through reload, Core auth renewal and new-session navigation. Child setup passwords are
redacted from persisted Harness tool/approval inputs.

## Memory

These are peak cgroup memory observations, including cache/runtime overhead, not process RSS or
host-wide totals. They are workload examples, not a sizing guarantee. The worker is reused by role;
separate generation names reflect its normal per-turn recreation, not concurrent agent replicas.

| Workload | Observed peak |
| --- | ---: |
| Codex worker (Harness retained peak) | 749,338,624 bytes / 714.6 MiB |
| Notes application | 307,605,504 bytes / 293.4 MiB |
| Claude worker | 214,167,552 bytes / 204.2 MiB |
| Counter application | 320,376,832 bytes / 305.5 MiB |

App peaks include dependency setup/client bundling. No isolated cold-image benchmark was attempted;
shared image caches were retained.

## Finish And Cleanup

Both agents called the existing environment Finish operation with the current revision and a stable
request id. The corresponding child roots, exact app container ids and dependency cache volumes
were absent afterward. Both canonical sources remained clean with one commit/no remote; Codex's
three changed/untracked files and Claude's two modified files remained in their worktrees.

After these source-preservation assertions, the whole deliberately disposable parent stand was
stopped and deleted. Its launch grant was revoked. Provider credential copies, worker home/cache,
conversation transcripts, child test passwords and test apps were removed with the stand. The
remaining stopped test Marketplace container was removed by verified instance ownership. No worker
or child container remained, and no matching test network/volume remained. Shared images/caches and
unrelated Docker objects were not pruned. Screenshots and concise measurements stayed outside the
repository; raw evidence JSON and logs are not part of the change.

## Verification Commands

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --nologo`: passed; four existing
  compiler/platform warnings, no errors.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter FullyQualifiedName~AppCreation --nologo`:
  11 passed, covering allocation, authority, replay, path protection and source retention.
- Harness `npm test`: 79 files, 678 tests passed.
- Harness `npm run lint`, `npm run build:web` and web `npm run lint`: passed.
- Harness runtime/adapter tests after worker version synchronization: 37 passed.
- Worker Dockerfile build for 0.57.0: passed. A credential-free, network-disabled binary check
  reported Node 22.23.3, Codex 0.162.1 and Claude Code 2.1.296; its temporary image was removed.
- `node scripts/check-versions.mjs`: passed; Core 0.139.0 → 0.140.0, Harness/worker 0.56.0 → 0.57.0.

- Full Core `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --nologo`:
  3,415 passed, 4 skipped, no failures. The skipped tests require explicit Docker-development or
  companion Torrent/VPN opt-in fixtures; they were not enabled for this creation-focused run.
- CLI `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --nologo`:
  built successfully; 230 passed.
- `node scripts/docs-index.mjs --fix`, `--check` and `git diff --check`: passed.

## Scope Still Open

The plan retains unchecked work for Accept locally/Use locally, remote attachment and source-loss
controls, optional icon/continuation UI, additional guide readers and multi-service/.NET/direct-
protocol acceptance. This test does not close D15/D16 or prove those paths. Windows and a native
Linux host were not available; Linux execution here was through Docker on macOS. The new versioned
worker image was built and binary-checked locally but not published; the real-provider runs used
the preceding pinned worker payload (same provider versions) with the modified source coordinator. No repository commit or PR was created.

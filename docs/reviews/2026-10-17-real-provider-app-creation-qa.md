# Real-Provider App Creation QA — 2026-10-17

## Baseline And Scope

Baseline `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` (PR #606), with the uncommitted
app-creation feature through D15 and the D16 corrections described below. Reserved versions remain
Core **0.140.0** and Harness **0.57.0**. This is source-feature verification, not released-build QA.

An isolated parent Core on macOS ran the source Harness. Real Codex 0.162.1 and Claude Agent SDK
0.3.296 used the shared Docker worker in **normal** approval mode; application containers ran under
separate child Core instances on the same Linux ARM64 Docker engine. The operator approved temporary
copies of the two selected provider connections and the test Harness permissions. No host home or
Docker socket was mounted into the agent. Parent production application data was not copied.

Both apps were created through Harness with one explicitly consented bootstrap commit, local main,
no remote, a stopped parent installation and a registered session worktree. Generated changes remained
uncommitted. There was no push, PR, publication or automatic acceptance of generated code.

## Codex: .NET Backend And Node/React UI

Codex replaced the bootstrap with a .NET 10 notes backend and Node 24 React UI. The frontend used
normal Hosty app identity and the private backend used Core service discovery. Sources were read-only
inside app containers, with separate dependency/build cache volumes and a backend-owned data mount.
An invalid generated healthcheck was rejected before installation; the agent corrected it and used
the normal child installation review.

The operator logged into the child Core with its disposable password account. Browser PKCE opened
the app, wrote a note and retained it after reload. A subsequent frontend change appeared on page
refresh in the same containers. This verifies source-driven rebuild on request, not refresh-free HMR.

The exact backend container was then stopped. The browser showed a request failure without losing
its loaded note. Codex read app state/logs, changed a compiled health revision to 2, built/tested and
restarted the same application. The new revision was observed and the browser recovered the original
note. The persisted JSON SHA-256 remained unchanged throughout repair and restart.

Actual optional .NET store and Node auth checks passed. A stale recipe digest was refused; replaying
the original successful request returned its receipt. A Harness check while the agent held source
write authority returned `workspace_busy`.

A denied native command did not execute. A later read-only long-running command was cancelled through
Harness Stop. Restarting Harness restored the same history/workspace. Restarting the configured parent
Core with `--keep-apps` adopted Harness and preserved the running child process and app data. Replaying
the original creation and dispatch inputs recovered the original worktree without a second model turn.
The same Codex session resumed and finished its child through the MCP environment API.

Independent inspection verified removal of both app containers, one network, five cache volumes and
the child data root. All 15 worktree source hashes and the canonical bootstrap HEAD remained unchanged;
no source lease remained after Finish. The unfinished workspace stayed protected from retention.

## Claude: Rust And Direct Hosty Protocol

Claude replaced the Node bootstrap with a Rust counter using tiny_http, ureq and serde_json, plus
plain browser JavaScript. It read the SDK protocol and implemented launch-code PKCE exchange,
HttpOnly app cookies and live Core revalidation. The worker had no Rust toolchain or Docker socket;
compilation used the separate application's official Rust Docker image.

The first recipe failed because the image login shell did not retain the Cargo PATH. The agent
read the bounded service logs and added an explicit toolchain path. The next attempt correctly
failed to write Cargo.lock in read-only source. A reviewed generatedFiles overlay supplies that
single writable file in the child app cache; source remains read-only. The optional check timeout
was corrected to Core's documented maximum of 300 seconds. Both failures retained the same child,
worktree and installation rather than allocating replacements.

Normal password login to the child Core and automatic app PKCE opened the Rust UI. Two browser
increments persisted count 2 after reload. Harness Check preview executed all 15 Rust unit tests
successfully (exit 0) and displayed the receipt. A controlled stop of only that app container made
the browser show a connection error while retaining the displayed count. Compiled iteration and
recovery verification continues below.

Claude diagnosed the stopped runtime, changed a compiled health revision and page heading, then
started the same installation. The actual health endpoint reported buildRevision 2; the browser showed
the recovered heading and count 2. The data-file SHA-256 remained identical. Harness marked the old
check stale and reran all 15 tests successfully against the new source/container revision.

Claude then issued Finish with the observed revision and one stable request id. Independent inspection
confirmed removal of the app container, two cache volumes, generated Cargo.lock cache and whole child
root. Its network was Docker's shared default bridge, correctly retained. All nine worktree file hashes,
clean canonical bootstrap HEAD and absence of remotes were unchanged. The parent app remained stopped.
The application was a disposable test fixture, not a newly published first-party app.

## Findings And Corrections

- Harness parsed every workspace inspection response as JSON. An unsupported bare workspace URL
  returned an empty Core 404 and surfaced as Harness 500. Inspection now preserves non-success HTTP
  status with a bounded generic fallback, retains structured error codes/messages and reports malformed
  successful responses as 502. Regression tests cover empty, HTML, null and malformed fields.
- Claude initially supplied the worktree id where child creation requires the aggregate workspace id.
  Core refused before allocation and the agent corrected the request. The packaged guide and tool
  schema now name both fields and show `workspaceId: worktree.workspaceId`, `worktreeIds: [worktree.id]`.

- Finish retained the last live memory/disk sample even after verified deletion. Core now clears it
  only after successful cleanup and suppresses legacy samples on finished views. Failed cleanup
  retains its diagnostic sample. Resource sampling rechecks terminal state after acquiring its gate.
  Regression coverage verifies failure, retry, stored cleanup and legacy read/list behavior.

A test restart initially omitted the one-run port override and correctly refused the occupied default
port. Persisting the test Core's port through ordinary settings fixed the stand. This was test setup,
not a CLI product defect. The main Core was not restarted or replaced.

## Coverage Boundaries

This run adds real provider generation, multi-service/.NET and direct-protocol/Rust Docker/browser
acceptance. Earlier reports remain the evidence for other acceptance-script branches:

- [D12 continuation](2026-10-17-local-building-continuation-qa.md): completed-chat/worktree removal,
  source override/clear and new sessions from accepted local main.
- [Local handoff](2026-10-17-local-app-handoff-qa.md): real Codex commit, Accept locally, Complete and
  Use locally with ordinary data separate from preview.
- [D13 reuse](2026-10-17-multi-service-sandbox-reuse-qa.md): reviewed topology replacement, obsolete
  service removal and image rebuild in the same sandbox.
- [D14 repair](2026-10-17-preview-checks-recovery-qa.md): failed image/build/entrypoint, absent recipes,
  check failures, stale digests and timeout descendant termination.
- [D15 regression](2026-10-17-app-creation-recovery-regression.md): crash boundaries, invalid input,
  owner/permission matrices, publication failures and retention/source-loss guards.

Local-to-remote association, the new source-loss review, additional guide readers and final whole-feature
verification remain their unchecked plan deliverables; no hosted remote was created for this run.
Windows and remote production preview were not tested. Docker base images and shared build caches
were already present or downloaded normally; this is not an empty-engine benchmark.

## Resource And Timing Observations

| Component | Sampled Docker memory peak | Last live sample |
| --- | ---: | ---: |
| Codex worker | 770.8 MiB | Varies by turn |
| Claude worker | 227.8 MiB | Varies by turn |
| Codex Node frontend | 179.9 MiB | 126.8 MiB |
| Codex .NET backend | 383.3 MiB | 150.0 MiB |
| Claude Rust app, including compilation | 133.6 MiB | 5.24 MiB |

These periodic docker-stats samples are observations, not guaranteed maxima or capacity estimates.
Harness cgroup peaks were 877.77 MiB for Codex and 276.47 MiB for Claude; cgroup and docker-stats
accounting differ, including cache treatment. Worker limits were 4 GiB/2 CPU; Codex's two services
received 1 GiB each and the single Rust service 2 GiB. A parent/child Core host-RSS snapshot during
Claude recovery was approximately 394/210 MiB; it is separate from container measurements.

Codex's prepared child start took 1.12 s; its first app start 14.02 s; compiled warm restart 14.50 s;
Finish 7.30 s. Rust's first successful startup reached the displayed Core ready timestamp in about
11 s after approval, after the two recipe failures above. Its warm source-recompile start took
6.28 s from approval to Core ready. The agent's first post-Finish status request occurred 6.62 s
after approval, bounding that completed Finish operation. Operator/agent thinking and review time
are excluded. Fresh app caches were used initially, but shared images/engine caches were retained;
these numbers do not replace D9's separate empty-engine measurements.

## Verification And Cleanup

- Exact Core project build passed, zero errors and four existing warnings.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter 'FullyQualifiedName~CoreEnvironment|FullyQualifiedName~Http.AppCreationHttpTests'`
  — **103 passed, 0 failed, 0 skipped**. Covers lifecycle/resource/consent regressions and the
  packaged guide through Core HTTP. The wider D15 regression is referenced above, not rerun here.
- `npm test --workspace @haas/hosty-harness` — **82 files, 703 tests passed**.
- `npm run lint --workspace @haas/hosty-harness` and
  `npm run build:web --workspace @haas/hosty-harness` — passed.
- Live Harness repro after the fix: unsupported bare workspace endpoint returns 404; valid worktree
  endpoint still returns 200. Both source trees remain available after sandbox Finish.

The rebuilt test Core started with a new process identity and the expected source project; live
readback of both finished children returned null usage. The guide endpoint returned the corrected
ID/cache instructions. Browser reload restored the existing Harness conversation and retained
unaccepted source; finished preview rows were absent.

All child resources were checked by exact ownership/IDs before removing the parent fixture. The
parent Core and Harness were stopped; their listeners and the child preview listeners closed. No
D16-owned containers remained. The exact temporary worker image was removed; unrelated containers,
base images and shared engine caches were retained. The stopped disposable parent was then removed,
including provider copies, test grants/users and intentionally disposable source fixtures. This final
fixture teardown is separate from the verified source-preserving sandbox Finish behavior.

The three approved main application recreations restored Shell, Workspaces and Marketplace to running
with Memory=0 and MemorySwap=0. Original autostart states were preserved. Main Core and its provider
connections were not replaced. Temporary API credential files and browser tabs were removed.

Documentation index validation, version consistency and diff checks passed. Only implementation,
regression tests and Markdown reports/plans belong in the feature change. Raw JSON, logs and temporary
scripts were kept outside the repository and removed with the stand. No feature commit or PR was created.

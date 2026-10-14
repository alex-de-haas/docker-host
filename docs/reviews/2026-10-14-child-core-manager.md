# Child Core Manager Acceptance — 2026-10-14

Baseline: `608739739dbf31a7476c9150a4ce1cdf30c2bb0f` plus the uncommitted sandbox feature in the
registered development worktree. Final Core source SHA-256: `fbcc6e88877202a4c2b98bf68f91ef1171143ef135c5de0447814428bf76bf87` (sorted repository-relative
`.cs`/`.csproj` paths under `apps/core/src`, NUL-separated paths/contents, excluding bin/obj).
No commits or pull requests were created. The operator's primary Core was not restarted.

## Outcome

D18, D19 and D21 pass on the selected macOS/Docker Desktop host. The parent now manages dedicated
Core processes sharing Docker, with separate data, users, ports and origins. The previous
[same-host experiment](2026-10-14-same-host-core-experiment.md) remains an immutable baseline;
its missing-manager, automatic Shell bootstrap, local-image adoption and Demo health findings are
resolved here. Explicitly installing a fixed-port app still uses its ordinary port-review contract.

[Evidence](../features/app-sandbox-runtimes/2026-10-14-child-core-manager-evidence.json),
[Harness inventory](../features/app-sandbox-runtimes/2026-10-14-child-core-harness.png),
[authenticated Demo preview](../features/app-sandbox-runtimes/2026-10-14-child-core-preview.png).

## Runtime Verification

- The real Core-managed Harness HTTP/session/client stack creates, lists, starts, stops, restarts,
  configures and finishes children. Its fake agent adapter avoids a model turn: this is actual
  service/UI integration, not evidence of a new LLM-driven tool-selection run.
- New permissions initially deny access. Normal Core browser permission review grants
  `core.environments.read/manage`; a clear 403 is preserved through Harness. Each child uses normal
  bootstrap and password login with a separate synthetic administrator. No parent users, keys or
  provider credentials are copied. The child JSON API preserves normal install confirmation; the
  operator-authorized CLI installs the test manifests, and Harness starts/inspects the apps.
- Two children concurrently run the same Demo App ID, each with backend/frontend containers,
  unique full instance labels, own data mounts and local origins. All four containers become healthy.
  A normal browser login opens Demo as the child's administrator and shows its own data/log directory.
- Current prepared builds start in 0.82/0.72 seconds. A source build plus start takes 9.4 seconds;
  the native release starts in 1.05 seconds. These are single local observations, not percentiles.
  A real Harness worktree binds to the source environment and retains a persistent consumer.
  The source Core runs Demo through the same API. A native child creates and starts a further child
  using its ordinary Core API, invoked through Harness.
- `keep-apps` parent replacement preserves child PID/start identities and all app container IDs.
  Parent SIGKILL leaves children running; replacement reconciles them. Normal parent stop stops
  children/apps while preserving users/data, and Harness starts them again. The test driver's own
  unreaped parent process caused a CLI wait timeout after successful normal stop; direct process,
  root and Docker checks confirmed shutdown. The driver was corrected to account for exited zombies.
- A source child stopped with keep-apps adopts unchanged local-image Demo container IDs on restart.
  Local image IDs remain distinct from registry digests; missing local IDs are not pulled as tags.
- Finish with corrupted live child control discovery falls back to the saved process identity,
  removes its containers, labeled network/cache volume and data, and preserves its sibling and a
  borrowed folder. Exact request replay does not repeat side effects.
- A real owned cache volume held by a separate test container makes Finish report `cleanup-failed`.
  The root and source consumer remain; exact replay stays failed. After removing the holder, reading
  the reconciled revision and issuing a fresh request finishes cleanup. The worktree remains and its
  consumer is released. A deliberately killed child with corrupted discovery and a live descendant
  is fully removed, including the descendant process/root. Final inventory observes a child exit
  without requiring a preceding status request.

After acceptance, all four direct children and the nested child are finished. The unchanged test
worktree is separately released through Harness only after proving Finish preserved it. The owned
acceptance parent is stopped, and its containers, networks, volumes, root and private test credentials
are removed. The feature worktree and sanitized evidence remain; shared build images are retained.

## Memory Observation

| Idle, healthy Demo sample | Child A | Child B |
| --- | ---: | ---: |
| Core RSS | 126.92 MiB | 126.41 MiB |
| Demo frontend | 42.26 MiB | 43.50 MiB |
| Demo backend | 43.14 MiB | 43.66 MiB |

Host RSS and Docker stats have different accounting. This single idle sample excludes the agent,
browser, source-build peak and Docker VM overhead. The earlier experiment contains a separate load
sample; these values do not replace it or establish a production resource budget.

## Automated Checks

Commands run from the feature worktree unless stated otherwise:

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path /private/tmp/hosty-child-manager-final-build --nologo`: pass, four existing warnings.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path build/child-manager-tests`: 3218 pass, four existing opt-in integration skips, before the final inventory-only fix.
- Same test command with `--filter 'FullyQualifiedName~CoreEnvironment|FullyQualifiedName~DockerRuntimeAdapterTests|FullyQualifiedName~EndpointAuthorizationHttpTests'`: final affected suite 131 pass, including the new exited-child inventory regression.
- `dotnet publish apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj -c Release -r osx-arm64 --artifacts-path /private/tmp/hosty-child-aot-final -o /private/tmp/hosty-child-aot-final-publish --nologo`: pass.
- `npm test --workspace @hosty-sdk/app`: 655 pass; `npm run build --workspace @hosty-sdk/app`: pass.
- `npm test --workspace @haas/hosty-harness`: 540 pass before the last pending-capacity change;
  final development manager/MCP subset: 15 pass, including Finish at the pending-operation ceiling.
- `npm run lint --workspace @haas/hosty-harness` and `npm run build` in `apps/harness/web`: pass.
- `npm test` in `apps/demo-app`: six pass. Demo Docker artifact build: pass.
- Version consistency, documentation validation and `git diff --check`: pass.

The first full Core run used output outside the repository and failed fixture discovery in existing
manifest tests; it was stopped and replaced by the passing repository-local isolated-output run.
Unchanged Shell/Workspaces tests were not repeated; their previous acceptance is recorded in the
feature. Windows/Linux process launch, remote preview, a new model turn and broader shared-mount/
network-policy/resource-accounting acceptance are not claimed. The latter feature work remains in
unchecked plan deliverables; this report does not narrow them.

# Sandbox UI Acceptance — 2026-10-14

Baseline: `608739739dbf31a7476c9150a4ce1cdf30c2bb0f` plus the sandbox feature working tree.
This report records the local acceptance of D24 in
[the sandbox plan](../features/app-sandbox-runtimes/plan.md). It does not close the remaining
feature-wide resource, policy and remote-preview deliverables.

## Verified Journey

A separate parent Core on port 37361 runs the built Shell and Workspaces as Core-managed local
apps. Normal bootstrap/password login creates a test operator. Both apps receive their optional
sandbox permissions through Core's ordinary installation-permission review. Harness's fake adapter
prepares a real session/worktree through the production workspace API; this run tests UI integration,
not model behavior. The earlier real-agent reports retain their separate evidence.

In Chromium, the operator opens Workspaces inside Shell and creates **UI Demo sandbox** from its
active worktree. The panel starts the current Core build in a new root and offers normal child-account
setup. The operator creates a separate test administrator through that form. Demo App 0.17.0 is
installed with the `sandbox-artifact` profile using the existing child API and browser installation
review, then started in Docker. The panel observes `running` / `healthy`. Open preview uses Core's
installation-bound launch endpoint, normal child login and the app SDK. The page displays Demo App,
and `/api/auth/identity` returns HTTP 200 with the child's test email, not the parent operator.

The same embedded panel creates **UI Source Core sandbox**, selecting its registered worktree and
relative Core project. The `building` state is visible while the source build remains in progress.
The child reaches `running`. Shell's dashboard shows both child environments and links to the owning
workspace; Demo retains its observed health and preview destination. No JavaScript page errors are
reported in the successful acceptance.

The operator cancels a deletion once and confirms that the environment remains. Workspaces then
permanently deletes the source Core. Shell stops and starts the current-build Core, then permanently
deletes it. Both rows disappear only after Finish succeeds. Independent parent API, filesystem,
TCP and Docker-label checks establish:

- Both records are `finished`, both child roots are absent, and both listener ports are closed.
- No container, network or volume remains with either child's `hosty.instance` label.
- The registered source worktree and its Core/Demo source files remain present.
- Both persistent sandbox consumers are released; source cleanup is not part of Finish.

The isolated parent, its test apps/worktree, browser and temporary authentication material are cleaned
up separately after exporting these observations. The implementation worktree remains available.

## Findings Repaired

- A bare `/api/apps/{id}/open` link lacks a required destination. Preview now uses the existing
  installation-bound `installationId`, `endpoint` and `route` contract instead of inventing an auth
  handoff. Headless apps have no preview link; child settings/credentials are not projected.
- Long builds held the lifecycle gate and delayed inventory. Nonblocking observations expose the
  persisted in-progress state while preserving the same ownership checks.
- The older sandbox HTTP test fixture assumed the first lifecycle response was terminal. Under
  full-suite load it sometimes received the documented accepted operation. It now waits for its
  original journal entry to finish before using preview/authentication.
- UI polls do not overlap; superseded reads cannot replace newer observations. Uncertain mutations
  retain the exact replay identity across reload. Password setup is excluded from replay storage.

During fixture reload, CLI source restart without its explicit port tried the occupied default 7070
and did not become ready. The failure was detected through process/readiness checks. The tested
source binary was relaunched on the fixture's explicit port 37361, with a new verified process identity.
The primary Core was not restarted. This fixture launch detail is not evidence of a port-preserving
CLI restart contract.

## Verification

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path .artifacts/sandbox-ui-final`: passed.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path .artifacts/sandbox-ui-final --no-build`: **3228 passed, 4 skipped**.
  The skipped tests are the opt-in Telemetry, Docker development and two Torrent/VPN runtime checks;
  this run instead uses the explicit local UI/Docker fixture above.
- Focused Core environment/workspace/sandbox HTTP suite: **34 passed**.
- NativeAOT `dotnet publish ... -c Release -r osx-arm64`: passed, four existing compiler warnings.
- SDK `npm test -w @hosty-sdk/app`: **661 passed**; SDK build passed.
- Workspaces tests: **15 passed**; lint and production build passed.
- Shell node tests and component tests: passed (**254 component tests**); production build passed.
  ESLint reports two existing warnings in shell-client/sidebar, no errors.
- Shared panel tests cover confirmed deletion, uncertain replay across remount, create/start ordering,
  unavailable status/unsafe preview schemes and credential-free replay storage. Server route and
  Core HTTP tests cover administrator/grant checks, revocation, cross-origin requests, bounded proxy
  paths and denial of generic child transport. Workspace tests cover source selection/ownership.

## Evidence And Limits

[Structured evidence](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-evidence.json),
[Shell](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-shell.png),
[embedded Workspaces](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-workspaces.png),
[source build](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-building.png),
[Demo preview](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-preview.png), and
[finished inventory](../features/app-sandbox-runtimes/2026-10-14-sandbox-ui-deleted.png).

Creation starts an empty child Core; it does not automatically install attached applications.
Dependency/mount policy, global nested resource accounting and remote preview remain open in the
feature plan. This is the approved trusted shared-Docker Core model, not hostile-code containment.

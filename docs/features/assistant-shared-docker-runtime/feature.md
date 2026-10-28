---
created: 2026-10-15
updated: 2026-10-28
summary: Harness runs declared API and Worker services over authenticated HTTP and SSE, with shared Core-owned source access and native model and reasoning-effort selection.
components: [apps/harness, apps/core, apps/shell]
---

# Shared Docker Agent Runtime

## Ordinary Application Services

Harness declares `api` and `worker` in Docker, Local and development profiles. Core owns their
ordinary installation, dependency order, health, logs, resources, Stop and removal. Docker remains
the default production profile; Local retains native execution and concurrent conversations.
The API depends on Worker health, then establishes an authenticated application handshake.
Core has no agent execution endpoint, worker controller, provider process proxy or hidden container.
Retired `agentWorker` manifests fail validation explicitly.

The API image contains the web export and conversation/MCP coordinator. The Worker image contains
the provider SDKs, Codex CLI 0.162.1, Claude SDK 0.3.296 and its packaged Claude CLI, Node 24, Git
2.56.0, Python, ripgrep and .NET SDK 10. Images and Harness packages share version 0.65.2. Worker
does not need host agent CLIs, a Docker socket or another Docker daemon. `tini` supplies ordinary
container signal/reaping behavior; the application starts known child processes directly.

Docker admits one execution at a time, including translation and waiting for input. Local admits
up to 32, subject to provider connection claims. Worker refusal is an explicit error. Normal and
Autonomous modes retain their approval meanings. The manifest declares no memory, CPU or PID
limits for either service. Ordinary Docker launches add no app-authored resource limits.
Child Core admission supplies its existing Core-owned service budgets without a second agent
reservation or credit. An adopted running container retains its existing Docker configuration
until the operator recreates it through ordinary lifecycle.

## Direct HTTP And SSE

`src/worker/contracts.ts` defines protocol version 2. The endpoint client depends on a URL,
installation identity and credential; its run engine does not depend on Core or container names.
Hosty connection/resource composition is confined to the provider service. The independently
listening test fixture exercises the same client with its own journal and no Core connection.

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | Public process liveness, including before service-secret bootstrap |
| `GET /v1/capabilities` | Authenticated provider, resource, concurrency and readiness capabilities |
| `PUT /v1/coordinator` | Authenticate the coordinator callback before enabling provider secrets |
| `POST /v1/connections/operations/:operation` | Whitelisted private connection operations |
| `GET /v1/connections/:connectionId/models` | Connection-scoped native model/effort catalog |
| `PUT /v1/runs/:id` | Persist acceptance before executing; identical retries return the same run |
| `GET /v1/runs/:id` | Durable state, revision, pending input and bounded final snapshot |
| `GET /v1/runs/:id/events` | SSE run events with stable run/generation/sequence and cursor replay |
| `POST /v1/runs/:id/responses` | Correlated approval/question decision with control ID and revision |
| `POST /v1/runs/:id/cancel` | Idempotent cancellation of known execution |
| `POST /v1/runs/:id/disable-suggestions` | Suppress optional prediction without cancelling the primary answer |
| `POST /v1/runs/:id/configuration` | Replace declared MCP callbacks and current auto-approval prefixes |
| `PUT /v1/conversations/:id/attachments/:name` | Bounded, content-idempotent attachment upload |

API and Worker share a random 256-bit installation credential through the small `service-auth`
directory. API creates it atomically; Worker receives a read-only mount. Requests use bearer and
installation headers with constant-time comparison. Core neither creates nor validates this
credential. Browser/user permission checks remain in Harness. The private callback handles only
connection-secret operations; scoped MCP callbacks retain their existing separate authorization.

Each run has an atomic, fsynced journal record. Acceptance hashes and compact tombstones survive
event expiry; a repeated ID with different input is a conflict. Control intent is durable before
native delivery; an uncertain delivery is not blindly repeated. SSE disconnects do not cancel or
resubmit tasks. API restart reconnects to the stored run, restores pending input and deduplicates
persisted transcript events. Callback keys are reproducible for that installation/run, while user
credentials must be refreshed through normal Hosty authentication.

Worker restart marks unfinished runs interrupted without replaying their side effects. A fresh
Docker service process can confirm the previous container execution boundary ended. Local recovery
does not assume that an old native child exited. Source leases and occupied claims remain when
termination cannot be confirmed. Cancellation during startup waits for the terminal receipt within a bounded deadline; timeout
retains the specific source lease. Ordinary cancellation waits for the known CLI and its process
group; no UID-wide process scan or per-turn container restart is involved.

Opted-in interactive chat runs separate successful answer completion from confirmed native exit.
The optional `suggesting` phase collects one native next-message suggestion for at most five
seconds. Foreground submissions preempt this phase before admission, and cancellation preserves
the successful answer. Connection claims and capacity remain held until native exit is confirmed.
Task and translation runs cannot opt in. See [Contextual prompt suggestions](../assistant-prompt-suggestions/feature.md).

Commands are limited to 1 MiB, attachments to 20 MiB, individual events/final text to 1 MiB and
retained run events to 64 MiB. Detailed replay expires after seven days; pruning retains the
acceptance tombstone and final snapshot. Expired replay reports explicit snapshot resynchronization.
Excessive output fails explicitly. Provider credentials and MCP configuration are not journaled.

## Source, Storage And Trust

Core's generic `managed-workspaces` mount exposes its development `trees` read/write and
`repositories` read-only under `/mnt/development/managed`. It requires reviewed full-source
authority. It does not expose Core's registry/settings or other app data. The manifest declares access;
Core supplies the instance-specific paths without user mount configuration. Automatic roots are not
operator active-path reservations and do not block workspace source selection. The collection is
mounted once; creating/deleting eligible child worktrees requires no Harness or Worker restart. Normal
specific-worktree leases, direct mounts, sandboxes and external consumers still prevent unsafe
cleanup. Collection exposure itself is not a lease on every child.

Core owns workspace records, owner bindings, files, branches and leases. Installing or resetting
Harness does not migrate, import, rebind, relocate or delete them. Existing external agents keep
their Core workspace identities. Fresh managed repositories use relative worktree metadata when
host Git supports it (2.48+); existing repositories and pointers remain unchanged. The mounted
layout preserves relative paths between trees and repositories. Existing absolute host pointers
are not rewritten to make them container-compatible. Core APIs remain responsible for Git mutations
and publication against read-only common metadata.

Run requests carry resource IDs, not arbitrary container paths. Worker resolves a worktree only
inside its mounted collection, and conversation/attachment data only inside its cache. The
coordinator projects recognized workspace descriptors into the execution namespace. This shared
administrator runtime deliberately permits access to other exposed worktrees; it is not
per-session or hostile-code isolation.

Generic service injection excludes Core service/identity tokens and settings from Worker. Its
trusted backend owns protected control directories; each Docker execution receives a temporary
profile containing only the selected account authorization and native history, and runs under an
unprivileged UID. Known children are stopped before history/authorization are copied back. The
backend does not copy executable configuration or symlinked history from an agent profile.
Windows bind-mode reporting is not the control-directory protection mechanism: execution profiles
and protected parent directories reside in the Linux container layer. Local processes retain the
host user's normal access and are not a permission boundary.

## Models And Reasoning Effort

The chat composer exposes Agent default, native model choices, Default effort and only the
selected model's reported effort levels. Unknown support exposes no invented levels. Catalogs
are bounded and cached by connection identity/revision; the UI loads on entry rather than polling.

Selections are stored together with a revision, and copied into each accepted turn. Omitted update
fields preserve their value; explicit null resets native Default. Busy/stopping conversations,
stale revisions and incompatible model/effort pairs are rejected. Changing the model resets an
incompatible effort visibly to Default. Requested values and native-reported effective values are
distinct transcript events; unreported values stay unknown.

Codex supplies model/effort to native thread/turn operations and resolves native defaults before
resuming a previously explicit selection. Claude applies SDK `applyFlagSettings` before the next
prompt, including null resets. Both retain the native session ID and refuse a mismatched resume.
An idle native process may be replaced; neither service restarts. Provider/account switching and
cross-provider history remain outside this selection feature.

Confirmed terminal results use the same awaited coordinator persistence callback as other durable
events, keyed by run ID and terminal receipt revision. This identity survives replay expiry. Snapshot resynchronization notices have no durable run
sequence, leaving the receipt revision exclusively for terminal delivery.
Temporary write failures retry without repeating execution or duplicating transcript entries;
the run receipt stays recoverable until terminal status and cleanup are saved. New turns and model
changes stay blocked while that receipt remains. During optional prediction, a new turn or model
change first ends collection and awaits that same terminal persistence and cleanup. Coordinator shutdown
detaches retrying observers. Failed provider runs retain their original error message.

## Clean Update And Compatibility

Stop the old Harness through the old Core while its legacy cleanup is available; verify its owned
execution stopped before installing the compatible Core/Harness artifacts. Use normal application
install/update and reviewed permissions. Fresh Harness state and provider login are supported;
there is no old conversation/history importer. Leaving old Harness files unused is sufficient when
deletion is unnecessary. Never include Core workspaces or external agent leases in a Harness reset.
New Core rejects retired manifests as install/update candidates and refuses their start/restart.
It can still read an already-installed retired baseline for inspection, stop, remove and updating
to ordinary services, so upgrading Core first does not strand the installed app. This compatibility
read does not restore the legacy worker executor or manage undeclared legacy containers.
Older Core rejects the new unsupported mount kind.

The architecture uses normal Docker connections, including Windows named pipes, with a Linux
engine. Docker Desktop path comparison covers drive letters, mapped drive roots, spaces and Unicode;
individual mount overlap remains authoritative. Native Windows/Desktop acceptance and remaining
live provider scenarios are tracked in the [implementation plan](plan.md); simulated paths and
Linux containers on macOS do not constitute that evidence. UNC/network source roots and remote
Docker source sharing are outside the first supported matrix.

Independent provider extraction remains in the [Agent Provider plan](../agent-provider-interface/plan.md).
This private HTTP/SSE seam does not create `providers.agent`, file synchronization, a public protocol
or cross-app grants. [Containment](../assistant-runtime-containment/plan.md) retains stricter isolation.

## Testing Expectations

- Run Harness tests/lint and web build; cover authenticated HTTP, retries, replay/expiry, controls,
  cancellation, API/Worker restart, model revisions/default resets and UI busy/error behavior.
- Run Core tests/build/AOT and Shell tests/lint/build for generic manifest/storage/mount changes.
  Exercise a non-agent two-service fixture, tokenless adoption and specific-worktree cleanup.
- Build both images for amd64 and arm64. `node --import tsx scripts/check-harness-worker.mjs`
  runs a disposable credential-free image probe for UID/profile boundaries, known child exit and Git.
- Run `Harness_ProductionDockerRunsDeclaredServicesAndFinishesSandbox` with
  `HOSTY_TEST_DOCKER_DEVELOPMENT=1` for real child Core setup/login, declared lifecycle, Docker/Local
  selection and Finish cleanup. Keep fixture data and provider credentials separate from live apps.
- Verify native Windows Core with Docker Desktop Linux, macOS Desktop and Linux Engine, including
  both provider turn/resume/tool flows and existing external-workspace preservation. Record absent
  platform/provider evidence explicitly; do not mark its plan deliverable complete.

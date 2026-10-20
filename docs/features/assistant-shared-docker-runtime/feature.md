---
created: 2026-10-15
updated: 2026-10-20
summary: Harness runs Codex and Claude in one bounded shared Docker worker while Core owns workspaces, credentials, Git operations and separate application sandboxes.
components: [apps/harness, apps/core, apps/demo-app]
---

# Shared Docker Agent Runtime

## Execution Contract

Harness declares two ordinary production application profiles: `docker` and `local`. Docker is the
manifest default; Local runs the coordinator and agents as host processes. Core owns installation,
runtime selection, start, stop, restart and update. An explicit stored selection takes precedence
over the manifest default. The separate `dev` profile remains a development profile.

The selected production profile determines execution for new and existing conversations. Settings
shows the profile and worker readiness/recovery instead of a per-conversation runtime choice.
Legacy conversation fields are reconciled without changing provider session IDs or transcript data;
outstanding execution leases require recovery before changing a retained conversation's mode.
Legacy settings cannot override a production profile.

The Docker coordinator is an application container. Core's coordinator-only worker API controls
the shared agent container; the coordinator has no Docker socket. Creation requires an installed
assistant with reviewed source authority and an active lease for that installation. Core derives
the image, names, labels, network and allowed source/storage mounts. Agent stdin/stdout/stderr uses
a bounded streaming transport from the trusted coordinator through Core to `docker exec`. Provider
credentials are passed only in the allowed exec environment, never process arguments.

One Docker workload occupies the worker across both Codex and Claude. A second turn is refused
before its user message is recorded. Waiting for approval or an answer still occupies the worker.
The existing Normal/Autonomous choice and Core tool policy retain their meaning. Codex app-server
stdio and Claude Agent SDK custom spawning run through `docker exec` under Core ownership. A completed turn stops and removes the generation, including detached commands. A later
turn starts another generation and resumes its durable provider conversation.

Applications and their browsers run separately. Agent Stop does not Finish a child Core or its apps.
The [sandbox environment API](../app-sandbox-runtimes/feature.md) retains its own consent, accounts,
installation review, quotas and cleanup. The worker has outbound internet for inference and build
packages; it is not network confinement or a malware-analysis environment.

## Image And Filesystem

Harness pins `ghcr.io/alex-de-haas/hosty-harness:0.62.0` and
`ghcr.io/alex-de-haas/hosty-agent-worker:0.62.0`. Core prepares the worker image before starting the
Docker coordinator; each generation uses an immutable local image ID. The worker package pins
Codex 0.162.1 and Claude Agent SDK 0.3.296, matching the coordinator. The image includes Node, Git, Python, ripgrep and .NET SDK 10. The runtime image
workflow builds both images for arm64/amd64, builds the settings export before running Harness checks, and uses
the repository publication guard and provenance flow. Prepare worker image retries the declared release preparation.

Core supplies canonical source roots through an authenticated internal binding descriptor. The
worker mounts all registered Core worktrees read/write and common Git metadata read-only at the
same absolute paths, including trees prepared while it runs. Exact verified tree paths enter Git
`safe.directory`; Git optional index writes are disabled. Status, diff and log work locally. Core's
existing workspace APIs perform Git mutations and authenticated publication.

This is an **administrator-wide shared-source boundary**, not separation between workspaces or
administrators. It exposes other worktrees and repository metadata in the same Core data root.
Other mounts are limited to the selected provider home/history, this session's workspace and staged
attachments, disposable worker home and reusable worker caches. The host home, Docker socket,
coordinator data, Core service token and unrelated app data are not mounted. Canonical root redirects
are refused. The worker root filesystem is read-only; it runs with the Core host's numeric UID/GID,
dropped capabilities and no-new-privileges.

Demo's development image explicitly sets readable modes on copied dependency metadata and scripts.
Core checkout files can have owner-only permissions; these permissions remain intact on the host.
The image build does not rely on the source checkout having a permissive umask.

## Provider Authorization And MCP

[Provider connections](../ai-gateway-providers/feature.md) remain authoritative. Docker homes are
separate from native homes, under `cache/agent-docker-providers/<connection>/<revision>`. Only the
selected connection's durable conversation directories are mounted. Docker-written configuration
is not used by native provider probes. API keys and Claude tokens come from Core's app-secret store;
container transport does not inherit unrelated host credentials.

In Local, a selected Codex host login's **Prepare for Docker** action imports only portable
authorization fields into the managed Docker home and Core secret namespace. Docker consumes that
explicit import without reading the host login directory. A missing import reports a connection
setup error; it does not replace the stored connection or its conversation history. It does not copy host config, hooks, MCP definitions or unrelated history.
An account identity change requires a new binding. An absent previously imported Core secret requires
reconnection, rather than resurrecting it from worker cache. Unsupported/keychain-only credentials
require ordinary Harness login. Native and Docker refresh synchronization compares remembered values
and refresh timestamps so an unchanged stale home does not overwrite newer Core authorization.

A dedicated bridge exposes only registered session workspace and app-MCP routes. The production
worker shares its coordinator's container network namespace and reaches the bridge through loopback.
The existing native development coordinator uses `host.docker.internal`. Each route requires the current session bearer; native loopback handlers and
call-time Core authorization remain in force. The bridge preserves MCP session/protocol headers
and the last-event cursor for SSE resumption. It is not a generic host HTTP proxy and forwards
no browser cookies or Core service credentials, bounds request bodies and removes session routes
when execution stops. The listener is container-reachable; possession of its route bearer grants
only the corresponding existing session MCP authority.

Core mounts the coordinator's own data and cache at their canonical host paths. Both production
profiles use those paths, so provider history links and session workspaces keep their identity.
Managed native and Docker provider homes remain separate; their durable conversation directories
point to the same app data. Translation uses managed or explicitly imported credentials in the
selected profile and persists renewed imported authorization to Core. The coordinator image includes
system CA certificates for native provider HTTPS. Translation sets `HOME` to its disposable profile,
including when the coordinator runs as a numeric host UID absent from the container's passwd database.

## Ownership, Recovery And Resource Accounting

A generation is identified by canonical Core-root hash, Harness installation hash and UUID. The
coordinator persists intent before acquiring a Core shared-source consumer lease and creating Docker
resources. Container name and ownership labels must all match. A label alone never authorizes removal.
Core persists active leases and release tombstones; a delayed acquire cannot revive a stopped UUID.
Every active shared-worker lease blocks cleanup of any shared tree, including trees created later.
Cleanup and lease acquisition share Core's binding lock.

Stop confirms termination and removal through successful Docker inventory. Daemon failure is not
interpreted as absence. Unknown termination preserves ownership and leases, blocks another workload
and exposes recovery. Both the shared worker lease and individual worktree leases must be released before scratch/state
deletion and admission release. A failure before generation creation releases admission directly,
without attempting unrelated worktree cleanup. Restart reconciles the same generation, does not replay uncertain model turns, and requires
the owning administrator's fresh Core credential to release retained leases. Provider changes and
transcript retention protect a persisted unreconciled worker. Abandonment stops Docker before
releasing its provider or pending approvals.

| Resource | Default policy outside a child Core |
| --- | --- |
| Memory / swap ceiling | 4 GiB / equal 4 GiB ceiling |
| CPU / PIDs | 2 CPUs / 512 PIDs |
| Writable temporary memory | 512 MiB tmpfs |
| Container logs | Two 5 MiB files |
| Soft disk | 20 GiB across source trees, selected history, session files, worker home/cache |
| Observation | cgroup current/peak memory and PIDs every five seconds; disk approximately every thirty seconds |

Inside a Core-managed child environment, worker creation reserves an additional application share
through the normal environment admission lock. Its coordinator remains counted separately. The
worker uses that environment's memory, CPU, PID and log limits and carries the instance/app/service
labels used by resource observation and Finish. Insufficient capacity rejects creation before Docker
allocates the worker. Core admission and lifecycle diagnostics remain typed runtime errors in
Harness, so the caller receives the resource or Docker failure reason. A disconnected Core reports
worker API unavailability with a retry instruction.

Core's application Stop removes verified worker containers after stopping the coordinator, including
detached processes the coordinator no longer tracks. Leases remain until the owning conversation
reconciles termination; a failed Docker inventory never counts as successful removal.

A soft-disk excess stops execution and preserves source. Sampling permits overshoot and is not a
hard filesystem quota. Cgroup peaks persist on the conversation across worker generations; they
are not simultaneous totals with app lifetime peaks. Sandbox admission credits only the verified
worker reservation matched to an active Core-owned lease and exact container identity, avoiding
counting its reserved agent memory twice. Native Harness, Core, browsers and Docker VM overhead
remain distinct from the worker ceiling.

## Verification Boundary

The acceptance host is macOS arm64 with Docker Desktop Linux containers. Native Linux and Windows
host acceptance is not established. The original
[acceptance report](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) covers real Codex and
Claude journeys with a native coordinator and shared Docker worker; it does not establish
production Docker-coordinator acceptance.

`scripts/check-harness-worker.mjs` checks both provider binaries, actual Claude SDK initialization,
read-only metadata, absence of a Docker socket, resource accounting and detached-writer removal
after persisted-state recovery without model credentials. The opt-in Core test
`Harness_ProductionDockerRunsCoreOwnedWorkerAndFinishesSandbox` uses a Core-managed child environment,
ordinary setup/password login and installation, then runs both provider binaries through the
Docker coordinator's Core transport. Its worker lease is an explicitly synthetic test fixture;
it does not claim a model turn or workspace-user authorization check.

Real-provider acceptance on this host also passes Codex and Claude chat/translation through
Docker -> Local -> Docker, retaining provider session IDs and conversation content. Both profiles
prepare a registered workspace, use scoped development MCP, edit a temporary file, inspect a Git
diff and build Core. Browser acceptance uses normal password login and Shell embedding. A Demo-only
activation and Return run inside the child Core. Full Core verification passes 3,807 tests (five opt-in integration tests
skipped in that run); Harness passes 894 tests across 98 files and lint. The Core build has four existing warnings and zero errors. Both profiles' app MCP routes are also exercised
against an independently running Demo App. The separately enabled production integration test
passes and Finish removes the child Core data and resources, confirmed by independent inventory.

Both production profiles also pass Demo App sandbox preparation from a registered worktree, separate
sandbox-user provisioning, preview resolution, private-browser page assertions and screenshot, and
fresh evidence export. Startup takes 44.8 seconds in Docker and 41.7 seconds in Local. Sandbox restart,
stop and dispose succeed, followed by independent resource-removal checks. These checks temporarily
stop the unbounded Workspaces app with explicit owner permission and restore it healthy through Core.

The production failure matrix passes 20/20 checks using real Codex turns, ordinary Core/Harness
identity and Docker -> Local -> Docker switching. The same provider session and remembered content
survive the sequence. The final full run completes in 6 minutes 29 seconds, including exact resource
and Stop error diagnostics. Its Docker transport fixture also exercises both provider binaries and the
real Claude SDK; the failure-turn assertions use Codex.

| Failure or recovery path | Observed result |
| --- | --- |
| Provider absent/unconfigured; source app unattached | Specific setup/authority errors; refused messages do not enter the transcript. |
| Worker image unavailable, pull failure, Docker connection loss before dispatch | Runtime diagnostics report unavailability; no worker generation is admitted. |
| Child container budget exhausted | Worker allocation is refused, preparation cleanup is verified and its lease is released. |
| Shared Docker worker busy; explicit cancellation | A second conversation is refused before transcript persistence; Stop removes the worker and both foreground/detached writers stop. |
| Connection lost during Stop, removal refused, removal reply lost after actual deletion | The generation and source lease remain until explicit recovery verifies absence, then the lease is released. |
| Local CLI missing; Docker connection unavailable | Local diagnoses its missing provider executable and continues real provider work independently of Docker. |
| Local active conversation and cancellation | Same-chat overlap is refused; another chat can run concurrently. Unproven native descendant termination retains source activity. |
| Active Docker or Local coordinator killed, followed by explicit restart | No uncertain message is replayed. Durable history and provider identity survive; retained execution is reconciled. |
| Core Docker start with unavailable engine/worker image/coordinator image | Start reports failure for the selected profile; explicit retry after repair starts that profile successfully. |
| Owner Finish and recovery of an interrupted Finish | Child data, containers, networks, volumes and native processes are independently absent after completion. |

`scripts/experiments/harness-production/run.mjs` runs this opt-in acceptance against a disposable
Core. It forwards Docker traffic through a private Unix socket used only by that test. The proxy
injects connection loss, image/pull errors and removal failures into real Core/coordinator calls;
its three tests cover streaming response headers, fault scope/recovery and response loss after an
upstream deletion. The shared Docker engine process stays running and existing host images remain
present. This establishes production transport-failure recovery; it does not claim a physical Docker
Desktop restart or a registry pull. Container kills, resource exhaustion and native process kills
are real and target only the test environment.

Build the Core test project with `--artifacts-path artifacts/harness-runtime-final`, then run:

```sh
node --test scripts/experiments/harness-production/docker-fault-proxy.test.mjs
HOSTY_TEST_DOCKER_DEVELOPMENT=1 \
HOSTY_TEST_HARNESS_PROVIDER_SOURCE=/absolute/authorized-core-root \
HOSTY_TEST_HARNESS_PROVIDER_CONNECTION=explicit-managed-codex-connection-id \
HOSTY_TEST_HARNESS_FAILURE_REPORT=/absolute/outside-repository/failures.json \
node scripts/experiments/harness-production/run.mjs
```

The source authorization requires explicit owner permission. The test imports only that selected
managed Codex login, returns renewed authorization only when its source is unchanged, and stores raw
evidence outside the repository. The normal fixture calls Finish on success or failure. If Finish
itself fails, keep its root and run the same opt-in test with `HOSTY_TEST_HARNESS_RECOVERY_ROOT` set to
that root and the working Docker endpoint. Recovery validates the fixture identity, replays the
journaled Finish request through its owner and deletes parent test data only after verified Finish.

Post-merge release verification on 2026-10-20 confirms publication of both 0.62.0 runtime images
from [source implementation PR #629](https://github.com/alex-de-haas/docker-host/pull/629), merged at
`0ff7485883b19732e9d93c6779df3efb95579683`. The
[runtime image publication run](https://github.com/alex-de-haas/docker-host/actions/runs/39449768950)
succeeds for both images. Independent anonymous registry checks verify the image indexes, platform
manifests and configs for `linux/amd64` and `linux/arm64`; every OCI revision label equals that merge
SHA. Actual anonymous pulls of all four platform images pass. The immutable image index digests are:

| Image | Version | Index digest |
| --- | --- | --- |
| `ghcr.io/alex-de-haas/hosty-agent-worker` | `0.62.0` | `sha256:9c471ef210599f0f5a24b85d5b3221ad988d7a7f21ba602900d1e9e636601a0a` |
| `ghcr.io/alex-de-haas/hosty-harness` | `0.62.0` | `sha256:b4a0dc4cb00812ccb0f18bb024de9e4d7ad04ecc44d71aab4418bf201f3ddaf3` |

Signed provenance verification with `gh attestation verify` passes for both immutable index digests
using downloaded signed bundles and the repository-specific `publication-provenance-v1` predicate.
The verified signature certificates identify
`.github/workflows/harness-worker-image.yml@refs/heads/main`, source commit
`0ff7485883b19732e9d93c6779df3efb95579683` and the successful
[main CI run 39448520481](https://github.com/alex-de-haas/docker-host/actions/runs/39448520481).

The release coordinator runs in the isolated Core. The [remaining acceptance plan](plan.md) retains
D12/D14/D15 until final Git/PR acceptance and documentation closure are verified. D10 passes
publication, anonymous platform pulls, coordinator/worker image identity and signed provenance
verification alongside the topology/lifecycle checks. Docker Core publication succeeds with its PR
URL and head independently checked. Local Git/PR publication is under verification through the
same draft PR; final acceptance and documentation closure remain pending. The registry and signed
provenance evidence establishes image delivery, without establishing those remaining checks.
The primary Core/Harness runtime selection and lifecycle are unchanged by test fixtures. Provider
authorizations are used only with explicit owner permission. Core 0.146.0 supplies the required
worker API and canonical storage placement for Harness 0.62.0.

Core passes agent environment values through an owner-only temporary Docker env file. The host
Docker CLI retains Core's environment and context; provider secrets stay out of its arguments. The
file is removed when execution ends, including transport startup failure. Environment values with
line breaks or NUL are rejected before the file is created.

## Testing Expectations

- Assert global busy admission before transcript persistence, including approval/question waits.
- Exercise Codex and Claude transport, provider revision/refresh/revocation, imported account binding,
  and preservation of native execution and durable conversation resume.
- Verify canonical mounts (including paths containing `=`), newly prepared worktrees, exact Git trust paths, Core-mediated mutations,
  scoped MCP authority and route revocation without broadening host access.
- Retain ownership/provider/source leases on unknown Stop; recover the same generation after restart.
  Cover abandoned sessions, retention, cancelled turns and detached processes with real Docker.
- Verify resource observations, soft-disk behavior and active-lease-backed reservation credit.
- Run complete real-provider journeys through ordinary Core login, separate application containers,
  preview, simultaneous resource samples and independent cleanup inventory.
- Keep credentials, transcripts and raw JSON/log evidence outside the repository. Publish sanitized
  observations with exact test/build results and explicitly state unverified host/provider cases.

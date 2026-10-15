---
created: 2026-10-15
updated: 2026-10-15
summary: Harness runs Codex and Claude in one bounded shared Docker worker while Core owns workspaces, credentials, Git operations and separate application sandboxes.
components: [apps/harness, apps/core, apps/demo-app]
---

# Shared Docker Agent Runtime

## Execution Contract

Harness remains a trusted native coordinator. Its Agent execution setting selects Native or Shared
Docker for **new conversations**; each record persists the choice and older records remain native.
The session interface shows the actual mode. Docker mode requires managed Core storage, provider
connections, the reviewed workspace grant, a local Linux Docker engine and its release-matching
image. Unavailable Docker never falls back to native execution. Per-session health combines provider
setup with Docker readiness; the settings panel also exposes readiness, Stop/recovery and sampled
memory/disk usage. Changing the default refuses active conversations and does not migrate old ones.

One Docker workload occupies the worker across both Codex and Claude. A second turn is refused
before its user message is recorded. Waiting for approval or an answer still occupies the worker.
The existing Normal/Autonomous choice and Core tool policy retain their meaning. Codex app-server
stdio and Claude Agent SDK custom spawning run through `docker exec`; only the coordinator controls
Docker. A completed turn stops and removes the generation, including detached commands. A later
turn starts another generation and resumes its durable provider conversation.

Applications and their browsers run separately. Agent Stop does not Finish a child Core or its apps.
The [sandbox environment API](../app-sandbox-runtimes/feature.md) retains its own consent, accounts,
installation review, quotas and cleanup. The worker has outbound internet for inference and build
packages; it is not network confinement or a malware-analysis environment.

## Image And Filesystem

Harness pins `ghcr.io/alex-de-haas/hosty-agent-worker:0.53.0`, resolving it to an immutable local image
ID before creation. The worker package pins Codex 0.160.0 and Claude Agent SDK 0.3.288, matching the
coordinator. The image includes Node, Git, Python, ripgrep and .NET SDK 10. The dedicated image
workflow builds arm64/amd64, builds the settings export before running Harness checks, and uses
the repository publication guard and provenance flow. Install worker image pulls this fixed release,
not a caller-supplied image.

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
are refused. The worker root filesystem is read-only; it runs with the coordinator's numeric UID/GID,
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

A selected Codex host login imports only portable authorization fields into the managed Docker home
and Core secret namespace. It does not copy host config, hooks, MCP definitions or unrelated history.
An account identity change requires a new binding. An absent previously imported Core secret requires
reconnection, rather than resurrecting it from worker cache. Unsupported/keychain-only credentials
require ordinary Harness login. Native and Docker refresh synchronization compares remembered values
and refresh timestamps so an unchanged stale home does not overwrite newer Core authorization.

A dedicated bridge exposes only registered session workspace and app-MCP routes through
`host.docker.internal`. Each route requires the current session bearer; native loopback handlers and
call-time Core authorization remain in force. The bridge is not a generic host HTTP proxy, forwards
no browser cookies or Core service credentials, bounds request bodies and removes session routes
when execution stops. The listener is container-reachable; possession of its route bearer grants
only the corresponding existing session MCP authority.

## Ownership, Recovery And Resource Accounting

A generation is identified by canonical Core-root hash, Harness installation hash and UUID. The
coordinator persists intent before acquiring a Core shared-source consumer lease and creating Docker
resources. Container name and ownership labels must all match. A label alone never authorizes removal.
Core persists active leases and release tombstones; a delayed acquire cannot revive a stopped UUID.
Every active shared-worker lease blocks cleanup of any shared tree, including trees created later.
Cleanup and lease acquisition share Core's binding lock.

Stop confirms termination and removal through successful Docker inventory. Daemon failure is not
interpreted as absence. Unknown termination preserves ownership and leases, blocks another workload
and exposes recovery. Core lease release must succeed before scratch/state deletion and admission
release. Restart reconciles the same generation, does not replay uncertain model turns, and requires
the owning administrator's fresh Core credential to release retained leases. Provider changes and
transcript retention protect a persisted unreconciled worker. Abandonment stops Docker before
releasing its provider or pending approvals.

| Resource | Policy |
| --- | --- |
| Memory / swap ceiling | 4 GiB / equal 4 GiB ceiling |
| CPU / PIDs | 2 CPUs / 512 PIDs |
| Writable temporary memory | 512 MiB tmpfs |
| Container logs | Two 5 MiB files |
| Soft disk | 20 GiB across source trees, selected history, session files, worker home/cache |
| Observation | cgroup current/peak memory and PIDs every five seconds; disk approximately every thirty seconds |

A soft-disk excess stops execution and preserves source. Sampling permits overshoot and is not a
hard filesystem quota. Cgroup peaks persist on the conversation across worker generations; they
are not simultaneous totals with app lifetime peaks. Sandbox admission credits only the verified
worker reservation matched to an active Core-owned lease and exact container identity, avoiding
counting its reserved agent memory twice. Native Harness, Core, browsers and Docker VM overhead
remain distinct from the worker ceiling.

## Verification Boundary

The initial acceptance host is macOS arm64 with Docker Desktop running Linux containers. Native
Linux and Windows host acceptance is not established by this result. Both provider binaries and the
actual Claude SDK initialization protocol run in the release-matching image. Real Codex and Claude
turns prepare worktrees, edit Demo and pass its unit tests and production build. The reusable
`scripts/check-harness-worker.mjs` needs no credentials: it checks both providers, SDK initialization,
read-only metadata, absent Docker socket and termination of a detached writer after persisted-state
recovery. [Acceptance](../../reviews/2026-10-15-shared-docker-agent-acceptance.md) records both real-provider browser
journeys, coordinator SIGKILL recovery, cancellation, resource samples and complete fixture cleanup.
Codex and Claude preserve their provider conversation IDs across worker generations and Harness
restart. Demo runs in separate containers; its held-open page receives both agents' source edits.
Media Server and a dedicated Transcode Engine also run in the child Core, with read-only external
media. The temporary provider authorization is removed after acceptance.

The local worker image is built and verified. Registry publication and GitHub CI execution are
release operations, not outcomes of this local acceptance. The primary Core/Harness installation
is not switched by the development fixture.

## Testing Expectations

- Assert global busy admission before transcript persistence, including approval/question waits.
- Exercise Codex and Claude transport, provider revision/refresh/revocation, imported account binding,
  and preservation of native execution and durable conversation resume.
- Verify canonical mounts, newly prepared worktrees, exact Git trust paths, Core-mediated mutations,
  scoped MCP authority and route revocation without broadening host access.
- Retain ownership/provider/source leases on unknown Stop; recover the same generation after restart.
  Cover abandoned sessions, retention, cancelled turns and detached processes with real Docker.
- Verify resource observations, soft-disk behavior and active-lease-backed reservation credit.
- Run complete real-provider journeys through ordinary Core login, separate application containers,
  preview, simultaneous resource samples and independent cleanup inventory.
- Keep credentials, transcripts and raw JSON/log evidence outside the repository. Publish sanitized
  observations with exact test/build results and explicitly state unverified host/provider cases.

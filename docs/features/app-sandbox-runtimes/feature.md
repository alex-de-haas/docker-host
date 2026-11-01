---
created: 2026-10-14
updated: 2026-10-31
summary: Parent-managed child Core environments with ordinary applications and accounts, private copied or workspace builds, lifecycle recovery and unified Dashboard controls.
components: [apps/core, apps/harness, apps/shell, apps/demo-app, packages/app-sdk]
---

# Core Environments

Every sandbox is a separate Core with ordinary installed applications and accounts. Empty,
one-app and multi-app environments share the existing environment lifecycle. The removed
single-app relay runtime has no replacement protocol or compatibility adapter. Before upgrading,
the operator deletes existing sandboxes manually. Core provides no migration or automatic drain.
The [plan](plan.md) retains wider host acceptance and the separately scoped remote preview decision.

## Parent-Managed Child Core Environments

The independent `/api/core-environments` API creates an entire test Core on the same host and Docker
engine. App callers use `/api/internal/apps/{appId}/core-environments`, with a service credential,
a current administrator's app grant, and the explicit `core.environments.read/manage` permissions.
Ownership remains bound to
the calling installation and administrator; Harness additionally associates records with its session.

Each environment receives a unique Core instance ID, allocated port and local hostname, a root below
`environments/{id}`, and a private registry record below `core/environments`. It has its own users,
keys, connections, app registry, app data and caches. Parent credentials and provider connections are
not copied. No workspace is required. Optional registered worktrees are retained as persistent
consumers until Finish; they remain outside the temporary root.

Docker CLI plugin discovery carries the installed plugin directories reported by Docker into the
child's own configuration, preserving child-owned settings with an owner-only atomic JSON writer.
Buildx remains available under the
private HOME without copying the parent's registry logins or Docker configuration.

`current` copies the parent's prepared executable closure; `release` copies its installed native
Core binary; `source` builds an absolute selected Core project into a child-owned output directory.
A source restart builds before stopping the previous process, preserving it on compilation failure.
App-authorized source projects must remain inside an attached worktree owned by that session,
without symlinks; this is checked again before start/restart. Direct operator source selection
retains its explicit host-path authority. Child generations use the existing Core build retention:
active processes and runners, the latest two ready outputs and latest failed diagnostic output
are retained. Failed preparation no longer pins outputs to the long-lived parent. Unmarked legacy
outputs are not guessed to be safe to delete; Finish removes them with their owned root.
Requests that omit initialization retain the empty distribution catalog. An explicit initialization
selection uses the selected child build's catalog and the [shared initialization service](../hosty-initialization/feature.md).
Core-only selection is valid; selected applications follow ordinary reviewed lifecycle and resource limits.

Operator inspection/control spans applications belonging to the same administrator, but never
exposes or mutates another administrator's child Core. App callers additionally require their own
installation ownership. Unowned build generations use nonpositive PID markers, which never count
as live processes on any supported operating system.

Collection create/list, status, `/{id}/operations/{start|stop|restart|finish}`, `/{id}/setup` and
`/{id}/api` support the complete local lifecycle. Create and lifecycle operations use persisted
request UUIDs, input fingerprints and expected revisions. Reconnect repeats the original request or
reads its journal; it does not guess a successful outcome. Admission permits two unfinished
descendants across the root environment tree. A root-owned
file lock serializes allocation across parent/child processes, including after restart. Nested
creation consumes the same count as direct creation; failed/stopped environments retain capacity
until Finish. The same tree also reserves an aggregate **8 GiB app-container memory, 4 CPUs,
1,024 PIDs and 20 GiB owned disk**. A default child reserves 4 GiB/2 CPUs/512 PIDs/10 GiB;
`limits` on create can select a different share within the pool. Descendants, stopped children and
failed cleanup retain their reservations. Independent primary Core installations are outside this pool.

Within a managed child, Docker app admission holds a persistent allocation lock, inventories existing
containers, and refuses unknown/unbounded capacity before network/build/container creation.
Concurrent app starts wait for the allocation lock through the bounded pull/build/start window;
cancellation releases the wait, and an exhausted deadline returns an explicit admission-busy error. Each app
receives 2 GiB/1 CPU/256 PIDs by default, divided across its selected services; the environment's
`applicationMemoryBytes`, `applicationCpus` and `applicationPids` configure that share. Docker enforces
memory plus equal swap ceiling, CPU and PID limits from creation. Verified adoption requires matching
limits.
Legacy containers without verified ceilings require recreation rather than silent adoption.

Resource observations report container working memory, native Core RSS and owned disk usage separately. Successful Finish clears the last live usage sample;
finished views also hide samples retained by older records. Failed cleanup keeps its diagnostic
observation until retry succeeds. Resource sampling rechecks terminal state under the lifecycle gate.
Owned disk includes regular files without following symlinks, labelled container writable layers and
named volumes; descendant roots have their own reservation. Every 15 seconds the parent observes usage,
stops an environment that exceeds its soft disk quota, and retains its data and reservation. Docker
unavailability produces an explicit unknown observation. Container logs are bounded to three 10 MiB
files. Borrowed mounts, shared images/BuildKit cache and native Core/source-build/local-command processes
are not hard-capped by these Docker limits. Native RSS is measured; this is not a total host-memory or
hard filesystem quota. Selected child builds require Core 0.133.0 or newer for this resource contract.

The existing agent setup endpoint uses ordinary Core bootstrap and password login with explicitly supplied test credentials.
The resulting child session stays private in the parent-owned child root. The JSON API transport
uses that child account, supports bounded relative `/api/` requests, and rejects redirects/streaming.
Normal Core authorization and installation review remain in effect: an administrator API request
does not bypass an app-install confirmation. API writes retain the called endpoint's replay rules.
An operator signs into the child Core normally; Harness lists Core and running app preview links.
Explicitly initialized children expose bounded initialization status, resume and setup-link operations.
The parent reads these and app inventory through fixed local control operations; it needs no child
password or parent-session file. Registration remains the child's ordinary browser setup flow.

Stop preserves users and data. Normal parent shutdown stops owned children and their apps;
`keep-apps` preserves them for adoption. Parent SIGKILL does not immediately stop children: the
replacement parent reconciles persisted PID/start identities and child control discovery. Interrupted
operations retain an explicit failed outcome for inspection and a deliberate retry using the **same
request UUID and original arguments**. Successful or superseded operations do not rerun. Shell and Harness preserve a failed Finish request across refresh while it remains the latest journal
operation. A newer operation supersedes that saved replay; the panel clears it and allows a fresh
delete request against the current revision instead of leaving all controls blocked.
Parent reconciliation stops incompatible pre-0.133 child processes and their
containers; a stop failure remains visible and retains the reservation for retry.

Finish closes the managed root and descendants to new starts. It journals the cleanup-owner inventory
and a root-deletion checkpoint outside the deleted tree, so interruption after removal of the identity
file remains recoverable; a changed identity still blocks deletion. Finish uses a
bounded graceful stop, verified-process fallback and an exclusive Core root lock before cleanup.
It also traverses recorded descendants, removes containers/networks/volumes bearing the full owned
instance label, deletes the temporary root, and releases worktree consumers. Fresh Docker inventories must confirm resource removal. Dependency networks carry full instance/app
ownership labels. App start preserves upgrade compatibility by reusing an unlabelled legacy network
at its exact derived name, including on non-default roots, without deleting its endpoints. A conflicting
owner label is refused. Failed app startup removes only a network created by that invocation;
adopted labelled and legacy networks are retained during partial-start cleanup. Finish still reports legacy unlabelled networks as an explicit repair error
rather than deleting them by name or silently omitting them. Failed cleanup retains the root and a retryable error. A finished operation receipt remains for replay. Borrowed source,
external mount targets, exported evidence and shared Docker images remain outside deletion.

This is the approved trusted-Core development model. The child receives the shared local Docker
endpoint and normal internet access; it is not a hostile-code isolation boundary. Modified Core code
can control Docker on this host. Explicit mount/connection/app-install approvals remain ordinary child Core operations.

The [recovery and quota acceptance](../../reviews/2026-10-14-sandbox-recovery-and-quotas.md) verifies
published Media/Transcode artifacts, product-created Docker ceilings, actual Docker Desktop loss,
explicit app recovery, same-request Finish and parent SIGKILL during root deletion. It also checks
soft-disk stopping, old-Core refusal, complete fixture cleanup and full original media hashes.

The [manager acceptance](../../reviews/2026-10-14-child-core-manager.md) verifies two app-bearing
children, normal browser login, source and native release launch, a nested child, worktree retention,
keep-apps adoption, parent crash reconciliation and broken-child Finish. It supersedes the earlier
experiment's missing-manager limitation. Local image locks now preserve immutable local image IDs
for adoption; Docker source cache volumes carry full instance ownership labels; Demo health checks
use the writable app-data log directory.

The [Core and Demo source acceptance](../../reviews/2026-10-14-core-source-agent-acceptance.md)
verifies a real Harness agent changing both components in its session-owned worktree. The manager
builds that exact Core project in source mode; Demo consumes the changed authenticated directory
API in a normal browser session, and hot reload preserves the child identity. Finish removes the
child process, root and labeled Docker resources while preserving borrowed source. The temporary
API marker is an exported test fixture, not a shipped Core response field.


## Shell And Harness Controls

Dashboard places one Core instances section above Apps. The connected Hosty Core is always first,
without a primary marker. Named children follow in identity/status/resources/action rows. Create
environment appears above the section; there is no separate Sandboxes frame or Refresh button.
The existing dialog retains a fixed header/footer, optional application selection, ports/resources
and immediate dismissal on Create. It submits the same current-mode create/start workflow.

A source-built Core shows its workspace name, with an unavailable label when source context cannot
be read. Copied current/release builds show their own observed Core version, never the parent's.
The child status observation supplies the version and retains the last observation after Stop.
Continuing children keep their private copied build when the parent updates; parent Start/Restart
still prepares the selected current/release/source input using the existing semantics. This is
build independence, not a permanent version pin across every lifecycle operation.

Child CPU/RAM comes from the existing native resource sampler, keyed by environment and verified
PID/start time. The row uses the shared Dashboard history widget. Child usage is excluded from app
totals; resource reservations remain separate. See [resource delivery](../runtime-resource-usage/feature.md).

The complete app/Core/environment row uses the sidebar's theme lime hover, including its controls.
Environment Details opens from the child name or overflow menu, with one installed-app list,
runtime and health inline, and resource/access information. Dashboard rows have no disclosure.
Initialization progress stays in the row. The primary action is Sign Up when the first administrator
is needed, then Stop for a running Core or Start for a stopped Core. Open Core and secondary actions
live in the overflow menu; Open Core requires a configured administrator. Confirmed deletion shows
a toast naming the child; errors retain their recovery UI.

Harness session/workspace previews contain child environments and their ordinary application
links. Workspace cleanup and retention use only that inventory, preserving owner checks, durable
request IDs and source consumers. Closing a workspace does not finish a retained child.
The existing environment_* MCP tools and CoreEnvironmentClient provide creation, consent, lifecycle,
setup and bounded ordinary child API access. No persona, seed/reset, relay or private-browser tool
is advertised. Browser checks use normal setup/login and external browser tools; fresh test data
comes from app fixtures or a newly created environment.

## Trusted Child Core Consent

Delegated child creation requires explicit operator consent in addition to the initiating app's
`core.environments.manage` permission and current administrator authority. Harness exposes
`environment_consent` with the exact `environment_create` arguments. Core returns its normal
confirmation page; the page defaults to this run and offers a saved permission for matching launches.
Preparing or visiting the page does not allocate or start a child. After approval, the caller retries
the original creation UUID. Direct operator launches, including the workspace UI action, retain
ordinary operator authority and do not grant permission for unrelated later launches by that app.
Concurrent and exact consent retries reuse the pending or completed review within its normal
lifetime, scoped to the caller installation, owner, creation UUID and policy. Changed creation
arguments conflict; revoked permission or a changed Core target can receive a new review. Repeated
approval reuses an identical active persisted grant, including after approval pages expire or Core
restarts, so revocation does not leave a duplicate matching grant.

Consent uses the existing background-grant store. A scope pins the owner authorization revision,
calling installation, current/release/source mode, Core target, trust-contract version and resource
ceilings. A one-run scope additionally pins the normalized creation request. Saved source consent
trusts ordinary edits in the chosen Core project/worktree, while current/release consent pins the
prepared binary closure, including native libraries, configuration and other copied runtime files.
The regenerated retention marker and skipped directory links are outside that copied closure.
Another target or increased resource ceiling requires review. Worktree
ownership and source path checks still apply independently. The `core-environment` scope can issue normal short-lived background
credentials for its reviewed actions. Consent includes only the caller's currently granted
read/manage actions; a manage-only caller does not receive read authority.

Operator-created children persist explicit operator approval, including when they retain an
assistant workspace owner. Legacy app-owned records without that marker or consent require review
before delegated start/restart, setup or child API access. The original creation request attaches
approved consent without replacing the child; operator authority and Stop/Finish remain available.

The shared Shell panel shows effective consent and supports revocation. Shell also lists
saved permissions when no environment remains. Effective access and saved permissions report a
changed or unavailable binary target instead of an active launch permission, while preserving
revocation and ordinary operator lifecycle controls. Each list response computes a distinct
current/release target digest once and shares it across environments and saved permissions; the
next request recomputes the digest. Grant labels reuse the validated sandbox name
without adding a prefix that exceeds the grant's name limit. Revocation prevents new delegated creation,
start/restart, setup and child API transport. The operator retains inspection, Stop and Finish.
Finish retires one-run consent; saved consent remains an explicit operator policy until revoked.
The original creation request still returns the finished receipt after one-run consent is retired,
without recreating data or processes. Exact successful or superseded Start/Restart replays also
return their existing journal after launch consent is revoked or its target changes; new commands
and retryable failures require live consent before preparing or changing the journal. Caller
identity, ownership and request fingerprint checks still apply to terminal replays.
Approval audit records identify the initiating app as their resource and retain the request, caller,
operation and one-run/saved choice under the reviewed metadata schema. The requested event is
persisted before submitting the review, so abandoned requests are traceable without a decision. A prepared generation is
journaled before post-build consent revalidation, so rejected launches release its parent ownership
and retention keeps only the latest failure diagnostics instead of accumulating orphan builds.
After reviewing a changed target or renewed permission, replaying the original creation request
updates the active child's consent without replacing its identity, data or lifecycle journal.
Renewal shares the child's command gate and re-reads its latest state after an in-flight operation.
Revocation alone neither stops a running child nor retracts its own accounts or credentials.
The child remains a trusted Core with ordinary administrator rights, internet and shared Docker;
its normal app-installation and shared-mount review are not replaced by parent-side policy.

The [2026-10-15 trusted-Core acceptance](../../reviews/2026-10-15-trusted-core-consent-acceptance.md) verifies one-run/saved consent, revocation, dedicated Redis dependencies, shared mount limits, ordinary roles, nested cleanup and Linux-in-Docker interrupted Finish. It records the measured resource envelope and remaining host-coverage limits.


## Canonical Environment Access

Core also exposes `/api/core-environments` and the `environment_*` MCP tools without a Harness
conversation. Current same-user environment read/manage grants cover independent creators; creation
attribution remains immutable. Legacy creator-bound routes retain their original authority. Source
inputs additionally require registered workspace authority; child setup/API access has its own grant.
Registered active or unknown consumers block Stop, Restart and Finish. A timeout, closed chat or
caller-supplied stopped claim is not native exit proof. Readiness and retained request receipts remain
the authoritative lifecycle result. See [Core MCP](../core-mcp/feature.md).

## Testing Expectations

- Preserve current/release/source build selection, replay, quotas, child updates and startup failure
  recovery. A failed source build preserves the current child.
- Verify normal password login and app roles, owner/installation boundaries, explicit consent,
  independent app data and no inherited parent credentials.
- Verify nested reservations, Stop/Restart data retention and Finish recovery/resource removal.
  Source, shared mounts and exported reports remain outside deletion.
- Verify one upper Core section, workspace/version metadata, full-row lime hover in both themes,
  child-only metrics and shared stream recovery without per-row inventory polling.
- Exercise the environment APIs and negative access checks; removed routes, permissions, SDK
  clients and MCP tools must not reappear. Broader host coverage remains explicit in the plan.

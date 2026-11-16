---
created: 2026-11-12
updated: 2026-11-16
summary: Independent Local agent apps expose installation-qualified HTTP/SSE execution with provider-owned native state and Core-scoped authority.
components: [apps/core, apps/harness, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Agent Provider Execution

Hosty exposes agent execution through an application-neutral HTTP/SSE v1 interface. Core discovers
confirmed `agent` providers and authorizes exact operations. A consumer sends inputs and receives
execution data directly from the selected provider; Core does not relay the prompt or event stream.
Generic Core skills, MCP and [Decisions](../shared-decisions/feature.md) retain their separate data
ownership. Provider identity is the explicit `{ appId, installationId, key }` reference, independent
of the provider's vendor or application name.

## Application And Data Ownership

The distribution contains three independently installed Local applications:

| Application directory | Distribution app ID | Native implementation |
| --- | --- | --- |
| `apps/codex-provider` | `hosty.codex-provider` | Pinned Codex CLI/app-server |
| `apps/claude-code-provider` | `hosty.claude-code-provider` | Pinned Claude Agent SDK/Claude Code |
| `apps/ollama-provider` | `hosty.ollama-provider` | Hosty agent loop using a configured Ollama endpoint |

`packages/agent-provider-runtime` supplies shared implementation mechanisms; it is not another
running service. Each installed app owns its connection settings, Core secret namespace, selected
native homes, session aggregates, execution journal, attachments, pending native questions and
process evidence. Selecting a Codex host-login directory is explicit; setup imports no account,
credential or history from Harness or another provider. The operator supplies project tools on the
host. The Ollama provider neither installs an inference daemon nor downloads models.

Harness owns conversations, profiles, business tasks, preferences and its projection of provider
execution. Its manifest contains one API/UI service; its Docker image and Local bundle contain no
native agent SDK or worker service. Harness persists qualified provider/account selections and
exact outgoing commands. Restarting or disconnecting the consumer does not itself cancel a provider
run. Harness-owned business tools still depend on Harness being available.

Task-capable consumers can declare the reviewed `task-executor` v1 `session-workflow`
capability and bind their own executor installation and conversation UUID in the accepted
`ceiling.workflow` metadata. Core's task tools then forward a signed, exact-byte
`POST /sessions/{id}/workflow` request to that declared interface. The invocation includes the
original user and the exact provider/session/run reference; the consumer checks its current
conversation ownership and retained run before applying its own task workflow. Ordinary agent
consumers require no workflow endpoint. Qualified task-source keys remain separate from executor
keys, and retained task attempts keep their original source identity.

The provider's bounded task business channel calls
`POST /api/internal/apps/{provider}/agent/workflow` with its service identity, the admitted reference,
a fixed task action, object input and optional qualified task source. Core validates the original
actor and current task attempt, then forwards the signed consumer-owned operation. This works with
external task sources under their retained dispatch authority. The channel requires the consumer's
current reviewed `providers.task-executor` permission, its `session-workflow` capability and the
explicit per-run workflow binding. Tool selection and Ask/Run/Disabled policy belong to the accepted
binding; Core enforces the selected subset and Disabled rules, and the provider handles Ask through
its own durable Decisions. The default workflow policy is Ask.

Core MCP remains a separate connection with its existing target grants, originating-consumer
rules and tool policy. The bounded business channel leaves those grants unchanged and supports
consumer task tools while general Core MCP is disabled. Core also exposes task workflow wrappers
for callers with normal explicit Core MCP access. Missing task workflow authority is a
setup/availability error. Session workflow commands retain their original request UUID and input
after an uncertain reply, and completion acknowledges the durable report before native stop
settles independently.

Each provider has a Hosty-authenticated `/settings` surface and app-owned connection management under
`/api/settings`. Hosty app-code sign-in and current administrator access protect those operations.
Connection changes use revision checks and refuse changes to an account with an active run.
The settings surface retains the former Harness provider list: compact connection rows, a default
badge, an actions menu, and an Add/Edit dialog. It uses the shared Hosty theme and bundled fonts,
follows Shell theme changes, and removes the duplicate application heading when embedded.
Optional account limits appear beside connection actions, with the same remaining-quota indicator
and detailed windows/credits as Harness. The existing public usage operation refreshes bounded
account telemetry without a model prompt, so an empty consumer chat does not need a first message
to populate its limits. Provider-owned settings use their own administrator-authenticated usage
route and share the same revision-bound cache and refresh throttle.
Account sign-in, current-user activity and continuity remain independent for each provider app.
Harness settings open Agent profiles; the former Agent providers tab is removed. Its historical
`/settings/providers` bookmark opens Agent profiles. Accounts and sign-in are managed in each
provider application's Shell settings entry. Conversation provider selection remains available.
Embedded Harness settings use the Shell content width without repeating the application heading;
standalone settings retain their own heading and page spacing.
Harness and the agent provider apps expose no translation interface, translation account selection
or translation-only native execution. The independent [OPUS application](../local-translation/feature.md)
is the distribution's translation supplier. Core and both SDKs retain their generic scoped
translation contract for that provider and independently implemented alternatives; no vendor
identity selects a provider or grants authority.

## Public HTTP And SSE Contract

The first-party interface base is `/api/agent/v1`. Declarations supply the actual endpoint and path;
consumers do not derive them from an app ID. Every operation requires a fresh, exact Core credential.
The unauthenticated `/healthz` endpoint reports service liveness only.

| Method and relative route | Operation |
| --- | --- |
| `GET /capabilities` | Version, limits and enforceable/observed capabilities |
| `GET /connections` | Provider-owned non-secret account metadata |
| `GET /connections/{id}/models` or `/usage` | Catalog or optional usage metadata |
| `PUT /attachments/{uuid}/chunks/{index}` | Immutable, actor-scoped attachment upload |
| `PUT /sessions/{uuid}` | Lazy public session creation |
| `PUT /sessions/{uuid}/configurations/{uuid}` | New immutable desired configuration revision |
| `GET /sessions` or `/sessions/{uuid}` | Owned session metadata |
| `PUT /sessions/{uuid}/runs/{uuid}` | Durable native start or explicit resume admission |
| `GET /runs/{uuid}` | Authoritative snapshot and replay cursor |
| `GET /runs/{uuid}/events?after={cursor}` | Sequenced `agent-event.1` SSE replay and live events |
| `POST /runs/{uuid}/responses` | Revision-bound approval/question response |
| `POST /runs/{uuid}/cancel` | Cancellation or a lost-start admission fence |
| `POST /runs/{uuid}/controls` | Capability-gated park, barrier, reconciliation or configuration control |
| `GET /runs/{uuid}/controls/{requestId}` | Durable control receipt |

Connection and session lists use the same ordinal ID ordering for sorting and cursor advancement.
Pagination preserves opaque IDs and their case; mixed-case IDs remain reachable across pages.

The TypeScript SDK exports types from `@hosty-sdk/app/agent`, `AgentClient` and exact-byte preparation
helpers from `/agent/client`, validators/SSE helpers from `/agent/server`, and schemas from
`/agent/schemas`. Checked-in OpenAPI, event JSON Schema and conformance fixtures live in
`packages/app-sdk/schemas`. The caller supplies the metadata-only `AgentAuthorizer` callback;
its Core credential stays in that consumer backend. `watchRun` reconnects with fresh authority,
deduplicates events and reloads the authoritative snapshot when replay expires.

The .NET SDK exposes `HostyAgentExecutionClient`, persisted `HostyAgentPreparedRequest` commands and
`HostyAgentAuthorizer`, plus `HostyProviderClient` authorization/admission/renewal helpers.
`EventsAsync` reads a bounded stream with an explicit replay cursor; `RunAsync` retrieves the
snapshot for caller-managed reconnect/recovery. Both SDKs keep provider credentials separate from
Core service/user credentials and require the explicitly selected installation.

A session UUID, a run UUID, a native SDK session reference and a Harness conversation ID are separate
identities. Protocol identity fields use opaque references rather than private native SDK session
IDs or account directories; connection metadata contains no credential values. Authorized tool
content can still include project paths and ordinary command output.
Session/configuration creation stores metadata and selected skill snapshots without starting the
native engine. A run first commits its input, active slot and public snapshot; initialization and
native reconfiguration occur under its `preparing` phase after Core admission.

Desired configuration carries the exact connection revision, instruction blocks, appended system
prompt, selected skills and supported native-tool/approval/subagent options. Per-run context,
model/effort selection, resource references and MCP selection are separate. Once initialized, a
native session remains bound to its connection/account revision. Unsupported compatibility or
limits produce explicit errors. `resume` with missing native state fails; it does not construct a
new session from the consumer's visible transcript.

There is one active run per public session. Provider capacity defaults to four occupied sessions;
unknown-stop runs and reserved continuations retain capacity. Stable command UUIDs and the SHA-256
of the exact UTF-8 JSON bytes provide replay. Identical retries recover the original operation before
new revision checks; changed bytes under the same identity conflict. A caller persists prepared
bytes before sending and retains those identities after a lost acknowledgement.

## Original Authority And Core Bridges

A reviewed consumer `providers.agent` grant permits discovery, including an app-only directory read.
Invocation additionally requires current user access to both apps and the existing administrator
boundary for native execution. The consumer requests `POST /api/internal/apps/{consumer}/agent/authorize`
with provider reference, operation, method, relative path, body digest and bounded resource/configuration
metadata. Task execution can instead retain the exact original dispatch actor and task attempt;
it does not replace that actor with a service administrator.

A task cancellation fences new native admission, responses and execution renewal. The exact current
attempt retains operation-bound run reads, event/control receipt observation and cancellation,
including a cancellation fence for retained start bytes that were never admitted. Core still checks
the current original user/grant, executor installation, latest attempt, immutable input and root
generation. These Stop/observation credentials cannot admit native work, mint MCP authority or pin
skills; a replaced or invalidated attempt remains refused.

Core issues a two-minute operation credential. The provider introspects the exact method/path/body
hash, then admits an accepted run through its own service identity. The durable admitted reference
retains the original authority's absolute expiry. Provider-owned renewal rechecks current users,
installations, consumer grants and task state; it creates no indefinite or background grant.
Harness availability is not part of that renewal check. Expired/revoked authority fences new effects;
a terminal-looking status alone does not free an unconfirmed execution.

Provider bridges below `/api/internal/apps/{provider}/agent` cover `introspect`, `admit`, `renew`,
`mcp/token`, `skills/snapshots` and `workspace`. They operate on the exact admitted original context.
A provider needs no standing Sources, ReadSkills or MCP grant merely to proxy a consumer's authority.
The provider's own Decisions permissions still govern its question records.

- Nonempty skills require the consuming app's current `apps.skills.read`, including task-origin
  execution. Empty selection uses an exclusive provider-owned empty directory. Pinned snapshots
  preserve selected bytes across library updates; removal of a selected package or permission
  revocation blocks reuse. Renewals check current package availability without rereading every body.
- MCP tokens bind the current exact target installation/interface and selected tools. Core dispatch
  enforces that ceiling and disabled policies; UI filtering is not authorization. Native children
  use the provider-owned tool proxy, which obtains fresh Core credentials for dispatch.
- Resource references identify execution context rather than a new collection permission allowlist.
  Initial worktree resolution checks the expected declared context. Existing reviewed collection
  authority also supports MCP-created workspaces. Durable lease intents precede workspace effects;
  cleanup releases only the admission's recorded lease UUIDs, including pre-effect crash recovery.
  It never scans and releases every lease belonging to a conversation.
  Direct and agent-origin MCP lease creation and cleanup serialize within the same admission.
  Cleanup persists a closing fence before releasing claims; the fence survives Core restart and
  prevents later acquisition or replay of released UUIDs. Agent-MCP individual release verifies
  the exact claim owner under the workspace mutation lock and retains its own recovery-safe
  operation identity. Ordinary workspace administration keeps its existing authority.
  After confirmed native stop, the provider durably records pending cleanup before contacting
  Core. Its maintenance loop retries the original admission and release request UUID after a
  transient failure or lost reply, including provider reconstruction, until Core explicitly
  confirms release. Cleanup does not require a snapshot read, pending decision or renewed execution.
  Only a persisted execution start is eligible; superseded reservations and before-start cancel
  placeholders retain their fences without creating cleanup requests.

Before a new run, Harness reads current participation separately for every selected workspace
under the original user or task attempt. A cached association or a missing revision cannot supply
authority. An unprepared next-turn continuation refreshes only its original worktree revisions,
preserving the worktree IDs and their order, including the initial execution directory. A retained
prepared request keeps its original bytes; changing participation still meets Core's normal CAS
and current-access checks.

Blocking native callbacks carry a durable wait age. At five minutes the provider parks an execution
blocked exclusively on those questions, with no active/unknown effects or uncertain response
operation. Confirmed parking revises the pending question to `next_turn` delivery while retaining
its Core link. Nonblocking questions and independent active child work are not automatically parked.

Ollama's remote MCP requests use the remaining finite 15-minute active execution budget, including
human approval waits. Its SDK request and owned HTTP dispatcher have explicit deadlines; progress
does not extend the request indefinitely and Stop aborts it. The dispatcher does not alter global
fetch behavior. The provider proxy separately bounds connection/response-header waiting to two
minutes after approved upstream dispatch. A timeout after dispatch preserves an unknown effect
unless an authoritative result establishes completion.

Provider-native questions are source-owned Core Decision records bound to the exact admission.
The provider observes answers, records immutable delivery and reports continuation status. Metadata
observation, acknowledgement, withdrawal and progress reports remain possible after execution
expiry while the current provider installation, user access, Decisions grants and record ownership
still match. Those operations authorize no native work. Creating questions, answering them or
starting another native attempt still requires the relevant current authority. A parked/next-turn
answer can reserve a public continuation identity while reporting `awaiting_authorization`.

## Native State, Events And Stop Evidence

Codex and Claude resume provider-owned native state through their SDK/CLI interfaces. Their context
is engine-managed and can be compacted; it is not a permanent in-memory transcript or a filesystem
snapshot. Ollama persists Hosty's loop messages, summary and effect receipts and supplies bounded
context on each inference request. Ordinary consumer reconnects do not resend UI history as a new
native conversation.

Atomic provider session aggregates retain public snapshots, sequenced events, decisions and command
receipts; a private native execution journal remains separate. Replay is bounded to 64 MiB per run
and seven days after confirmed completion. Snapshot recovery replaces state and cursor together;
expired replay returns an explicit reload requirement. Native context, pending questions and
mutation tombstones have separate lifetimes; replay expiration does not purge them.

The optional `latestContext` snapshot field retains the latest root context-usage observation at
its original public event sequence. Explicit null usage clears the previous measurement. Harness
uses the same run-qualified identity for snapshot and live-event projection, so reconnect restores
the latest missed measurement without duplicating a received event. Intermediate offline
measurements are not a per-request ledger. Older records without the field remain compatible;
startup does not backfill processed native history.

Native subagent events carry `source.agentId`, `parentAgentId` and `parentToolCallId` when reported.
This observes SDK-owned child work; there is no public client-spawn endpoint. Codex advertises
observed policy and summary coverage; Claude advertises enforceable enablement with partial coverage;
Ollama advertises no native subagents. Unsupported concurrency guarantees are rejected. Correlated
child output does not replace the root result, and inclusive usage is not counted again as separate
child consumption.

Codex observes pinned SDK subagent activity and reads only a verified completed child turn through
the read-only native `thread/read` operation. This supplies attributed tool summaries without
starting/resuming another thread. Interrupted, missing or superseded child history marks tools
coverage as truncated. Closing an already verified completed child preserves its recorded history.

Claude can supply a nested command's text result without structured exit metadata. The provider
retains that output and its child provenance while reporting the command outcome as unknown.
A matched native tool result can close its invocation receipt without inventing an exit code.
When cancellation omits a registered child terminal from the live stream, the adapter can read
that exact child's messages through the pinned SDK's public `getSubagentMessages` API. It waits
for the SDK iterator and every captured native process handle to close first. The read runs in
one tracked, bounded helper with the selected connection's canonical durable history home and no
Core or provider credentials. Execution discovery HOME and durable history have separate,
provider-owned bindings. The reader accepts only the owned execution HOME's `projects` redirect
to that exact history directory, with identities checked before and after reading; native history
files and their canonical parent paths do not traverse links. Session, turn, parent, agent,
API assistant-message and tool identities must match the
already observed command. The SDK normalizes multi-block assistant messages into live frames with
different envelope UUIDs; the reader retains live and persisted UUIDs as separate provenance and
uses the preserved API message ID for their join. A matching error result closes the invocation
as failed; the command's exit status remains unknown. This does not restart or resume a native
session.

The history reader supports direct project paths with an encoded name of at most 200 characters,
first-level children, a child transcript of at most 1 MiB, a sidecar of at most 64 KiB and one known
session directory of at most 256 files. It reads at most 128 SDK messages per child, eight known
children and sixteen registered calls. Hashed or relocated project layouts, deeper children,
unrelated redirects or linked history files,
ambiguous identities, oversized history and missing results retain unresolved effects. Neither
physical process exit nor result text alone settles an invocation.

Console diagnostics distinguish admission, binding, file/history guards, terminal availability
and helper deadlines through fixed codes, counts, timings and bounded SHA256 bindings. They omit
raw paths, identifiers, commands, message content and SDK error text, and do not settle effects.

Harness retains each run's canonical cancellation bytes and acknowledgement independently of its
pending outbox. An applied receipt can remove the pending entry without losing its UUID, body hash
or original optimistic revisions. Repeated Stop and restored execution observe that same control;
an unknown attempt can retry only its exact original bytes. A missing previously acknowledged
receipt fails closed rather than replaying input or inventing a replacement cancellation.

Harness also checks retained configuration-control receipts before admitting the next turn. A
terminal run snapshot can precede the final control receipt in the event stream, so this check
reads the original request through its receipt endpoint. Applied or rejected receipts settle only
their matching run, request and generation; accepted, unknown, missing or unavailable receipts
remain pending. Disabling predictions reuses an existing matching request and sends no new
configuration command after confirmed stop.

Before recording local cancellation, Harness projects the authoritative stopped snapshot inside
the session's existing serialization lane. Older queued observations cannot rewind that snapshot.
An explicitly qualified temporary observation failure preserves only the same run, generation and
tool-source pairing until its authoritative final output arrives; ordinary errors, foreign output
and new user turns remain separate transcript boundaries. This retains genuine tool results without
reopening a stopped conversation or treating an unknown command outcome as success.

`state`, `phase`, `freshness`, effect certainty and `stopConfirmed` are independent snapshot fields.
An accepted cancel/control receipt is not proof of process exit. Supported SDK stop-and-wait,
provider-owned process containment and resolved tool effects determine stop confirmation. POSIX
launches use a separate receipt writer and anchored process group. Native stdout/stderr receive
fresh blocking pipe endpoints; Node forwards them with backpressure instead of inheriting its
nonblocking output descriptors into the native binary. Native exit initiates owned descendant
cleanup, while pipe EOF and output flush remain separate completion facts. Receipts distinguish
physical tree closure from output delivery; producer loss never manufactures SDK-stop confirmation.
Windows uses a suspended native launch assigned to a non-breakaway kill-on-close Job Object and
handle/accounting checks. Private
control channels stay separate from native stdin/stdout/stderr. Native environments exclude Hosty
service/control credentials and unrelated tool bearers.

Before launching a child, the provider durably records its intent. Durable SDK-stop confirmation,
matching child receipts and a sealed/exited producer support reconciliation after restart. Missing
proof stays `unknown`; a client-supplied stopped flag or a saved PID does not establish it. Automatic provider recovery
never terminates processes by PIDs loaded from receipt files. Workspace/capacity release follows
confirmed provider outcomes, rather than a disconnected consumer or an elapsed timeout.

Codex protocol acknowledgments have a 30-second deadline, with a two-second polite interrupt
budget and independently bounded metadata diagnostics. These bound RPC acknowledgments rather
than active inference or human approval waits. Interrupt requests carry the correlated thread and
turn IDs; without a known active turn ID, cancellation proceeds to owned stop directly. A rejected
or unanswered polite interrupt cannot prevent supported stop-and-wait. Acknowledged Codex
interruption drains the exact turn's terminal notification within the same two-second budget.
Codex background terminals receive the pinned SDK's thread-scoped cleanup request; exact known
command identities remain accepted after their originating turn ends. Root completion waits for
bounded cleanup and typed command-terminal events before worker teardown. Cleanup acknowledgement
alone does not settle an effect. A missing terminal result retains uncertainty rather than
manufacturing successful effects; teardown has one additional bounded cleanup attempt if the
polite interrupt cannot finish.
Provider shutdown asks the driver to stop before draining background controls, so an accepted cancellation cannot block its
own shutdown. Neither deadline nor a successful control receipt replaces native exit evidence.

Claude's polite interrupt has a two-second bound and its complete SDK stop/stream-exit wait has a
ten-second deadline. After the acknowledgement it allows up to two seconds for exact pending
tool terminals before closing the SDK stream. Repeated Stop shares the existing shutdown. Once stopped, the adapter admits
no new tool permission or question, while retaining exact registered late tool terminals from the
current turn. Missing/foreign/replayed results cannot settle effects. Owned process-tree cleanup
still runs if SDK completion is unconfirmed; physical exit alone does not become SDK stop proof.
Its stopped-state PreToolUse hook also denies new native tools in the SDK's permission-bypass
mode. An unstructured local SDK cancellation error cannot certify a remote MCP operation's outcome.
The child-history helper uses the same ten-second stop deadline and requires its full two-second
budget after native closure. A missing native-close event or unconfirmed helper exit leaves stop
unconfirmed rather than extending the deadline or fabricating an outcome.

## Local Builds, Transport And Cutover

Each provider's Local/dev setup calls the shared `local-runtime.mjs prepare <provider-directory>`.
It snapshots only that app, shared runtime/SDK and projected locked dependencies into its own
`HOSTY_APP_CACHE_DIR/provider-runtime` generation. Keys include input bytes, Node version, OS and
architecture. The selected native SDK is included; unrelated providers, Next and test toolchains are
excluded. Concurrent setup uses an owner lock and atomic publication. `start` imports the prepared
executable; it does not install into the source checkout or prune another provider's dependencies.
Older generations stay in place for their existing consumers. Source changes during preparation
reject publication rather than mixing revisions.

Provider updates require operator-prepared quiescence: finish or cancel active runs through the
provider API and wait for authoritative stop/effect confirmation before using Core lifecycle.
Core's Local Stop forcibly terminates its app process group/job; it does not perform an SDK drain.
Restarting an active provider can therefore retain an interrupted/unknown execution, even after
its processes disappear. Client attestation cannot replace the missing provider-owned proof or
settle unresolved effects, and the old input is not replayed automatically.

The native HTTP listener uses the assigned `HOSTY_PORT_HTTP` on IPv4 `0.0.0.0`; authenticated API and
settings operations enforce their distinct credentials. Consumers use Core's direct transport
address, with Docker host-loopback rewriting where applicable. That rewrite alone does not prove
reachability for another daemon topology. Public browser navigation and backend transport addresses
remain separate.

The extraction has a clean-slate boundary. Install and configure desired providers first; stop and
confirm all old work before updating Harness. Remove selected old conversations/history and stale
bindings using their owning controls, and separately verify legacy native-history cleanup. The
startup inventory guard refuses pre-extraction conversation records or an unreadable initial
inventory and writes a new consumer-format marker only after that check. It does not certify that
old processes stopped or that a separate legacy native store was erased. No automatic account,
credential, native-session or history migration occurs. Core workspaces, source trees, Git metadata,
profiles, business tasks and unrelated app data retain their separate ownership. The explicitly
approved ordinary-host cutover on 2026-11-13 completed backed-up legacy-history cleanup and workspace
activation. All three Local providers and Docker Harness report healthy; normal Shell identity
resolves newly configured Claude and Codex accounts as Ready. This readiness check is separate from
paid SDK inference and cross-platform acceptance.

The offline [legacy history cleanup helper](../../../scripts/cleanup-legacy-harness-history.mjs)
provides a separate, explicitly confirmed cutover operation. First stop both old Harness services
through Core and verify that their native consumers have stopped. Keep a reviewed backup before
removing history. Supply the real absolute Harness app data directory and the exact selected
observation owner; the helper never discovers an installation or chooses a user:

```sh
node scripts/cleanup-legacy-harness-history.mjs plan --data-dir <absolute-data-root> --owner <owner-id>
node scripts/cleanup-legacy-harness-history.mjs apply --data-dir <absolute-data-root> --owner <owner-id> --plan-digest <reviewed-sha256> --request-id <stable-uuid> --confirm-delete-legacy-history
```

Both phases acquire the existing coordinator and worker SQLite ownership locks. Planning requires
an empty global conversation directory, orphaned observations belonging to the selected owner,
confirmed native exit, terminal worker receipts with no pending callbacks, and applied controls.
Schema-valid parked barriers are retained checkpoints rather than active callbacks; only stopped
checkpoints without effects qualify. A pending old cancellation is removable metadata only when its retained run has
confirmed exit and no conversation. These checks preserve unknown executions for recovery; they do
not stop processes or replace Core lifecycle verification.

The digest covers the exact inventory and bytes of only `provider-sessions`,
`worker-service/provider-sessions`, `worker-service/runs` and `agent-observations.json`. The helper
refuses linked paths, unknown native layouts, changed reviewed inputs and an existing consumer-format
marker. It removes only those four targets. Connections, credentials, profiles, tasks, workspaces,
cache, owner databases and the stateless cursor key remain intact. A private durable receipt permits
an interrupted deletion to resume with the same UUID and digest; new or changed history blocks
resumption. Planning reports counts and the update-time range for recognized historical `started` or
`unknown` effects, without execution IDs or content, and sets
`requiresUnknownEffectsAcknowledgement`. Apply refuses those histories unless the operator also
supplies `--acknowledge-unknown-effects` after reviewing that exact digest. This confirms deletion
of uncertain outcome evidence; it does not settle, reverse or repeat an external effect. Unknown
metadata shapes, unconfirmed exit and pending callbacks remain blocking even with that flag.
The helper does not inspect or remove a user's host-native SDK directories or claim
account-secret cleanup.

The read-only provider doctor reports startup prerequisites and workload-dependent tools without
installing packages, altering a shell or importing credentials. Startup requires Node.js and npm,
plus executable `/bin/ps` on POSIX hosts or stock Windows PowerShell 5.1 on Windows for native
process-stop verification. The doctor recommends installing Linux procps or restoring the macOS
system utility when `/bin/ps` is missing. Git remains a workspace prerequisite, and project SDKs
remain optional workload tools. Independent source-only provider
releases and selected lock closures are described in the
[repository release model](../repository-release-model/feature.md).

## Testing Expectations

- Core HTTP tests cover an empty/independent app boundary, exact operation/hash/install binding,
  current original authority, task chains, revoked grants, selected tools, pinned skill availability,
  precise lease cleanup and retained Decision metadata without renewed native authority.
- Lease interleaving tests hold real workspace mutation locks to verify direct/MCP acquisition,
  cleanup and individual release. They cover durable closure, replay, cancelled waiters, unrelated
  admissions, revocation recovery, foreign claim replacement and interrupted owned-release records.
  Provider regressions cover transient cleanup failure, lost replies, explicit release confirmation,
  reconstruction, concurrent cleanup and shutdown drain without native replay or snapshot-driven retry.
- SDK fixtures cover exact bytes, response identity, snapshot/replay boundaries, correlated child
  sources, bounded streams, duplicate controls and changed inputs/installations.
- Provider tests cover lazy creation, strict resume, account/configuration compatibility, the fixed
  five-minute parking deadline with a controlled clock, revised next-turn delivery, lost
  admission/cancellation races, interrupted storage, decision delivery, process evidence and stdin
  protocol preservation. Unknown native stop or tool effects keep the slot occupied.
- HTTP/SDK pagination tests enumerate mixed-case session and connection IDs one page at a time,
  requiring complete results, unique cursors and bounded invalid-cursor rejection.
- Native transport fixtures exercise multi-MiB synchronous stdout/stderr, paused consumers,
  notifications before acknowledgments, duplex requests, terminal output drain, stubborn descendants
  and producer crashes. Cancellation fixtures cover rejected/hung interrupts, exact turn identity,
  thread-scoped background cleanup, late correlated command completion after turn termination,
  cleanup ACK/error/missing-result uncertainty,
  finite RPC acknowledgments, active approval waits and shutdown behind an accepted control.
- Claude child-history fixtures cover the SDK's normalized live UUIDs, preserved API message IDs,
  exact native agent/session/parent/input binding, ordered error terminals, missing or ambiguous
  identities, bounded history, metadata changes, native-close barriers and helper deadlines.
- Local packaging tests cover concurrent independent providers, preserved source dependencies,
  cache reuse, source changes, damaged/failed generations and direct-SDK dependency selection.
  CI/release fixtures require a Codex-only SDK pin to leave Claude, Ollama and Harness unselected.
- Cleanup fixtures cover both storage locks, exact inventory digests, changed/linked paths, foreign
  or unsettled execution metadata, interrupted/replayed deletion and preservation of unrelated data.
- Runtime acceptance uses Core-managed apps, normal password/app-code identity, separate test data
  and actual Docker-to-host transport. Native inference and process behavior need the target OS;
  scripted engines and macOS tests do not establish Windows/Linux or paid-provider inference.
- Recorded local build evidence includes all three isolated npm installs/production bundles,
  Core NativeAOT publication on macOS arm64 and .NET SDK tests/net8 compilation. No Windows/Linux
  native execution or live paid SDK inference is established by those build checks. Ordinary-host
  cutover has separate explicit approval and recorded live readiness evidence. Remaining acceptance is tracked in [the implementation plan](plan.md).

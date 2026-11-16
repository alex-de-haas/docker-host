---
status: In Progress
created: 2026-10-10
updated: 2026-11-16
summary: Extract independent local agent-provider apps consumed by Docker-hosted Harness, with explicit discovery, authority, recovery and host-tool readiness.
components: [apps/core, apps/harness, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider, packages/agent-provider-runtime, packages/app-sdk, packages/app-sdk-dotnet]
---

# Independent Local Agent Providers

## Goal And Owner Direction

Extract Codex, Claude Code and Ollama into three independently installed Local applications.
Keep Harness in Docker as the conversation UI and coordinator. An update or restart of Harness
must not terminate an agent owned by another application. Remove the embedded worker image and
its development toolchains from the Harness release after the replacement passes acceptance.

The owner selected three separate applications on 2026-10-28 and clarified Local execution with
Docker-hosted Harness on 2026-11-12. Local means the selected Core host, not necessarily the
browser user's computer; it does not imply offline inference. Each provider owns its SDK/CLI,
connections, credentials, native sessions, pending decisions and process lifecycle. Shared
libraries are acceptable; a shared execution service would couple those lifetimes again.
See [vision decisions 29 and 65](../../vision.md).

On 2026-11-12 the owner prioritizes planning this extraction before
[Nx CI acceleration](../ci-feedback-loop/plan.md). On 2026-11-12 the owner approves the focused first release and requests implementation. This
Ready approval covers the complete extraction and accepted contract. It does not authorize commits,
publication, ordinary-host activation or deleting ordinary session data during development.

Owner approval, 2026-11-13: proceed with the remaining extraction/cancellation work, reduce
redundant CI work without Nx, retain cached provider source setup for this release and make
Harness Docker-only in production with Local development retained. The owner separately authorizes
local runtime tests and necessary application restarts while absent. Disposable environments keep
their own users/data; existing provider credentials are not copied. Publication and commits remain
separate actions.

Owner approval, 2026-11-16: restore the application/code boundaries below by moving native
engine adapters, account integration, settings policy and build metadata into the three provider
applications. The shared runtime accepts explicit implementation contracts and retains only
engine-neutral execution infrastructure. Preserve the public API and existing provider-owned
data formats; verify neutral infrastructure with an unrelated injected engine. This approval
covers implementation and isolated checks, not commits, publication or ordinary-data activation.

Owner approval, 2026-11-16: finish provider release publication, stable-feed promotion and
Marketplace registration, then verify fresh installation through the normal reviewed Core flow.
This continuation includes retiring obsolete embedded-worker dependency-update targets. D11 stays
open until the actual releases, default feeds, catalog deployment and installation checks are verified.

## Accepted Delivery Scope

The recommended first delivery is the complete extraction: three Local providers, Docker Harness,
a narrow public agent contract, clean-slate cutover, host diagnostics and retirement of embedded execution.
Owner confirmation, 2026-11-12: keep all three applications in this monorepo. They retain
independent versions, source inputs and releases; shared location does not couple runtime lifetime.

The owner explicitly defers the general model-generation/structured-JSON product scenario and a
real second application's integration to the separate [generation consumer plan](../agent-generation-consumer/plan.md).
The extraction still supplies a consumer-neutral API and verifies an independently named consumer
without Harness; it does not ship that second product feature or a new general inference protocol.

Do not add another provider vendor, a scheduler, cross-provider session transfer, rolling provider
generations, an Ollama server installer or a replacement protocol for external agent clients.
Owner direction, 2026-11-13: Docker is the only production Harness runtime. Retain Local source
execution for development, with an explicit development profile, rather than a second production
distribution. Remove the production Local profile and release selection in D11; preserve the
supported development workflow and Return to an already installed package. This does not switch
the current ordinary installation or remove its data. Other apps' Docker support and Core
sandboxes remain intact.

## Baseline And Required Behavioral Changes

Implementation baseline: `ce7c7dbd12b50e0fda913ce00c418ce9ef72a2c0`. The registered branch was
fast-forwarded from `d42c57de` without a new commit, preserving the planning documents. Recheck
integration changes and then-current versions before final verification/publication.

| Current behavior | Target behavior |
| --- | --- |
| Harness owns one worker service for all engines | Three installed apps own separate native execution lifetimes |
| Worker needs Harness coordinator callbacks for readiness and secrets | Provider startup and admitted execution do not require a running Harness |
| Connections and credentials belong to Harness | Each provider owns its connections and app-scoped secrets; Harness stores qualified selections |
| Worker request imports private Harness types and vendor names | SDK contract uses provider-neutral DTOs and declared capabilities |
| Native MCP proxy/renewal and decisions depend on Harness | Provider owns execution-side renewal and pending decisions under the original user's authority |
| Native worker listens on loopback | Authenticated provider endpoint is reachable from supported Docker consumers |
| Harness and web install vendor packages; release builds a worker toolchain image | Only provider apps install pinned vendor dependencies; Harness publishes its API/UI image |

The worker is more than an SDK wrapper: it currently owns acceptance journals, replay,
cancellation, approvals, native account homes and session recovery. Preserve those guarantees
while relocating them. The expensive general-purpose Docker toolchain is a packaging choice,
not a required part of the provider interface.

Use the [worker-service feature](../assistant-shared-docker-runtime/feature.md) as the current
behavioral baseline. Its [remaining acceptance](../assistant-shared-docker-runtime/plan.md)
must be reconciled against verified replacement behavior; deleting a Dockerfile does not close it.

## Application And Code Boundaries

Proposed directory names are packaging choices, not identifiers for Core discovery:

| Owner | Responsibilities |
| --- | --- |
| `apps/codex-provider` | Codex app-server adapter, pinned executable, login/refresh, models/usage, connection revisions, native homes and histories |
| `apps/claude-code-provider` | Claude adapter/SDK and platform executable, account configuration, models/usage, native session state |
| `apps/ollama-provider` | Existing Hosty tool loop, configured inference endpoint, model discovery, context/compaction and effect receipts |
| Proposed `packages/agent-provider-runtime` | Instantiated journal, HTTP/SSE validation and process helpers; no shared daemon, registry or storage |
| App SDKs | Public identities, DTOs, consumer client, request validation and capability negotiation |
| Core | Generic app lifecycle, declared provider discovery, current authority and resource references |
| Harness | Conversations/transcripts, composition, tasks, user interface and mappings to provider-owned sessions/runs |

Each provider needs its own manifest, version, data/cache roots, secrets, native process owner
and source release inputs. A shared code update can rebuild affected providers; a Harness UI edit
must not invalidate all three. The Ollama app calls an existing explicitly configured endpoint;
it does not install/start an inference daemon, download models or own model storage. Provider
updates initially require the operator to finish/stop active work before applying the ordinary
Core update. No new generic Core drain/preflight feature is required for this extraction, and no
automatic busy-run protection is claimed. Rolling native-process upgrades are outside scope.
Subsequent provider updates preserve that provider's new configuration, native sessions and history;
the clean-slate transition below is a one-time legacy cutover, not an update policy. App release
versions and wire API versions are separate. Compatible adapter/engine fixes or dependency updates
can ship in the affected provider without a Harness release. Harness UI/business changes must not
rebuild/update providers when their public contract and shared dependency inputs are unchanged.

Move connection creation, login, account changes and deletion into provider-owned authenticated
settings. Reuse UI components where useful, without requiring Harness to be installed. Harness
discovers accessible connections and selects opaque handles/models. Initially guide the operator
to the provider's declared Shell Settings entry: current cross-app navigation resolution is
host-only, so a working Harness Configure deep link is not assumed. Do not proxy credentials
through Harness or hard-code another app's settings route. Harness preferences, profiles and
business-task ownership stay there. Keep its selected installation/connection/revision explicit;
a provider default change must not switch an existing conversation. Empty discovery provides
setup guidance; a Harness update does not automatically install provider applications.

Owner decision, 2026-11-13: remove agent-backed translation from this release. Harness and the
Codex/Claude provider apps do not advertise or implement translation, and Harness has no translation
settings. The independent OPUS application remains the distribution's translation supplier through
the generic Core/SDK contract. A configurable agent-backed translation application is outside this
release; no hidden native translation implementation remains in Harness or the agent providers.

### Consumer-Owned Task Workflow

Harness task reporting and coordination use an optional, explicitly admitted business channel.
The consumer binds its declared task-executor installation/interface and logical conversation to
one public provider session/run through `ceiling.workflow`, with a fixed task-tool subset and
per-tool policy. Current `providers.task-executor` permission and the reviewed `session-workflow`
capability are required. The provider exposes only those consumer workflow tools to its native
engine and forwards bounded actions through Core's execution-authorized JSON API. Core preserves
the original user/task attempt and mediates an exact signed request to the consumer's public
`/sessions/{id}/workflow` task-executor operation. The consumer validates its current public run
mapping and retains exact mutation UUID/input receipts. Tool acknowledgements return before any
asynchronous stop/barrier, and uncertain responses recover the same request.

This channel does not enable general Core MCP, mint a Core MCP target token, synthesize a grant or
remove existing MCP origin checks. Ordinary configured Core/app MCP keeps its separate current
grants and policies. Workflow Disabled/Ask rules apply before native business effects; absence of
a workflow binding exposes no consumer callbacks. A caller with no skills, MCP or workflow can
still execute a plain independent agent request. Task-bound runs fail with actionable setup
information when their reviewed workflow permission or required tool selection is unavailable.

## Independent Consumers And Optional Execution Configuration

Owner clarification, 2026-11-12: agent providers serve Harness and independently implemented
applications. They must start, configure accounts and execute an authorized request with no Harness
installation or callbacks. Consumers request provider access through standard Core app permissions
and preserve the acting user's current authority where required.

The invocation contract supports optional bounded instructions/system-prompt additions, selected
skills or authorized skill references, and MCP configuration/authorized target references. An app
can submit a simple request with no skills or MCP servers, or explicitly select the subset its
workflow needs. Define precedence, lifetime and supported resume-time changes in D2. Consumer
configuration cannot replace platform/provider policy, grant access to an arbitrary host path or
turn a bearer credential embedded in prompt text into authority. Unsupported requested features
return explicit errors rather than loading Harness defaults or silently expanding the tool set.

Harness resolves its own profiles and passes neutral configuration. Public requests must not need
Harness profile IDs, its private database/routes, its default workflow prompt or a mandatory
conversation/task. Core controls access to its configured MCP resources; the provider executes
under reviewed caller/user delegation, not the Harness service identity. Consumers own their
configuration UI. The storage/management UI for Core skills is a separate design discussion;
this extraction does not build a new skill catalogue, authoring or management feature.

## Proposed Storage And Native Session Boundary

Distinguish the installed provider app, its account/connection, a consumer conversation, a native
engine session and one execution run/turn. One app and connection can own many native sessions.
A blank consumer chat need not allocate native state until its first invocation. The consumer
stores its selected qualified provider/connection/session reference; a process PID is not that ID.

The target ownership proposal is:

| Owner | Stored state |
| --- | --- |
| Consumer, including Harness | Its conversation/transcript, business records and qualified provider session/run mappings |
| Agent provider | Account configuration/secrets, SDK-native durable histories, run/control journals, replay, pending native decisions and native process ownership |
| Core | Generic discovery, authority/resource references, consent and coordination metadata; source-backed history API, not another authoritative native context/transcript |

Codex/Claude can resume a saved native engine session after process restart when its files,
connection/account and context are compatible. Their native session is not a permanent in-memory
LLM context or a filesystem snapshot. The SDK reconstructs the model's bounded working context;
compaction can retain a summary instead of every past token. Current worker-backed turns generally
start a new native process and resume the saved ID; normal requests do not resend the Harness UI
transcript. Selected instructions/tool configuration still accompany execution.

Ollama's agent loop/state is Hosty-owned: it persists messages, summary and effect receipts and
sends bounded messages to the inference endpoint for each model call. An Ollama inference server's
model residency/cache is not the durable conversation session.

These ownership boundaries guide the design. The accepted provider execution API below defines execution
semantics; exact public-history/retention and purge ownership remain D3 storage work. Do not promise identical native resume behavior
for every engine, recreate missing context silently or move a consumer's private transcript into Core.
New provider data must survive ordinary app/server restart and later compatible updates; an active
run interrupted by a crash is distinct from resuming the next turn of its saved session.

## Protocol Decision And Reviewed Alternatives (2026-11-12)

Distinguish the public **Harness-to-provider network interface** from the private **provider-to-engine
adapter**. Choosing ACP for a subprocess does not establish a Docker-to-host service or a durable
execution owner. A protocol, client SDK and ready provider runtime are different deliverables.

This comparison is design research against the published specifications below, not a runnable
compatibility or performance test. Protocol/package release numbers do not imply the same wire
version; pin the actual negotiated schema, SDK and implementation before adoption.

| Candidate | Useful existing contract | Remaining work and fit |
| --- | --- | --- |
| Narrow Hosty HTTP JSON/SSE | Reuses current run/control journals, receipts and direct worker transport | Extract neutral SDK DTOs and implement public authority/discovery; Hosty maintains the interface and client |
| AHP, released spec 1.0.0 | Stateful agent sessions, messages/tool confirmations, input requests, sequenced actions, replay/snapshot reconnect and client SDKs | A strong alternative for the public session interface; map Hosty execution state without replacing its persisted model, and define the Hosty authority/admission/control profile |
| ACP v1 | Coding-agent sessions, streamed tool/message updates, permissions, model/config choices; existing Codex and Claude adapters | Standard v1 transport is stdio; custom transport is permitted, remote HTTP/WebSocket is still an RFD and v2 is Draft. Best first candidate inside a provider app, not a complete network-hosting solution |
| A2A 1.0.1 | Network task/context model, artifacts, input-required/auth-required, subscriptions/cancel and client/server SDKs | Viable for interoperable task delegation. Requires a Hosty profile for mandatory admission deduplication, retained replay, precise decisions and native stop evidence; production TLS is required |
| AG-UI 1.0 | Standard run/message/tool/state events and interrupt/resume representation | Useful UI/event projection. Default HTTP/SSE explicitly has no stream resumption; interrupt answers start a new run. It is not the full durable provider lifecycle |
| MCP 2026-07-28 plus Tasks extension | Tool invocation; durable asynchronous task handles with get/update/cancel and pending input | Suitable for exposing an agent as a tool. Account/model/native-session and rich coding events still need an app contract; current transport has no session/replay semantics |

AHP is a serious ready protocol candidate, not merely the older proposal considered in September.
Its released reconnect/state model covers real requirements that a custom interface must implement.
At release commit `5f16d81bb7045b66d7bc768d244feab75002d943`, the wire version is 1.0.0
with 0.9.0 also supported; older 0.3.0 values in lifecycle examples are not the release baseline.
Root/session/chat are stable; optional MCP/changeset/automation channels have separate maturity.
It does not turn an action acknowledgment into a Hosty durable admission receipt, ensure native
writers exited, renew Core grants or migrate existing account/session ownership. Client SDKs and
reducers are reusable; they are not a standalone Hosty provider runtime. Do not describe a listed
third-party AHP host/gateway as a Microsoft drop-in execution service. AHP active-turn input
requests also need a mapping for Hosty asynchronous Shared Decisions that continue a later
native turn; preserving the question UI alone does not establish that continuation.

ACP's Codex/Claude adapters are reusable ecosystem projects wrapping the native engines. Their
package versions are not ACP protocol versions, and wrapping an official engine does not make the
adapter vendor-maintained. Evaluate replacing a native adapter separately: extraction need not
also rewrite all three engine integrations. Keep any persistent ACP client/process inside the
provider, so Harness disconnect does not close that engine connection.

**Owner decision, 2026-11-12:** use the Hosty HTTP JSON/SSE execution API for the extraction,
with an OpenAPI-described HTTP surface, versioned event schemas and a shared SDK client. Commands
use ordinary authenticated HTTP requests; observation uses replayable SSE. Keep network encryption
and local listener topology explicit in D3; choosing SSE does not itself select TLS termination.
Reuse existing execution mechanisms and native adapters.

AHP may later be added as an alternative client protocol **above this API**, not as a replacement
execution runtime. An AHP adapter translates inbound commands into the same Hosty operations and
projects snapshots/actions from the same status and event stream. A separate adapter can use the
public HTTP/SSE client; an in-process adapter can call the same permission-checked application
services directly. Both paths share run/control IDs, authorization, journals, decisions, native
sessions and process ownership. Protocol cursor/mapping caches do not become a second editable
transcript or an independent execution authority. Replacing or disabling AHP leaves Hosty API
clients usable.

The [existing AHP plan](../assistant-ahp/plan.md) owns the optional external projection of Harness
conversations. A provider-facing AHP adapter would expose provider-owned sessions/runs instead;
it does not automatically expose Harness conversations, profiles or task coordination. These are
possible adapter boundaries, not a requirement to implement both in this extraction. Generic AHP
clients get the supported standard surface; Hosty-specific controls require declared capabilities
and current authority. AHP delivery remains separate tracked work, not a dependency here.

The accepted D2 design covers seven examples: a new turn and lost receipt,
a delayed approval, an asynchronous question answered in a later turn, Harness restart during
tool-authority renewal, an expired replay cursor, provider crash with uncertain child stop, and
cancel with a lost response. Retain stable qualified session/run/turn/tool/decision identities,
revisions, snapshots, replay cursors and idempotent commands so an adapter can reuse these semantics.
The owner has accepted this protocol and approved implementation of the focused extraction.

### Primary Sources Checked

- [AHP spec 1.0.0 release snapshot](https://github.com/microsoft/agent-host-protocol/tree/5f16d81bb7045b66d7bc768d244feab75002d943),
  [connection/reconnect lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle)
  and [protocol/client repository](https://github.com/microsoft/agent-host-protocol).
- [ACP v1 transports](https://agentclientprotocol.com/protocol/v1/transports),
  [remote transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport),
  [v2 Draft session lifecycle](https://agentclientprotocol.com/protocol/v2/session-setup),
  [Codex adapter v2.6.0](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/README.md)
  and [Claude adapter v0.106.0](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.106.0/README.md).
- [A2A 1.0.1 specification](https://a2a-protocol.org/v1.0.1/specification/) and
  [JavaScript SDK v1.3.0](https://github.com/a2aproject/a2a-js/tree/v1.3.0).
- [AG-UI HTTP/SSE](https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse) and
  [interrupt/resume](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume).
- [MCP 2026-07-28 changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and
  [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and
  [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server): native
  engine integration, not a common Claude/Ollama provider contract. Preserve its pinned supported
  transport instead of assuming the upstream experimental network listener is the Hosty app API.

## Accepted Provider Execution API v1 Contract

Owner acceptance, 2026-11-12: the execution v1 contract below is accepted. D2 design is complete;
this acceptance is design evidence, not runtime evidence. The owner subsequently approves the
focused extraction implementation and transfers the second-app product scope to its own plan. The declared interface base is illustrated as `/api/agent/v1`; consumers use the
current Core descriptor rather than construct another app's URL. JSON requests use UTF-8 and
`application/json`; streams use `text/event-stream`. Publish OpenAPI plus versioned event schemas
and the server-side SDK client. Provider app release versions are independent of API major version.

### Identities, Ownership And Admission

- `ProviderRef = { appId, installationId, key }` follows the existing SDK reference shape. Public
  session/run IDs are opaque provider handles, not Codex thread IDs, Claude IDs, paths or PIDs.
- A **session** is durable provider-owned metadata/configuration and, after first execution, a
  mapping to native state. A **run** is one accepted input/turn and its tool/child-agent work.
  Neither requires a Harness conversation or business task.
- Session creation binds the initiating Core user/principal and consumer installation, provider
  installation and connection/revision. Another consumer cannot resume it just by learning its ID.
  Existing separately authorized Core observation/control remains a distinct access path.
- Every operation uses fresh Core authorization. Verify the method, target, actual body digest,
  current installations/grants and actor at the provider. User/principal/service credentials are
  not accepted as identity fields in request JSON. Account secrets never go to a consumer.
- Consumer-generated UUIDs make creation/submission recoverable after a lost response. Immutable
  start bodies are hashed as exact UTF-8 bytes; SDK retries retain those bytes. Renewable HTTP
  credentials are outside this digest. Different bytes with the same mutation ID conflict.
- Authorize access, then look up the prior durable receipt **before** fresh revision/busy checks.
  An identical retry returns its original admission/control outcome plus a current resource link;
  it never creates another native turn. Preserve compact deduplication tombstones after replay ends.
- Persist admission and reserve the session/connection slot atomically before native execution.
  Confirm that accepted run/digest/configuration binding to Core using the provider's own identity
  before the first native effect or delegated token issuance. Reconcile confirmation by the same
  admission reference after a lost reply; Core stores metadata, not prompt/skill content.
  An unavailable confirmation path leaves preparation pending/fails safely; it does not execute.
  One active or unconfirmed run per session; return `409 session_busy`/`429 capacity_exceeded`
  for another run. There is no implicit queue or scheduled retry. Reserve control/stop capacity
  independently from output capacity so a full replay buffer cannot prevent cancellation.

### Routes

All paths are relative to the declared interface base. Lists are authorized and cursor-paginated;
v1 default page size is 50, maximum 100. Session/run/control reads are `Cache-Control: no-store`.

| Method and route | Result |
| --- | --- |
| `GET /capabilities` | API/event versions, supported features, reconfiguration rules and actual limits |
| `GET /connections` | Accessible opaque connection IDs/revisions/readiness; no credentials or native paths |
| `GET /connections/{id}/models` | Revisioned catalog, opaque model IDs and supported effort/options |
| `PUT /sessions/{sessionId}` | Idempotently create durable metadata and pin initial configuration |
| `GET /sessions/{sessionId}` | Current session/configuration, native availability and active run reference |
| `GET /sessions` | Caller-owned session inventory; optional authorized correlation filter |
| `PUT /sessions/{sessionId}/configurations/{configurationId}` | Idempotently create/activate a compatible immutable configuration while idle |
| `PUT /sessions/{sessionId}/runs/{runId}` | Admit a first or continuing turn; return a durable receipt before completion |
| `GET /runs/{runId}` | Atomic receipt/snapshot, pending decisions, stop/effect evidence and replay watermark |
| `GET /runs/{runId}/events` | Replay after a cursor, then follow the same run live |
| `POST /runs/{runId}/responses` | Durably answer one exact pending approval/question |
| `POST /runs/{runId}/cancel` | Durably request cancellation, including a defined delayed-start fence |
| `GET /runs/{runId}/controls/{requestId}` | Reconcile the retained outcome of a response/cancel command |

Capability names are versioned SDK constants. At minimum report `session.resume`,
`configuration.resume-compatible` (field names), `input.images`, `native-tools.none`,
`skills.catalog`, `skills.exclusive-selection`, `mcp.core`, `mcp.external`, `model.change-on-resume`,
`decisions.next-turn` and native-subagent policy/observation coverage. Missing optional capabilities
mean unsupported. The model catalog may narrow them; the effective set is checked for the selected
connection/model. Session/run requests can supply `requiredCapabilities: ["<capability>"]`;
refuse admission if any are unavailable rather than silently degrading the request.

`PUT /sessions` succeeds with `201` after metadata/configuration is durable; it starts no native
process, inference or login. First run admission uses `202`; a retry returns the prior receipt
with `200`. Rejected capacity/revision/configuration requests start nothing. A client changing a
rejected request deliberately uses a new mutation ID. A lost response is not a rejected request.

### Session Creation And Configuration

Illustrative request; strings in angle brackets stand for real qualified/opaque identifiers:

```json
{
  "configuration": {
    "connection": { "id": "<connection-id>", "revision": "3" },
    "instructions": [ { "id": "workflow", "text": "Explain changes and verify the affected behavior." } ],
    "systemPrompt": { "mode": "append", "text": "You assist this application's users." },
    "skills": [ { "skillId": "<core-skill-id>", "expectedDigest": "<optional-package-digest>" } ],
    "nativeTools": "provider_default",
    "subagents": { "enabled": false }
  },
  "correlation": {
    "conversation": { "provider": { "appId": "<caller-app>", "installationId": "<installation>", "key": "history" }, "id": "<conversation-id>" }
  }
}
```

Only `configuration.connection` is required. Omitted instructions/skills mean empty selections;
omitted system prompt adds no consumer text. No Harness workflow/profile is loaded implicitly.
Native tools default to the selected provider's explicitly reported policy; callers can require
`nativeTools: "none"` only when the provider can actually enforce it. An unsupported restriction
is rejected, not ignored. `subagents` omission uses the provider's reported default; a required
on/off/concurrency policy needs an enforceable advertised capability.

The response contains `ref`, `revision: "1"`, `configurationRevision: "1"`, `configurationDigest`,
resolved skill package digests, `nativeState: "not_created"`, and `activeRun: null`. Configuration
contains no service/user bearer or account secret. Sensitive configuration reads require the same
owning authority; a generic inventory returns bounded metadata, not instruction bodies.

The provider's non-overridable policy and native preset precede consumer configuration. Consumer
instructions cannot label themselves trusted platform/runtime input. In baseline v1, `systemPrompt`
is an addition to the native preset, not a promise to replace it. A later provider capability can
offer preset replacement while retaining policy enforcement; unsupported modes fail explicitly.

Instruction order is stable and recorded: provider policy/native preset, consumer system addition,
consumer standing instructions, selected native skill catalog, then the new run input/facts.
Skills use the engine's declared discovery/invocation semantics; listing a skill does not promise
its whole content is inserted on every model call. Task/context text is untrusted application input,
not another authority tier. Exact native role mapping is a provider capability, not a false promise
that all three SDKs have identical prompt hierarchy.

Standing instructions, selected skill bytes, connection revision and native execution profile are
pinned by configuration revision. `PUT .../configurations/{configurationId}` includes a stable
`requestId` equal to the path ID, `expectedSessionRevision` and the **complete replacement**
`configuration`. Omission clears an optional selection; it does not inherit hidden old fields.
The same configuration ID/body is deduplicated before revision checks. Initial revision is 1;
successful changes allocate the next decimal revision and report requested/effective digests.

Activation requires no active/unconfirmed run. Validation here uses metadata/catalogs, not native
startup, resume or MCP process initialization. An initialized session can never change connection
ID, connection revision or verified account identity through configuration replacement; return
`connection_changed`/`requires_new_session` and retain the old mapping. The provider checks native compatibility before
changing the current revision: rejected changes leave the old state untouched. After native
initialization, instructions/skills/profile changes require `configuration.resume-compatible` for
that exact field; otherwise return `409 requires_new_session`. V1 providers may reject all such
changes after initialization. In particular, sending another Claude prompt append does not prove
the persisted native prompt changed. No implicit compaction, new native session, fork or transcript
reconstruction is used to make a configuration change appear successful.

Model/effort and authorized MCP selection are explicit per-run fields below. Their supported
between-turn changes are advertised separately. The provider validates compatibility before admission, then applies the selected set only after
durable admission under `phase: preparing`, possibly using a replacement process with strict native
resume. Desired configuration revision and native-applied configuration revision are reported
separately until preparation succeeds. Earlier tool results
remain history even when the next run's tools/authority change.

### Skill Delivery And MCP Selection

Core skill IDs are references, not host paths, immutable hashes or transferable export grants.
Resolve them under the consumer's Core access and materialize a **provider-owned immutable
configuration snapshot**. Record package content digests; an optional `expectedDigest` mismatch
returns `409 skill_changed`. Keep that snapshot for compatible session continuation. A library
update does not silently change an established session's selected bytes; selecting updated bytes
requires a new configuration and the same compatibility check.

This requires extending current Core delivery: existing exports are app-owned and can be rebuilt
on library updates. Passing a Harness export ID to the provider grants nothing and does not pin
content. Snapshot pinning does not retain revoked authority to read/use a package. Normal Core
skill management remains outside the invocation API. Inline instructions cover caller-owned simple
guidance in v1; arbitrary skill archive upload/catalogue management is not introduced here.

Each run may specify the complete MCP selection:

```json
{
  "mcp": {
    "targets": [
      { "target": { "kind": "core" }, "tools": ["workspace_list", "workspace_get"] },
      { "target": { "kind": "app", "appId": "<app-id>", "installationId": "<installation>", "key": "default" } }
    ],
    "connections": [ { "id": "<optional-provider-owned-external-mcp-connection>", "revision": "2" } ]
  }
}
```

Omitted/empty MCP selects none. Native profile/project configuration must not silently add
unselected MCP servers. Selected-only skill exports must not silently expose additional ambient
skill packages; providers declare any unavoidable native discovery and reject a required exclusive
selection they cannot enforce. Provider-owned policy/native instructions remain separate from
consumer-selected skills. An omitted `tools` filter means the currently authorized catalog
for that selected target; an empty filter selects no tools. Filters narrow availability, never
grant access. Core targets are logical references, not Core API URLs. App targets are installation-
qualified and must still be current. External `connections` are optional capability-gated handles
configured in the provider's own settings/secret store, not raw per-request URLs/headers/env/commands.
External handles additionally require current owner/user/consumer access and exact revision checks;
`providers.agent` alone does not lend the operator's external credentials to another application.
Revoked/changed connections fence subsequent dispatch. A provider without external-MCP support rejects that field. No automatic server installation occurs.

Core checks the originating app/user, provider admission, target relationship/exclusions and tool
permissions. Enforce selected tool filters on actual dispatch, including cached tool names, delayed
approvals and native children; catalog omission alone is insufficient. The provider owns its per-session proxy and obtains short-lived target credentials
from Core at dispatch, rechecking after a delayed approval. It cannot forward Harness's app/user
bearer or use its own administrator as substitute. An MCP-disabled request remains valid; optional
MCP does not require a Harness installation or private callback. Current assistant/task-only minting
must be extended generically for admitted agent runs; the new apps must not pretend to be Harness.

### First And Continuing Runs

```json
{
  "expectedSessionRevision": "1",
  "configurationRevision": "1",
  "continuation": "start",
  "input": {
    "text": "Inspect the selected workspace and explain the failing build.",
    "attachments": []
  },
  "context": [ { "id": "current-selection", "text": "The user selected the release job." } ],
  "selection": { "model": "<model-id>", "reasoningEffort": null },
  "resources": [ { "kind": "workspace", "id": "<core-workspace-id>", "revision": "<source-revision>" } ],
  "mcp": { "targets": [] },
  "limits": { "maxDurationMs": 900000 }
}
```

`continuation` is required: `start` is allowed only before native initialization; subsequent runs
use `resume` with the same public session handle. The provider alone resolves that handle to native
state. A native/account/resource mismatch or missing native state returns `native_session_missing`,
`connection_changed`, `resource_rebind_required` or `resume_incompatible`. Never substitute a new
empty session or replay the consumer transcript. Failed initialization that may have produced
native effects leaves the session blocked until its outcome/stop is reconciled.

`input` is exactly one of nonempty `text` (with optional attachments) or a
`decisionResponseRef: { runId, requestId }` for the reserved next-turn continuation described below.
The latter resolves the provider's durable answer; it is not caller-supplied tool output. Context/attachments/resources are optional bounded data;
resources are Core-qualified context references, not filesystem grants or a collection allowlist.
An attachment is an authorized immutable reference with digest/size/media type, resolved by its
owner's supported contract; arbitrary download URLs/native paths are not accepted. An unavailable
attachment fails before admission; no silently omitted input. Images/files require declared support.
Attachment transport/owner resolution must reuse shipped contracts or be explicitly added in D2;
the first interoperable minimum is text input, without pretending every engine supports images.

`selection` may use null/default choices; receipt reports both requested and effective values.
Unavailable models/efforts and required capabilities fail explicitly, with no vendor/cloud/model
fallback. Optional model/effort changes on resume require a declared compatible option. Current
facts and new input enter this run; they can remain in native history and are not erasable ephemeral
system instructions. Standing instructions are the session configuration, not this context field.

Freeze the accepted authorization ceiling: originating actor/consumer/provider installations,
session/configuration digest, requested MCP target/tool subset, resource references, external
connection revisions and deadline. Renewal can narrow that ceiling, never expand it from later
configuration or broader current app grants.

Run authority has an absolute `expiresAt` bounded by the Core-approved origin authority and requested
deadline. Renewal uses the provider's own identity plus the accepted run reference, revalidates the
original actor/grants and cannot extend beyond approved origin validity or convert interactive work
into a background grant. A restart/disconnect of Harness alone is not revocation. Control/reconnect
credentials have separate short TTLs; they do not determine the accepted run's lifetime.

### Receipts, State And Snapshots

Reuse the existing seven `agent-sessions` summary states: `queued`, `running`, `waiting_for_input`,
`succeeded`, `failed`, `cancelled`, `unknown`. `queued` means durably admitted/preparing for immediate
execution, not a general queue. Additional `phase` values are `preparing`, `executing`, `waiting`,
`finalizing`, `cancelling`, `parked`, `interrupted`, `terminal`. A snapshot also carries:

```json
{
  "ref": { "provider": { "appId": "<provider>", "installationId": "<installation>", "key": "default" }, "id": "<run-id>" },
  "sessionId": "<session-id>",
  "generation": "<stable-attempt-uuid>",
  "revision": "4",
  "state": "running",
  "phase": "finalizing",
  "stopConfirmed": false,
  "freshness": "current",
  "observedAt": "2026-11-12T15:00:00Z",
  "configurationRevision": "1",
  "lastSequence": "18",
  "cursor": "<opaque-watermark>",
  "result": { "status": "succeeded", "messageId": "<message-id>" },
  "pending": [],
  "effects": { "certainty": "known", "unresolvedCallIds": [] }
}
```

`generation` is stable for this execution attempt, including provider restarts; it is not the
provider boot ID. Counters/revisions are decimal strings. Event `sequence` advances on every
persisted event. Control `revision` changes for lifecycle/pending-decision/configuration/stop
changes, not routine text deltas, so streaming text cannot continuously stale a valid approval. Every
public lifecycle/decision/control/stop mutation atomically appends its corresponding event and
advances the snapshot watermark; a control-only change cannot be invisible to SSE followers.

A model answer/result is distinct from terminal execution and confirmed native stop. Final
`succeeded`/`failed`/`cancelled` is published after required cleanup is confirmed; until then keep
the answer under `result` with `phase: finalizing`/`cancelling`. Uncertain stop uses `unknown` and
retains the session/account/capacity/workspace claims. Stopping cannot turn an unknown past tool
effect into a known result. A parked native segment does not complete a consumer's business task.

`GET /runs/{id}` returns one atomic snapshot and watermark S. Pending decision records, full
message/tool block identities, result and uncertain effects correspond to S. Native-private
history, credentials and hidden model reasoning are not required snapshot fields. Detailed output
can be bounded with authorized retained references; never pretend a truncated snapshot is the full
native context. Public native-session observation reuses qualified SDK refs; it reveals no raw SDK ID.

Optional `latestContext: { sequence, usage }` retains the latest root context-usage observation.
Its sequence is the original positive canonical decimal `context.updated` event sequence, no
greater than `lastSequence`; usage is a finite JSON object or explicit null to clear the previous
measurement. An absent field preserves compatibility with providers that supply no observation.
Snapshots and live events share that sequence identity. Restoring the latest observation does
not promise replay of every intermediate offline measurement or initiate model inference.

### SSE Event Envelope And Replay

```text
id: <opaque-cursor>
event: agent
data: {"schemaVersion":"agent-event.1","runId":"<run>","generation":"<attempt>","sequence":"19","revision":"4","occurredAt":"2026-11-12T15:00:01Z","type":"message.delta","source":{"agentId":"<root>"},"data":{"messageId":"<message>","text":"The build fails because…"}}

```

Common events are `run.updated`, `session.bound`, `selection.updated`, `message.started`,
`message.delta`, `message.completed`, `tool.started`, `tool.output`, `tool.completed`,
`decision.requested`, `decision.updated`, `decision.resolved`, `control.updated`, `result.available`, `usage.updated`,
`context.updated`, `agent.updated` and `warning`. Namespaced optional `extension` events cannot
carry indispensable lifecycle/authorization semantics. Unknown required event versions fail
negotiation; ignorable extensions remain ignorable. No private Harness event DTO is public wire data.

Persist before delivery. Replay after S is strictly greater than S and transitions to live delivery
without a gap. The SDK uses authenticated fetch streaming, not a browser EventSource carrying app
credentials. `after=<cursor>` and `Last-Event-ID` are equivalent; conflicting values return 400.
Reconnect obtains a fresh operation credential, with no token in a URL. Delivery is at least once;
deduplicate by provider installation/run/generation/sequence, with stable message/tool/decision IDs.
SSE comments are transport heartbeats, have no event ID and do not advance domain state.

Expired cursors return `410 replay_expired` before opening SSE, with the current snapshot/replacement
cursor and retained range. Install that snapshot as replacement state, then follow after its cursor;
never render it as replayed tool effects or answer old decisions again. A live slow observer may be
disconnected and resync; it cannot stall native execution indefinitely. Stream close, credential
expiry or browser/API restart does not mean cancellation. Revalidate stream access and disconnect
on revocation; refreshing transport access cannot revive revoked execution authority.

Usage events are cumulative snapshots with explicit scope/coverage. Root totals state whether they
include children; do not sum child measurements into an already inclusive total or count replay twice.
Absent per-call/cache/cost observations remain unavailable, not zero. `result.available` describes
the complete result; optional schema-constrained output is validated before claiming valid JSON.

### Native Subagents

Codex's native engine can delegate through App Server; this does not require a public client-driven
spawn API. V1 negotiates `subagents.native`, observable coverage and enforceable policy controls.
Every child event carries `source: { agentId, parentAgentId, parentToolCallId? }`; root uses only
`agentId`. IDs are provider-qualified opaque execution-node handles. Tool/message/decision IDs
are unique within the run, including children. Child status appears in `agent.updated` and snapshots.
Partial/summary observability is declared honestly; the engine's support alone does not establish
the adapter's capability. Current Codex mapping drops child-thread notifications and needs work.

Children inherit the run's actor/authority/budget boundary; they create no new business task,
principal or grant. Root cancel/finalization accounts for native child work and known writers before
`stopConfirmed`. A parent answer, root `turn/interrupt` or app-server exit alone is not proof that
all descendants stopped. Client-driven child creation/messaging/control is a separate later API;
v1 does not add `/spawn-agent` or promise cross-provider native session transfer.

### Pending Responses And Cancellation

```json
{
  "requestId": "<control-uuid>",
  "expectedGeneration": "<attempt-uuid>",
  "expectedRevision": "4",
  "decisionId": "<pending-decision-id>",
  "decisionRevision": "1",
  "response": { "kind": "approval", "decision": "deny", "message": "Do not change this file." }
}
```

A question response instead supplies `kind: question` and answers keyed by the declared question
IDs/schema. Responses must match one pending record and its revision. They cannot inject arbitrary
tool results, select an unrelated native callback or create authority. Decisions declare
`delivery: continue_run | next_turn`. The former resolves one live callback in the current run.
The latter persists an asynchronous answer and atomically reserves exactly one **new**
`continuationRunId`/RunRef in the response receipt; the original run may remain terminal.

That continuation owns a normal session slot, configuration, resources and deadline. It never
reuses the original run ID. The provider may admit it autonomously only when Core confirms bounded
derived continuation authority under the original accepted ceiling/deadline/budget and the slot
is available. The visible receipt reports `pending`, `awaiting_authorization`, `admitted` or
`superseded` and the reserved reference; this explicit decision continuation is not a general run
queue. No callback that already returned is invoked again.

If authority has expired, the original consumer/user can obtain fresh Core authorization and use
`PUT /sessions/{sessionId}/runs/{continuationRunId}` with `continuation: resume`, current revisions,
resources/limits and `input: { decisionResponseRef: { runId, requestId } }`. This admits only the
reserved continuation and revalidates access to the answer/native context. Same-ID uncertainty is
reconciled normally; a concurrent already-admitted continuation is returned/conflicts without a
second execution. Retrying the response itself only returns its receipt, not another native turn.
The same provider/Core path can process Shared Decision answers while Harness is absent.

Control receipts use `accepted`, `applied`, `rejected`, `superseded`, `unknown`, plus current run
reference/revision and optional continuation/error. Persist control intent before delivery. An
uncertain native callback outcome is `unknown`, not permission to invoke it again. GET control
lookup reconciles the same request ID; changing its payload/revision requires a deliberate new ID.

Cancel body contains `requestId`, `expectedGeneration`, `expectedRevision`; there is no approval
decision to answer first. Serialize cancel with response delivery. Once cancellation commits,
fence new effects, pending continuations and unapplied approvals, including the corresponding
Core admission renewal boundary. Cancelling a source run supersedes its linked continuations
not yet admitted. An already admitted continuation has its own RunRef and must be cancelled there;
return that link rather than silently cancelling a later unrelated turn. An approval applied first is not undone by cancellation.
The response acknowledges intent (`202`); only observed confirmed cleanup yields final cancelled
state. If completion won the race, return its actual result without relabelling it cancelled.

For a lost start response, GET 404 is not proof that a delayed PUT cannot arrive. Retry the original
start bytes/UUID. To abandon it safely, cancel may use `fenceIfNotAdmitted: { sessionId, startDigest }`
with **neither** expected run revision **nor** expected generation; Core authorization must bind the same intended run/session/digest.
Atomically either cancel the exact already admitted owner/session/start-digest match without CAS,
or persist a cancellation tombstone
before admission. A later matching start never executes; a different digest conflicts. No arbitrary
caller can reserve/cancel another owner's UUID. The fence itself has an idempotent control receipt.

After provider restart, unresolved runs/controls retain their identity and become interrupted/unknown;
do not resubmit prompts or assume an in-memory callback survived. Retained pending questions are
observations, not evidence of a live callback. Cleanup/recovery needs actual native stop evidence.
The next normal run is blocked while prior writers remain uncertain.

### Errors, Limits And Compatibility

Errors use `{ error: { code, message, retryable, requestId?, details? } }`. Messages/details contain no
credentials or native-private paths. Use 400 invalid input/cursor, 401 invalid/expired credential,
403 current permission refusal, 404 missing/inaccessible resource, 409 conflict/busy/incompatible
resume, 410 expired replay, 413 payload budget, 422 unsupported capability/schema, 429 capacity and
503 dependency/provider unavailable. Retryable does not authorize replay with another UUID.

Initial managed ceilings: 1 MiB command body, 1 MiB individual event/answer snapshot, 64 MiB retained
event window per run, seven days terminal replay and 10,000 ordinary controls per run.
Reserve a dedicated first cancellation/fence and recovery path outside the ordinary control quota;
coalesce further cancel requests to its canonical receipt instead of consuming unbounded slots. Chunk/reference large
tool output, preserving completeness indicators; never silently discard pending controls/stop state.
Retain compact start/control/cancel tombstones independently from detailed replay. Session/native
retention is separate and survives a replay-window expiry. Advertise the effective limits; schema
limits and capability requirements are enforced before native admission. Requested execution limits
are reductions, not overrides of provider/Core policy; unsupported enforceable budgets are rejected.
Core package validation ceilings apply to skills; report aggregate selected-snapshot bounds explicitly.

Session/native deletion is distinct from a consumer hiding/deleting its chat. Any provider purge
must refuse active/unconfirmed execution, fence future admission first and retain non-content
tombstones so delayed requests cannot recreate deleted state. Detailed purge/retention UI remains
the storage contract work in D3, not an implicit side effect of this run API.

New optional fields/capabilities may be additive in v1; changed required semantics or event meanings
need a new major interface. Unknown request fields are rejected rather than silently changing tool
authority; consumers negotiate named capabilities before using additions. App/API versions, native
engine versions and native-state formats remain distinct. SDK fixtures must prove the seven
recovery examples, empty context, one skill/MCP target, native child observation/cancel and an
unrelated consumer without Harness before the accepted design can be called implemented.


## Authority And Docker-To-Host Transport

### Direct Admission And Renewable Execution Authority

Existing provider credentials last two minutes and do not establish an admitted agent's continuing
Core/MCP authority. Existing exact-operation mediation has useful identity/hash validation but
forwards data through Core; use its mechanisms without its data relay. Current task-dispatch
renewal is tied to real accepted task attempts and cannot be reused unchanged for a conversation.

Implement the metadata-only direct authorization operation specified in the accepted v1 contract: the consumer supplies the selected provider
reference, run/request UUID, operation/method/path, body digest, bounded capability/resource
references and its current user authority. Core returns the current descriptor, a short-lived exact
operation credential and a qualified admission reference. The consumer sends the actual body
directly to the provider. Provider validation binds body digest, route, resource references and
connection/session ownership to that authorization before persisting acceptance.

Core retains only the originating authority reference, caller/user/principal, provider installation,
permission revisions, run/request/digest and bounded grant/expiry metadata needed for revalidation.
The provider retains execution records and obtains scoped MCP/workspace and addressed-Decision
authority directly for that admitted run. It owns the per-session MCP proxy, obtains target-specific
credentials from Core at dispatch and rechecks after a delayed approval; static headers cannot safely renew
an already waiting tool call. Core retains credential signing/issuance. Renewal revalidates the original caller, provider, user, target grants, enabled
relationships/exclusions and resource rights; it cannot substitute the provider's administrator, turn app identity into user authority or create
an indefinite/background grant. Define bounded continuation expiry and exact-binding cleanup/release
authority after revocation. An execution context is not a new agent principal or a general bearer.
Harness restart alone does not revoke a valid admission; expiry/revocation fences new effects and
renewals, with safe park/stop and an honest unknown-stop state when necessary.

Use fresh credentials for control/reconnect operations, separate from the admitted run's lifetime.
Do not pass Harness's user grant or app service token to another installation or native child.
Native processes receive only run-scoped tool credentials and filtered environment. Preserve
existing native execution/admin and collection-level workspace permission rules. No new per-agent
or per-workspace consent layer is introduced. Tool-provider unavailability can park execution;
Harness-owned business tools are not promised to remain available while Harness is down.

### Reachable Native Listener

Use assigned `HOSTY_PORT_<KEY>` ports and current declared transport descriptors. The existing SDK
refreshes endpoints and rewrites host loopback to `host.docker.internal` for a Docker consumer;
Core supplies its generic Docker host mapping. Explicitly configure the SDK's container topology.
This rewriting alone does not make a loopback-only native listener reachable on Linux.

The initial proposal is an app-owned authenticated IPv4 host listener on the assigned port
(`0.0.0.0`), with every agent/settings operation enforcing its proper provider or Hosty identity.
Keep browser navigation and backend transport descriptors distinct. `public: false` and Docker's
`expose` metadata do not enforce a native bind address. Do not invent a Core bind environment
variable or silently proxy agent data through Core. Validate the advertised runtime host/address
family against the real listener and Docker route; an incompatible override is not ready.
Rootless/remote support is not added here.
Use that authenticated host listener for the first implementation. A narrower interface policy
would be a separately specified generic configuration change, not an unresolved protocol choice.

Verify actual Docker Desktop macOS/Windows and supported local Linux Engine paths. Unsupported
remote/rootless daemon topologies must report unavailable, not claim success from a rewritten URL.
Send provider credentials only to the exact current endpoint, disable redirects and reject changed
installations. Do not send an app service credential to the provider or browser.

## Clean-Slate Cutover (Owner Decision, 2026-11-12)

The owner explicitly chooses a fresh start. Do not implement account/credential migration, native
history import, old session preservation, alias/mapping transfer, export envelopes, rollback to old
session ownership or a transitional worker bridge. The operator creates fresh provider connections
and tests provider-owned settings. This retires D10; its ID remains reserved and is not marked done.

D3/D11 document and verify the operator sequence:

1. Install/configure the desired Local providers through normal Core flows, review grants and
   create fresh accounts/connections. This can precede the Harness cutover.
2. Finish or explicitly stop all old work through supported controls and confirm no legacy native
   consumers remain. Resolve/close associated pending decisions and preserve correct lease cleanup.
   Do not use data deletion as proof that a process stopped.
3. Clear the selected old Harness conversations/history and legacy native session state through
   supported, explicitly targeted cleanup. Verify the separate native `provider-sessions` store is
   cleared too: current chat deletion alone does not prove native-history removal. Document or add
   the minimal targeted cleanup needed for this cutover, without a migration subsystem. Remove
   stale consumer/provider selections. No legacy
   session is continued or reconstructed into a new provider. Retained task/share/history references
   to deleted sessions must report deleted/unavailable rather than pointing to a new conversation.
4. With no active work or old session/history bindings, apply the Harness update, retire its worker
   packaging and select the newly configured providers. Verify fresh conversation/invocation paths.

Keep Core workspaces, source trees, Git metadata and unrelated app data intact. Profiles, preferences,
retained business tasks and account-secret cleanup have separate ownership; this is not a blanket
Harness/Core data-directory wipe. No deletion or live-host transition is performed by this planning
revision. After cutover, providers own newly created native state and retain it across later updates.
This one-time reset does not weaken the new runtime's admission/replay/decision/confirmed-stop rules.

## Packaging, Host Tools And CI

Provider SDK/CLI dependencies remain pinned per application. Resolve a compatible packaged
platform executable first; any host override is explicit and compatibility-checked. Replace
Docker-only Claude executable paths. Keep vendor auth homes and process containment app-owned.
The operator installs project development tools on the Core host.

D7 supplies a small read-only doctor/recommendation command, usable during provider setup:

- Required startup checks: supported Node runtime, provider-owned executable/SDK, app storage,
  Core identity and configured endpoint readiness.
- Workload-dependent checks: Git/worktree support, .NET, Python, ripgrep and other requested tools.
  Missing an optional project tool does not make every provider unusable.
- Ollama checks: existing endpoint reachability and selected model availability, with no daemon
  install or model download. Report discovered versions and platform-specific install commands.
- No automatic package/global CLI installation, sudo, login, shell changes or credential printing.

Remove provider dependencies from both Harness packages and projected install inputs. Stop
building the worker in its Local bundle as well as Docker. Retain the API/UI Docker image;
retire the worker manifest service, mandatory service dependency, auth/storage/mount coupling,
Dockerfile and owned image recipe only after their replacement works. Keep narrow release
fingerprints, artifact provenance and feed publication checks.

Use independent source-only Local app releases under the existing artifact/feed model. Extend
version/source-input checks and repository guidance for the new apps. Core and changed public
SDK APIs need their own appropriate version bumps; Harness's removed worker profile/service is
a breaking change while in 0.x. Pick exact versions at implementation time. This planning change
is documentation-only and has no version bump.

Measure the release path again after extraction. Removing the worker's Docker/toolchain build
is an extraction result, not an Nx cache speedup. Nx remains a separately tracked next initiative;
neither caching nor a universal inference API is a prerequisite to this provider design.

## Deliverables

- [x] D1. Confirm the focused extraction scope in the approved monorepo, record the accepted HTTP/SSE execution profile and transfer general generation/second-product integration to its linked Draft plan.
- [x] D2. Finalize and obtain owner acceptance of the execution v1 design: SDK-owned session/configuration/run contract, optional instructions/skill snapshots/MCP, admission/renewal, replay, controls/cancellation, native-subagent correlation, limits and compatibility. General generation product scope is not completed by this execution-contract approval.
- [x] D3. Finalize independent Local app boundaries, supported Docker-to-host transport, optional consumer configuration and Core authority, fresh provider setup and clean-slate cutover prerequisites, retaining Harness profiles; later translation retirement is tracked in D12.
- [x] D4. After Ready approval, implement generic Core discovery/authority and TypeScript/.NET SDK support, including direct admission, provider-owned scoped renewal and authorized immutable provider skill snapshots without a Core agent-data relay, Harness prerequisite or vendor-ID special cases; publish the OpenAPI/event schemas and SDK conformance fixtures for the accepted contract.
- [ ] D5. Verify Docker Harness across all three providers plus an unrelated-ID contract fixture; prove authority, live transport, independent lifecycle, replay/decisions, native-subagent correlation/stop where declared, fresh setup and clean-slate cutover; include an unrelated consumer with no Harness installation.
- [ ] D6. Record verified behavior/limits in feature.md, reconcile the predecessor and dependent documents, delete this plan and regenerate the index after all accepted deliverables pass.
- [x] D7. Deliver read-only host prerequisite diagnostics and platform-specific installation recommendations, separating startup requirements from optional project tools.
- [x] D8. Extract the three independently installable Local provider apps and their shared mechanism library, with provider-owned connections, settings, secrets, native sessions, decisions, journals, process containment and supported update behavior.
- [x] D9. Convert Harness to the public provider client, preserving conversation/task/profile functionality for fresh data, scoped resources and current native/development use without mandatory execution callbacks to Harness.
- [x] D11. Retire embedded worker packaging/dependencies/publication only after acceptance, register independent manifests/feed entries, versions/source releases, shared-library input closures and lock projections; remove worker-specific assertions and obsolete Dependabot worker targets while retaining root-workspace provider updates and coordinator Docker pins; verify stable feeds, Marketplace deployment and fresh installation; document and verify operator-prepared fresh-provider/no-active-work/session-history cleanup cutover, and record the new CI/release baseline.
  Keep Docker as the only production Harness release profile and Local source as development-only.
  Audit provider selection and release fingerprints for shared theme/font inputs, isolate provider
  dependency installation in CI and run the shared runtime suite once per selected source candidate.
- [x] D12. Apply the owner-approved translation retirement: remove Harness translation settings/routes/declarations and Codex/Claude translation implementations/capabilities, retain the generic Core/SDK contract and OPUS supplier, reconcile docs/experiments, and verify non-discovery plus unaffected agent execution and provider settings.
- [x] D13. Repair live Codex event delivery and cancellation: blocking native stdout/stderr pipes with backpressure and complete drain proof, finite RPC/interrupt acknowledgments, bounded SDK background-terminal cleanup and exact late command completion, shutdown that unblocks accepted controls, owned recovery of the stalled run, and verified end-to-end message/tool/terminal delivery plus reviewed retirement of diagnostic test fences.
- [x] D14. Preserve immutable cancellation identity after an applied receipt: repeated Stop on an unknown-effect run must reuse the original cancel bytes or observe the retained control, never combine its old request UUID with a newer snapshot revision; cover applied-receipt removal, repeated Stop and restart recovery without replaying native work.
- [x] D15. Restore remembered manual provider selection for new Harness chats through owner-scoped browser defaults, preserving profile/explicit/task priority, exact current connection identity, creation replay, and verified reload/new-chat behavior without shared-default writes.
- [x] D16. Restore optional account limits in provider-owned settings and before the first Harness message through the existing usage operation, with bounded inference-free refresh, account revision guards, shared diagnostic throttling, explicit unsupported/unavailable states and verified settings/chat rendering.
- [x] D17. Align embedded Harness settings with the Shell settings width/header and propagate new conversation titles to the active header without a page reload, preserving manual renames and session-switch isolation.
- [x] D18. Repair defects exposed by final acceptance: bound Claude's polite interrupt and complete stop wait, preserve authoritative child command outcomes through supported SDK observations during cancellation, and allow provider-owned Ollama MCP approvals to cross Core's credential TTL with finite SDK/HTTP deadlines and prompt cancellation; verify independent continuation with Harness stopped and real active-child cancellation.
- [x] D19. Preserve the latest context observation in the provider snapshot and restore it after consumer disconnect/restart, with a sequence-bound nullable value and compatible SDK validation; verify the latest measurement against its actual model request without claiming an offline per-request telemetry ledger.
- [x] D20. Fence direct and agent-origin MCP workspace lease acquisition against concurrent cleanup and replay, persist admission closure, preserve idempotent cleanup after expiry/revocation/restart, and verify real claims with deterministic interleavings.
- [x] D21. Persist pending workspace cleanup after native stop and retry the same release identity during maintenance after transient Core failure, including provider reconstruction and executions without pending decisions.
- [x] D22. Restore engine-neutral shared infrastructure: move concrete adapters, account/auth/history/skill integration, settings policy and build metadata into their provider applications; inject explicit runtime contracts, preserve persisted state/public behavior and verify neutral-engine, provider, packaging and affected integration checks.

### Implementation Order

One feature branch and one PR, with independently verified checkpoints inside it:

1. Resolve the scope choices and examples in D1-D3; obtain Ready approval.
2. Build the generic Core/SDK foundation in D4. Extract common mechanisms and implement Codex
   as the first vertical path through D8/D9, proving Docker-to-host admission and renewal.
3. Extract Claude Code and Ollama, then prove that restart/recovery/settings are independently
   owned. Reuse mechanisms without merging their data or service lifetimes.
4. Complete doctor in D7, verify fresh provider setup/clean-slate cutover under D11, and test persistence/resume of newly created sessions and failure recovery.
5. Pass D5 acceptance, complete D11 retirement/release work and finish D6 documentation.

Do not release per-phase PRs or mark D8/D9 complete after only the first provider. There is no
ordinary-host deletion implied by implementation verification. The separately recorded owner
authorization permits local tests and necessary ordinary app restarts while preserving existing data.

## Acceptance And Verification

| Area | Required evidence |
| --- | --- |
| Core boundary | Empty registry, unrelated provider and consumer IDs, no Harness installation, changed installation, explicit selection and standard Core app/user permissions |
| Authority | Wrong user/app/install/key/digest/resources rejected; current grants revalidated; revocation/expiry fences effects; no provider-admin substitution |
| Transport | Real Docker Harness to Local providers on macOS, Linux and Windows, assigned port changes, authenticated operations and endpoint refresh |
| Independence | Keep Harness down beyond MCP credential TTL, answer a delayed approval/Shared Decision, renew through provider and continue once; revoked authority blocks dispatch; reconnect deduplicates state |
| Provider lifecycle | Known child exit versus interrupted/unknown stop, cancellation races, busy sessions, operator-quiescent provider update preserving new state, lease/capacity retention |
| Recovery | Same start/control UUID before CAS checks, byte-digest conflict, atomic snapshot/events, expired replay, lost-start cancellation fence, pending/later-turn Decisions and no duplicate effects/accounting |
| Native subagents | Declared policy/coverage, correlated child tools/questions/results, inclusive usage, cancellation/known-stop across child work without a new client spawn API |
| Fresh cutover | Desired providers configured first, no active native work, selected legacy session/history cleanup and stale-binding rejection, fresh connections, worker retirement and unrelated data preserved |
| Consumer configuration | No MCP/skills, one selected skill, declared MCP targets and instructions; unsupported capabilities, revoked authority and absence of Harness defaults |
| Existing behavior | Harness conversations/tasks/profiles, optional usage, supported model/effort and resource handling; only OPUS supplies translation in the distribution |
| Release | No SDK/CLI in Harness install/image/bundle, no worker image recipe, independent provider inputs/versions, unchanged provenance/publication gates |

Run affected fast unit/component suites and builds in the registered worktree. For integration,
use supported native apps in an isolated Core-managed test instance, normal setup/login and
separate test users/data. Do not invent provider Docker images for verification or copy live
provider credentials into tests. A protocol fixture is not live provider/OS evidence. The heavy
`tasks` suite is optional unless explicitly selected by the user or an approved verification plan.
The intended OS/architecture support follows the supported native engines/Core hosts; this plan
does not introduce a platform restriction. Platform checks verify binary packaging, filesystem/process
behavior and Docker-to-host networking. Record unexercised combinations honestly instead of treating
intended support or a mock as observed acceptance.

Documentation verification uses `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check --base <integration-ref>` and `git diff --check`.

## Implementation Approval And Verification Boundary

Owner approval, 2026-11-12: implement the focused provider extraction under the accepted execution
contract; the [second product integration](../agent-generation-consumer/plan.md) is a separate Draft.
D1 and D2 are complete design/approval work, not proof that server/SDK/provider behavior exists.
D3 finishes engineering preparation under the selected topology, authority, storage and clean-slate
policies. D4 owns machine-readable schemas/SDK/server work; D5 owns runtime/platform evidence.

The first code edit changes status to In Progress. Keep verified deliverables current in this
registered worktree. No commits, publication or ordinary-host reset are inferred from approval.

## Coordination With Existing Features

- [Runtime app update](../runtime-app-update/feature.md) supplies ordinary reviewed updates. Initial
  provider updates use operator-prepared quiescence; this extraction adds no generic Core preflight.
  Provider-owned new sessions/configuration survive compatible updates after the one-time reset.
- [Provider consumption](../provider-consumption/feature.md) supplies the current generic discovery
  and credential baseline. Speech/assistant handoffs are not completion of this agent contract.
- [Core extension boundaries](../core-extension-model/feature.md) and
  [Core MCP](../core-mcp/feature.md) own generic declarations and the shipped `agent-sessions`
  observation/control profile. Reuse its identities/freshness/stop rules without a Core chat database.
- [Workspace permissions](../external-workspace-access-continuity/feature.md) preserve the initiating
  user's collection authority; workspace selection is not another allowlist or consent prompt.
- [Conversation History](../conversation-history/feature.md) owns public read/share/search projections;
  providers retain originals. Preserve qualified conversation references and declared extensions.
  [Development sessions](../assistant-development-sessions/plan.md) does not move private chat into Core.
- [Durable Agent Jobs](../durable-agent-jobs/plan.md) owns scheduling and Harness's bounded recovery
  commands. [Basic Tasks](../basic-tasks/feature.md) owns business task dispatch. Native run/segment
  ownership moves here; neither feature becomes a prerequisite for an unrelated app's invocation.
- [Runtime containment](../assistant-runtime-containment/plan.md),
  [approval policy](../assistant-approval-rules/plan.md) and
  [user isolation](../user-agent-sessions/plan.md) retain their safety/permission contracts. Moving
  execution does not remove supported containment or grant user-safe execution implicitly.
- [Shared Decisions](../shared-decisions/feature.md) owns addressed questions and
  [Artifacts](../shared-artifacts/plan.md) owns retained result references; neither reference grants access.
  Preserve execution-side continuation ownership when moving pending decisions.
- [Provider usage](../harness-provider-usage-limits/feature.md) remains optional and distinct from
  run/context usage. [Context accounting](../harness-context-usage/plan.md) owns producer measurements;
  move adapter producers with their providers and preserve coverage/attempt identities on replay.
  Do not fabricate missing timing/cache counts. [Timeline Analysis](../assistant-timeline-analysis/plan.md)
  owns detailed visualization, not this extraction.
- [Action Summary](../assistant-action-summary/plan.md) owns Harness's correlated history projection.
  [Events and continuation](../assistant-events-and-continuation/plan.md) consumes invocation/recovery;
  it does not create a second engine owner or authorize replaying native subagent effects.

Inference-compatible model APIs alone do not supply approvals, native sessions or process
recovery. The protocol comparison above records the current sources and distinguishes their
released contracts from drafts; revalidate the selected exact versions before implementation.

## Verification Record (2026-11-12)

Implementation runs in the registered development worktree, without commits or ordinary-host
changes. D7 is verified by the read-only doctor tests, including macOS/Linux/Windows guidance,
startup versus optional tools, and exclusion of credentials. The remaining checkboxes retain their
complete accepted scope; a fixture or source build does not complete D5's native platform evidence.

Observed fast verification includes the complete Harness suite (246 files, 2,865 tests), its
production web export and typecheck; TypeScript SDK conformance (834 tests); .NET SDK (81 tests
and net8 build); Core authority/HTTP/skill/lease tests (137 affected cases plus the strengthened task-chain regression)
and exact source/NativeAOT builds. The final bounded web export covers 20 pages. Decision, process,
workflow and consumer corrections have their affected regressions and builds before managed acceptance.
Release/CI fixtures prove that a Codex archive-only change selects Codex alone; isolated provider
installs contain only their own vendor SDK. An isolated Harness production install contains neither
vendor SDK, the shared native runtime nor js-tiktoken.

All three provider Local launch recipes have passed real isolated npm-ci and production builds.
They publish immutable cache generations instead of writing node_modules/dist into a shared
registered source worktree. Cold source changes fence publication rather than mixing generations.

The owner explicitly approved installation of the three Local providers and Docker Harness into
one disposable Core. Normal child password login and installation review succeeded. The test Core
was built from this worktree, started with an empty registry and restarted through its owner after
verified Core edits. All three actual Local services became healthy and their own settings sign-in
completed through Core's normal app-code flow. Docker Harness discovered all three installations
and a connection configured only in Ollama's settings. Its production source bundle built inside
the child Docker service's 2 GiB memory limit with type checking enabled; the unbounded initial
Next build exhausted that limit, so source preparation now uses a bounded Webpack worker.

An owned deterministic HTTP inference fixture exercised Docker Harness to the Local Ollama app:
a first turn, a subsequent turn with the same public/native session after provider restart, a
Core Shared Decision answered after Harness had remained stopped for more than four minutes,
and cancellation with authoritative current `stopConfirmed: true`. Core recorded continuation
completion before Harness restarted; Harness then recovered the result. This proves live local
transport and independent continuation, not live vendor inference or live MCP use. Core tests
separately cover fresh MCP minting after the consumer stops beyond its operation-token TTL.
The final runtime fast suite passed 455 tests with three Windows-only execution tests skipped on macOS;
read-only doctor checks passed on the actual host and in eight focused tests.

The decision trial exposed a stale question-card projection after an out-of-band Core answer.
Provider journal/controller regressions now prove resolved responses, exact once-only native
delivery and authorized read repair. Harness regressions cover run-qualified card identities,
duplicate option labels, stable multi-choice IDs and free-text arrays, plus public profile and
workspace preservation. The repeated managed trial passed on the final generation: Core received
the answer after Harness had stayed stopped for 150 seconds, continuation completed before
Harness restarted, and the recovered UI showed the chosen label with Answered and no active form.
The current public run was succeeded, pending was empty and stopConfirmed was true. D8 is verified;
D9 subsequently passed its complete public task-executor cycle on 2026-11-13.

The final consumer-owned workflow adapter passes genuine MCP client transport, concurrent native
client ID isolation, approval-before-effect, cancellation, selected-tool/Disabled policy and
changed-definition checks. Core HTTP tests prove the bounded JSON business channel under an
external original task caller while configured Core MCP minting stays denied. The existing Core
MCP origin/grant checks remain unchanged. The owner separately approved the optional providers.task-executor permission on 2026-11-13.
The ordinary renewed review added exactly that permission in the disposable child, with no
other grant changes; the original four installations had not granted it.

All four test apps have received compatible manifest capability updates through Core plans that
require no additional access review. Their installation identities, source binding and test data
remain; all three Local providers and Docker Harness restarted healthy. The Ollama conversation
continues with the same public provider session after that quiescent update.

Remaining D5 acceptance includes a live configured MCP dispatch after its five-minute bearer TTL,
actual Linux/Windows Docker-to-Local transport and native process behavior, live Claude inference and declared
Codex/Claude native-subagent lifecycle, and the full prepared cutover/release baseline in D11. Later
macOS Codex acceptance below verifies its basic live inference/tool/cancel/resume path. Protocol fixtures
and intended support do not close these checks. The managed task trial and owner-managed Finish cleanup are complete. All consumers stopped
before cleanup; Core reports finished with no process, its owned data root is removed, and
registered source remains preserved independently from the disposable runtime.
No live vendor accounts were copied and no paid inference was performed. The optional heavyweight
`tasks` suite was not selected.


### Resumed Managed Task Verification (2026-11-13)

The owner approved only the optional providers.task-executor permission for the disposable Core.
The renewed ordinary permission review added exactly that grant and removed none. The prepared
task was dispatched through the existing manual Core operator API, preserving an external
original caller rather than granting Harness additional task-provider permissions.

The trial exposed and verified two integration corrections: catalog definition metadata enters
authorization only for effective Run rules, and the current task attempt retains exact stop/read
authority after cancellation while all execution effects remain fenced. The policy regression
passes 114 affected tests plus Harness typecheck/API build. The cancellation regression passes
42 affected Core tests, the exact Core build and macOS arm64 NativeAOT publication.

The retained unknown start was not rewritten or replayed. After the corrected Core restarted,
normal cancellation recovery fenced that same run, produced a current provider-confirmed stop,
and settled both retained mutations. The task returned to Draft only after this proof. Controlled
fixture discovery was corrected to follow Ollama's discover_tools and hashed MCP function aliases.
The owner's normal same-origin root-limit API allowed one additional retry for this test root;
all other limits, grants and retained attempt history were preserved.

The final run exercised manual Core task dispatch, Docker Harness, the actual Local Ollama agent
loop, lazy discovery of hosty-workflow task_result, a Core-backed Ask approval and the signed
consumer business request. After approval, task_result recorded the explicit fixture outcome;
the task became Done and its execution became completed with stopConfirmed true. The current
provider snapshot is succeeded/terminal, with known effects, no pending decisions or unresolved
calls, and an empty mutation outbox. Normal password/app-code browser identity showed the result
and all retained attempts. Core's general MCP target still had no Harness grant. This completes
D4/D9 verification without claiming paid inference, cross-platform execution or D5 acceptance.


Owner-managed Finish succeeded on 2026-11-13 after all four apps, the browser and owned inference
fixture stopped and their consumer claim was released. A subsequent status check reports finished
with no Core process; the owned data root and former Core PID are absent. Registered source and
uncommitted changes are retained. No ordinary Hosty data, vendor accounts, commits, publication or
live activation were used for this trial.


### Ordinary-Core Trial (2026-11-13)

The owner explicitly authorized installation of the independent providers and switching the
ordinary local Core and Harness to the registered workspace. All three Local provider apps and
Docker Harness now report healthy. Core runs the fixed workspace Debug generation, verified by
factual instance/project identity and continued readiness after its launcher exits. Normal Shell
app-code identity resolves the newly configured Claude and Codex accounts as Ready in Harness.
Four profiles retain their instructions and skills; obsolete embedded account/model bindings and
the old default were cleared through the app API. No account credentials were copied.

The trial exposed three generic development-lifecycle defects. Scratch-cache setup receipts
incorrectly suppressed setup against actual app storage; candidate-only development profile keys
were rejected by installed-manifest discovery; grouped Return compared source collection fields
by reference. The fixes retain exact candidate access review and installed package Return,
reexecute storage-bound setup without promoting scratch data, and compare complete source values.
Verification passes 60 preparation/adapter tests, 54 authority/review/recovery tests and nine final
focused candidate/Return regressions. The broader selection/activation run passes 118 scenarios;
its one invalid new negative fixture was corrected and verified by the final focused rerun. The
exact Core build and macOS arm64 NativeAOT publication/smoke pass.

The offline legacy-history helper passes 26 cleanup tests plus 36 CI-policy tests. Its plan
validates stopped writers, empty global conversations, confirmed orphan execution metadata and
applied controls. Parked barriers remain validated inert checkpoints. Recognized historical
started/unknown effects require a separate exact-digest acknowledgment before deletion; no
external outcome is rewritten or claimed settled. Accounts, profiles, cursor keys, tasks and
workspaces remain outside deletion scope.

The owner explicitly approved the bounded recovery exception. The old Return was paused through
its normal control, only its parent returned-child receipt was repaired against public proofs and
a backup, and the original Return resumed to completion. Guarded compare-and-swap recovery
artifacts remain outside repository source. The normal source Core restart then succeeded.

After the owner approved the historical-effect disposition, the cleanup helper removed about
520 MB of selected old native history and execution journals. Historical unknown external effects
were acknowledged as unknown, never replayed or claimed settled. The normal backup remains.
Accounts, credentials, profiles, tasks and workspaces are preserved. Harness's exact workspace
permission review for agent/translation access and source reading is complete. This live readiness
check makes no paid/native inference claim; D5 and D11 remain open for remaining acceptance and
release-baseline evidence.

The owner additionally requested provider settings matching the former Harness provider tab,
including Hosty fonts, colors, controls, account rows and modal editing. Account management belongs
to each provider. Harness removes its Agent providers tab while preserving profile, conversation
and conversation consumer controls. Translation retirement is tracked in D12.


### Translation Retirement And Settings Verification (2026-11-13)

The owner explicitly retired agent-backed translation while retaining OPUS. Harness has no
translation settings, routes, supply declaration or translation-consumer permission. Codex and
Claude have no translation declarations, capability flags, routes or native translation helpers.
Core and both SDKs retain their generic translation contract. Existing private legacy selections
remain inert on disk; they are absent from active settings DTOs and execution.

Verification passes 472 runtime tests with three platform/conditional skips, 108 affected Harness
tests, 55 final provider-settings/theme/packaging tests, 182 Shell tests, 15 OPUS tests and nine
local-experiment checks. Relevant TypeScript/lint checks and production builds pass. OPUS's
structural test oracle is independent of Harness; its runtime implementation remains unchanged.
Provider settings use canonical Hosty fonts/theme assets and the former Harness account rows,
actions menu and modal editor without adding a frontend framework dependency.

After normal Core-managed restarts, the three Local providers and Docker Harness are healthy.
Normal Shell app-code identity shows retained Codex/Claude connections and Ollama's empty state;
the Add provider dialog opens, focuses its first field, cancels without saving and returns focus.
Harness settings contain neither Agent providers nor Translation providers. Live former translation
URLs return 404. An inventory of all 17 installed app declarations finds OPUS as the only translation
supplier; it remains stopped at its existing installed version. No account credentials, model
weights or live inference are used for these checks. Historical confirmed-role grants are retained,
so Dashboard badges require both a confirmed role and a current nonempty interface declaration.

D12 is complete. D5/D11 retain the broader native-platform, paid/vendor, unrelated-consumer and
release-baseline acceptance work; this UI/retirement batch does not close those deliverables.


### Native Output And Cancellation Regression (2026-11-13)

The first operator Codex conversation exposed a native transport defect. Its native history records
three tool calls and a completed answer in about 20 seconds, while the provider journal contains
only initial activity/model/session events. The exact native process log reports an EAGAIN stdout
write failure followed by a closed writer and dropped notifications. The POSIX anchor inherited
Node-owned nonblocking output descriptors into the native process. A real synchronous-write burst
fixture reproduces the failure without any account or inference.

Cancellation also waits without a deadline for a polite native interrupt before reaching owned
stop. The old interrupt request omits the required correlated turn ID. A separate shutdown-order
bug drains background cancellation tasks before asking the driver to stop, which can deadlock.
Fixes and regression coverage belong to D13; the existing SDK/process-tree stop proof remains
mandatory. The old live generation cannot acquire these fixes by editing source. Core's app stop
uses forced process-group termination, so it is containment rather than proof that the old SDK
completed its stop operation. Any one-time recovery intervention requires its own exact live-owner
review and observed stop evidence; no receipt or application data is rewritten to claim success.


D13 initial source verification passes 485 runtime tests with three platform/conditional skips, the
TypeScript check, all three provider production builds, and version/document/diff validation.
Focused coverage includes 116 Codex/engine/adapter checks, 28 native tracker/driver checks and 18
controller/public-surface checks. The original transport fixture failed before the blocking-pipe
fix; its final 16 MiB synchronous output/duplex/backpressure case and existing producer-crash and
stubborn-descendant cases pass together. Physical tree closure and output delivery remain distinct.

The owner approved the exact one-time receipt-writer SIGTERM recovery exception. Its guarded,
hash-pinned helper reverified the original run, process identities, applied cancellation and empty
unresolved-effect set before sending one signal. Existing runtime handlers recorded cancelled,
confirmed SDK exit, sealed process evidence and stopped descendants; the public Harness run now
reports cancelled with current stopConfirmed true. History and accounts remain intact, and the
original prompt was not replayed. No application journal or Core record was manually rewritten.

All three Local providers then restarted healthy through normal Core lifecycle on the verified
production bundles. A new Codex chat through normal Shell identity completed the read-only host
inventory in about 17 seconds: three tool calls, their results and the complete answer appear in
Harness. Native output drained, process-tree exit is confirmed and public state is succeeded.
The subsequent controlled command cancellation stopped its native tree promptly, but exposed an
additional notification race: the polite interrupt acknowledgement precedes the command's terminal
notification, and immediate process teardown leaves its effect receipt unresolved. The public
snapshot correctly retains that uncertainty. D13 remains open while this race and a repeated live
cancellation, subsequent turn and reconnect are verified; no external effect is inferred settled.

The first bounded interrupt-drain correction passes 486 runtime tests with three skips, TypeScript
and all three provider builds. An additional live foreground-command cancellation still receives
no command-terminal notification before turn interruption. The pinned Codex protocol separately
exposes background-terminal cleanup and permits command completions after their originating turn
ends. D13 therefore also retains exact command correlation beyond the turn boundary and verifies
bounded SDK cleanup before native teardown. A separate test that discarded a yielded command's
handle is not accepted as proof of foreground cancellation. Three diagnostic histories remain
fenced with unresolved outcomes and confirmed process absence; they are neither replayed nor
rewritten as successful or stopped public executions.


The final Codex candidate explicitly cleans SDK-owned background terminals, retains exact late
command identities and defers root completion through bounded typed-result drainage. The pinned
0.167.0 executable accepts the experimental cleanup method in an isolated empty native home
without an account or model turn. Source verification passes 116 focused Codex/engine tests,
TypeScript and all three provider builds. The broad runtime run passes 488 tests with three skips
and one Ollama five-second deadline failure; the entire affected Ollama suite then passes 36/36
without source changes. No second broad run is claimed.

The final ordinary-Core trial passes through normal Shell identity on the exact immutable source
cache generation: read-only inventory shows three completed tools and its answer; Stop during an
awaited command receives an authoritative failed command terminal (exit -1), settles its effect and
reports cancelled/terminal with stopConfirmed true in 257 ms from accepted cancellation. A following
request succeeds with the same provider session, native thread and account revision and correctly
uses the earlier inventory without tools. All three runs have sealed SDK stop, stopped process-tree
receipts, outputDrained true and no unresolved effects; the session has no active run. Browser
reload retains both tool groups and all answers without duplicate runs.

The owner explicitly approves D13's final operational cleanup. Three earlier diagnostic
conversations retain unknown command outcomes despite confirmed native exit. A guarded reversible
six-path quarantine retires their active catalog entries without forging terminal proof, clearing
effects, replaying input or editing Core records. The original operator chat, accounts, native
histories and registered workspace remain outside its scope. Ordinary deletion/reconcile does
not retire these unknown outcomes; the explicit reviewed offline exception applies only to these
internal test identifiers.


### Diagnostic Retirement Preflight (2026-11-13)

The owner approves archival of the exact three diagnostic conversations and six paths. The first
read-only guard refuses a changed preimage before any app-data modification. Independent review
cryptographically reconstructs both original file hashes: only the third chat's retained cancel
outbox and local decisionGeneration (1 to 3) changed. No messages, native runs, resources, shares,
provider aggregate or native proof changed. The outbox uses the original applied cancellation UUID
with expectedRevision 8 instead of its original 4, so the provider correctly rejects conflicting
request bytes. This consumer defect is tracked by D14 rather than hidden in cleanup notes.

Harness and Codex stop through normal Core lifecycle. The same six-path archival scope receives a
narrowly reviewed metadata-preimage amendment: only this exact inert conflicting cancel retry is
retained intact in the archive. It is not replayed, removed from active JSON or declared applied
with changed bytes. The original approved plan and amendment evidence remain separate outside the
repository. Archival remains guarded by stopped owners, unchanged other paths/native receipts and
no new work/resources. The original chat, final verified chat, account settings and profiles have a
separate stopped-owner hash baseline for postflight comparison.


### Verified Diagnostic Retirement (2026-11-13)

The approved same-scope amendment passes 14 temporary-data regression tests and independent
review. With Harness and Codex publicly stopped, the helper makes checksum-verified backups and
performs exactly six non-replacing same-filesystem relocations. Independent pre-start postflight
confirms all six archives and all six backups match their reviewed bytes, modes and ownership;
all 15 native proof files for five runs remain exact. The original and final verified chat file
sets, their provider aggregates, the original native journal, connection settings and Harness
profiles/preferences match the separate stopped-owner baseline. No outcome is relabelled and no
input is replayed. The old test identifiers remain operationally retired; no permanent public
session tombstone or new archive API is claimed.

Codex and then Harness start through normal Core lifecycle and report running/healthy on the
same registered workspace, with no app error or pending manifest restart. Normal Shell identity
shows the original chat, verified chat and development workspace, three sessions and Failed 0.
A fresh no-tool request succeeds after this restart using the same native thread/account revision;
its public and private exit, sealed SDK stop, process-tree closure and output drain are confirmed.
The provider catalog contains two retained sessions, no active run and zero occupied slots out of
four. Archives, backups, account/profile settings and old native proof remain intact after startup.
D13 is verified complete; D14 separately retains the consumer cancellation-byte defect.


The original operator conversation remains present through the archival pre-start and initial
post-start checks. A later ordinary conversation-deletion audit event matches its fingerprint
and occurs after those checks, alongside separate operator chat activity. It is not a quarantine
path and is not restored or recreated by this maintenance task. The native history and independent
quarantine evidence remain preserved.

### Remembered Provider Correction (2026-11-13)

The owner reports that new chats do not retain the last selected agent. Extraction retained manual
model/effort and autonomy hints but omitted the provider hint itself. The correction adds the exact
opaque connection ID to the existing origin/user-scoped browser preferences only after a successful
explicit provider save. Automatic default adoption, read refreshes, failed saves and admitted tasks
do not overwrite the manual choice. Fresh authenticated creation resolves profile/explicit settings
first, validates a matching-owner hint against current discovery and binding, and ignores stale or
unavailable identities. The global Harness default remains an independent operator setting.

Focused verification passes 69 browser preference/provider/model/autonomy tests and 64 backend
profile/directory/connection tests, both TypeScript checks, web lint, the exact production API
bundle and bounded Webpack production UI build. After a quiescent normal Harness-only restart,
Core reports healthy/current on the registered workspace. A normal Shell-embedded browser trial
manually selects an authorized provider and model, reloads the page, and creates another chat.
The new chat automatically contains the same exact connection revision and model with no profile
or native execution. This verifies D15, including real browser persistence and atomic server
creation, without changing the shared Harness default. Provider processes are not restarted.

### Final Packaging And Cancellation Verification (2026-11-13)

D14 passes 129 Harness provider tests, TypeScript and the API build. The canonical cancellation
request and receipt survive applied-outbox cleanup; repeated Stop and restart observation reuse
the same bytes without another native admission. An independent review finds no material issue.

The CI policy/release suite passes 273 tests. The final macOS projected CI helper installs
204 packages instead of the former 780-package root installation, runs the shared runtime suite
once (575 passed, three Windows-only tests skipped), typechecks the runtime and builds all three
providers. The complete helper takes 93 seconds with the existing npm download cache; it is not a
cold-network GitHub runner benchmark. Pinned actionlint 1.7.12 passes all workflows. No GitHub run
or publication is invoked. Nx remains explicitly deferred in the CI plan.

The production Harness image contains compiled API/static UI and 97 production dependency packages,
with no vendor SDK/CLI, TypeScript runner, Next server or embedded worker. The macOS arm64 build is
298,860,696 bytes uncompressed. Selective web inputs preserve its cached Next build on API-only
changes. Nineteen packaging regressions pass. Docker is the only production manifest/release
profile; cached Local source execution remains available as development.

`npm run test:integration -- transport` passes actual container-to-Core health and authenticated
boundary probes on default and per-app networks. `npm run test:integration -- harness-local`
passes the managed Local development cold start, cached warm restart and missing-output recovery:
39.730, 1.651 and 35.479 seconds respectively. Normal password/app-code identity, settings and
static assets work with disposable users and all three installed providers. Owner-managed Finish
removes the child process, data and owned helper resources. Existing ILCompiler NU1903 warnings
remain visible; these checks do not claim a warning-free dependency graph.

A separate read-only-source Linux arm64 container passes 39 process/protocol checks, covering
blocking output, duplex/backpressure, crash/stubborn-descendant cleanup and typed cancellation.
The installed-Claude metadata case is skipped. Debian's Git 2.39 does not satisfy the relative
worktree fixture's Git 2.48 prerequisite, so that case is not selected. This is Linux native
mechanism evidence, not a Linux Core/Docker-to-Local or live-vendor acceptance claim.

The ordinary Core's existing Claude account completes a real no-tool request with current public
stop confirmation, then resumes the same public provider session and runs a native Agent/Bash
child. Child provenance links to its exact parent tool call and the marker survives. The SDK's
child result contains text and `is_error: false` but no structured command exit metadata; the UI
currently reports its command outcome as unavailable rather than inventing exit code zero.
D18 owns remaining stop/timeout corrections; these partial observations do not close D5.

### Frozen Runtime And Native Follow-up Verification (2026-11-13)

The final Codex/Engine/storage batch passes 169 focused tests, and the final Claude batch passes
41 focused tests. Runtime typechecking and all three provider production builds pass on the
combined source. These checks retain exact known-effect settlement during healthy shutdown,
absolute storage-failure quarantine and independent SDK/process-tree stop evidence; they do not
turn an abrupt Core Local process stop into a graceful provider shutdown.

The unchanged projected CI helper also passes in a disposable, pinned official Node 24.22.3
Linux arm64 container with a read-only worktree and a writable temporary projection. It installs
203 packages, passes 575 tests with only the three Windows execution tests skipped, typechecks
the runtime and builds all three providers in 106 seconds. The first run exposed a test reading
the prompt-suggestion journal before an asynchronous event mutation completed. The corrected
test observes the existing journal serialization boundary; the production 30-second deadline and
no-regeneration assertions remain unchanged, with no automatic test retry. The corrected helper
runs once to completion. Its container and temporary dependency/cache projections are removed;
no Docker socket, ordinary app data or credentials are mounted. This verifies Linux runtime
mechanisms and packaging, not full Linux Core/Docker-to-Local host transport or live-vendor
acceptance. Windows native execution remains unverified by these macOS/Linux runs.

A fresh real Codex conversation on the final source verifies native child spawn/wait, an exact
parent-correlated child Command with exit code zero, and interruption of an already completed child.
The verified child history remains complete without a truncation warning; the root run succeeds
with current stop confirmation and no unresolved effects. A subsequent active-child Stop confirms
root cancellation, sealed SDK stop and owned-tree exit/output drain without inventing the child's
missing output; tool coverage remains explicitly truncated for that interrupted observation. A
follow-up in the same public provider session recalls the prior context without tool use and
finishes with current stop confirmation and no unresolved effects. This adds live Codex subagent
evidence without implying complete Claude subagent coverage or closing the remaining
managed/platform acceptance. D5, D6, D11 and D18 remain open pending their full required outcomes.

### Harness Snapshot And Claude Continuity Verification (2026-11-13)

The final Harness stopped-snapshot correction passes a 197-test affected batch and a 43-test
focused batch, backend and web TypeScript checks, and the production API build. A narrow
independent review acknowledges the correction without a remaining material finding.

A real Claude conversation retains its original context marker and selected choice after an
operator-quiescent Harness and provider restart, verifying retained native state. The final
cancellation has current public stop confirmation and no unresolved effects. Its genuine Bash
result remains paired with the original tool call, with no new unmatched-result warning. Missing
structured command exit metadata remains unknown rather than being promoted to a successful
exit code.

A separate accepted-control race is corrected: the final control receipt can arrive after the
terminal snapshot ends its stream. Harness now reads the original receipt before the next-turn
guard, retaining unresolved requests and their original bytes. Sixty-six focused regressions,
backend TypeScript and the production API build pass; independent review finds no material
blocker. The full Harness suite passes 2,876 tests across 241 files in 283 seconds. After a normal
Harness restart, two consecutive real Claude turns complete without another reload or retained
mutation, preserve the same public provider session and original context, and use no tools.
The final macOS arm64 production image is 298,866,211 bytes uncompressed; its API-only rebuild
reuses the existing web build layer.
D5 and D18 remain open pending the managed MCP and remaining platform acceptance.

A real Codex SDK turn also calls the ordinary Core's read-only `list_apps` MCP tool and reports
the actual nine running applications. The correlated tool completes, the same public provider
session finishes with current stop confirmation and no unresolved effects, and its mutation outbox
is empty. No shell, file, lifecycle or subagent operation is used in this turn. This verifies the
real SDK-to-provider-to-Core path separately from synthetic model and peer fixtures.

### Fresh Workspace Authority Correction (2026-11-13)

Managed acceptance exposes an initial source-run failure: generic workspace preparation does not
populate the cached conversation association, but the old provider resource builder substitutes
revision zero. The correction reads current participation for each selected workspace under the
original actor or exact task attempt. New unprepared decision continuations refresh only their
existing worktree revisions and preserve the original order/CWD; prepared start retries retain
their exact bytes. Core's revision and access checks are unchanged.

The final batch passes 240 affected provider/task/workspace/recovery tests and 39 focused
preservation/continuation tests, backend TypeScript and the exact production API build. Independent
review finds no material blocker. The managed source-file/command and MCP acceptance is rerun on
this candidate; these unit checks do not yet establish that integration result.

### Independent MCP TTL Verification (2026-11-13)

The opt-in managed acceptance holds the original Core `list_apps` approval for 310 real seconds
while Docker Harness remains physically stopped and the Local provider keeps its original process
identity. Core resolves the same original actor/provider/run-bound Decision and accepts the exact
resolution replay. The provider continues independently and the actual tool payload reports
Harness stopped and the provider running, before Harness starts again. Reattachment replays the
same public run/generation/configuration, completed Core receipt and authoritative known stop.
Patch/read/command, question response and denied-write assertions also pass. Combined with the
recorded Claude stop/outcome checks, this verifies D18 without shortening the production TTL.

This flagged outer suite is not yet green: its next assertion compares the number of consumer
context observations with all fixture model requests after the replay gap. That telemetry
assertion is under investigation; the independent TTL/tool-payload checks above passed before it.
Parent-owned Finish confirms removal of the failed test child's resources. D5 remains open for
the remaining complete integration and target-platform acceptance; D6 and D11 retain that dependency.

### Latest Context Snapshot And Final Managed Verification (2026-11-13)

D19 adds an optional root context observation with its original positive public sequence and
explicit nullable usage. Snapshot validation preserves decimal precision above 2^53 and rejects
future sequences. The runtime retains new observations across restart and replay trimming without
backfilling old records. Harness snapshot/live projection shares one durable identity and excludes
child observations. Every received fixture measurement joins its actual ordinary model request;
loaded MCP definitions and wire-token estimates remain exact. The latest offline measurement and
a fresh resumed measurement are required, without claiming a complete offline telemetry ledger.

Verification passes 844 SDK tests and its publishable build, 577 runtime tests with three
Windows-only skips, 165 Harness provider/context tests, 43 Python acceptance checks and the exact
Harness API build. The .NET parity passes 12 HTTP/SSE tests and a net8 source-generated build;
existing XML and unavailable vulnerability-feed warnings remain visible. A non-gating SDK
test-inclusive typecheck still reports 38 existing fixture diagnostics: a memory-only compiler
overlay removing the D19 test additions yields the same file/code diagnostics. The supported SDK
build excludes test/spec fixtures and passes; no unrelated fixture typing is changed.

The final isolated macOS CI projection installs 204 packages in three seconds with its existing
npm download cache, passes 577 tests with three Windows skips and all three provider checks/builds.
The final pinned Linux arm64 projection passes the same 577 tests and three builds, with only
the Windows skips. Two earlier Linux fixture failures are corrected using the journal's existing
serialization boundary and an explicit wait for the real sampler callback, respectively. Missing
records, the production one-second sampling interval, health failure and isolation/stop assertions
remain unchanged. The final Linux focused checks pass 38 tests; its container, projections and npm
cache are removed with unchanged source hashes. This is Linux mechanism/package evidence, not
Linux Core/Docker-to-Local host transport or Windows execution acceptance.

`HOSTY_OLLAMA_ACCEPTANCE=1 HOSTY_PROVIDER_MCP_TTL=1 npm run test:integration -- agent-providers`
passes the complete managed API suite on macOS arm64: independent SDK-only consumer before
Harness installation; Docker Harness with three Local providers; crash fencing and quiescent
updates; durable input/attachments and corrupt-conversation isolation; file/command/question/denial
and Core MCP tooling; 310 real seconds with Harness stopped; latest-context restoration and a
fresh continuation without completed-tool replay. Docker cold start is 7.512 seconds and warm
restart 7.261 seconds, retaining app identity/data. Parent Finish confirms removal of the child
Core, containers, processes, ports, credentials and temporary source/build resources.
The final tested production Harness image is 298,872,166 bytes uncompressed on arm64.

The optional final Chrome/Shell visual review is blocked by an open browser-extension panel
before normal test-user login; it is explicitly skipped, not counted as a browser pass. The
server's normal password/app-code identity checks pass. Earlier ordinary Shell settings and real
Codex/Claude browser observations remain separately recorded above.

The final ordinary Harness, Codex and Ollama restarts are healthy. The initially refused Claude
restart is resolved by the explicitly approved diagnostic archival below. No commit, publication,
Nx installation or workspace/lease removal is performed. D5, D6 and D11 remain open for their
outstanding complete browser/target-platform acceptance and the dependent finalization.

### Approved Diagnostic Archival Verification (2026-11-14)

The owner approves the refreshed exact two-path archival after two added stream-closure notices
and retention timestamps are independently classified. Only the old diagnostic Harness chat and
its Claude provider aggregate move into a reversible archive after normal Core Stop of those two
apps. All 584,749 payload bytes and their equal-size backups match the reviewed inventories before
and after restart. The unknown historical outcome, original cancellation and all nine pinned
native journal/process proof hashes remain unchanged; archival supplies no inferred tool exit or
successful outcome. Twenty-five isolated helper tests and exact online/offline checks pass.

Both apps restart healthy against the same Core, workspace source and runtime selections, with
a new Claude process. Public Harness reads return 404 for the archived chat and preserve the other
Claude/Codex QA conversations, account selections, confirmed stops and empty mutation queues.
Account/default/profile and native-home preservation checks pass. Startup retention timestamps
are classified separately; two other chat removals are explicitly confirmed as manual owner
actions and are not restored. Fresh inference is not repeated: the diagnostic app identity's Core
delegation requires activity renewal. This recovery does not replace the remaining browser and
target-platform acceptance in D5.

### macOS Browser And Assigned-Port Acceptance (2026-11-14)

The managed macOS suite passes a real Local provider port reassignment from 24398 to 28143.
Core plan/apply leaves the old listener/process running until the explicit quiescent provider
restart. The old PID/listener then disappear, the new endpoint requires authentication, and Docker
Harness resumes the same account, public/native session and configuration without its own restart.
Eight helper checks cover wrong instances, assignments, uncertainty, endpoint aliases and SSE.

Chrome signs into the separate test Core through normal password login and Core app-code flow.
Provider settings create a synthetic account through the UI and retain it and the existing default
after reload. Embedded Harness settings have no duplicate title or retired Providers tab. A fresh
chat updates its header with its first message without reload, stops an observed active SDK process
with confirmed termination and no unresolved effects, resumes the same provider session, retains
history after reload and remembers its explicit provider in another new chat. The ordinary Codex
settings separately show account limits before a message is sent. The managed suite exits zero;
Docker cold/warm lifecycle takes 7.695/7.179 seconds, and parent Finish verifies resource removal.

Real Claude child completion passes. Four active-child diagnostic cancellations confirm physical
SDK/tree termination but retain an unresolved child invocation; no continuation is attempted after
any unknown result. A typed-hook candidate passes 594 tests and three provider builds without
closing the live case. A bounded public-SDK history reader subsequently passes 700 tests, type
checks and three builds, including a correction for the SDK's normalized multi-block UUIDs.
That UUID correction is independently source-verified but does not establish the cause of the
earlier single-block failure.

The instrumented live attempt identifies `file_guard_failed`: production skill discovery uses a
temporary HOME whose `projects` directory redirects through the managed connection home to durable
history. That reader candidate rejects the legitimate owned layout. Earlier isolated read probes select the
durable home directly and therefore do not cover the actual execution layout. The corrected
candidate carries a registry-owned canonical history binding separately from execution HOME,
validates the exact owned redirect and passes the real registry/skill-wrapper/tracked-reader
pipeline, including foreign-target rejection. It passes 716 runtime tests with three Windows-only
skips, type checks and all three provider builds.

### macOS Claude Cancellation And Continuation (2026-11-15)

The owner explicitly authorizes reversible retirement of the four failed QA conversations and
their exact provider aggregates. With both owners normally stopped, eight paths containing
3,326,926 bytes move into app-owned diagnostic archives after verified complete backups. All
twenty-six native proof files remain unchanged. Four unknown outcomes, original canonical cancel
requests and applied receipts are retained byte-for-byte; they are neither repaired nor replayed.
The independent pre-start audit passes, and normal Claude/Harness startup restores readiness on
the same Core with unchanged account bindings and the tested workspace source.

A fresh real Claude session completes a foreground native Agent/Bash child. A second turn starts
an observed owned Node timer inside another foreground child; a single UI Stop cancels it while
the process is live. The public-SDK helper matches the exact failed child terminal and closes in
319 milliseconds within the unchanged ten-second stop deadline. The provider reports cancelled,
confirmed stop and no unresolved effects; its native/helper trees and output pipes are closed.
The original cancellation UUID, bytes and applied receipt remain consistent. The command exit
status remains unknown rather than being inferred from the failure text or process disappearance.

A third turn resumes the same public/native session, provider installation and account revision,
recalls the original marker and performs no tools or repeated commands. It succeeds with confirmed
stop and no unresolved effects, and the latest root context agrees with its recorded event
sequence. This closes D18 and the three targeted macOS checks. The managed test Core from the
browser/assigned-port run is already finished with owned resource removal verified.
Linux and Windows execution acceptance remains deferred under D5.

### Final Isolated Provider CI Verification

The final owned-history candidate passes the actual `node scripts/ci-agent-providers.mjs` entry
point on macOS arm64 with Node 24.18.0, npm 11.16.0, `CI=true` and a version-one `CI_PLAN` selecting
all three providers. The run clears inherited Node module hooks and provider/Core credentials,
uses empty npm user/global configuration and stages the existing projected lock closure outside
the registered source worktree. It installs 204 packages in three seconds, runs common runtime
type checking and the full suite once, then typechecks and builds each selected provider.

The result is 716 passing tests and three Windows-only skips across 66 passing test files and one
skipped file. All three provider checks/builds pass. The complete helper exits zero in 121.617
seconds with the existing npm download cache; this is a local measurement, not a fresh GitHub
runner or cold-network benchmark. Before/after hashes of all 347 source inputs match, and the
helper removes its temporary projection. No implementation correction is required by this run.

This completes the final local minimal-dependency CI gate. D5, D6 and D11 retain their remaining
target-platform acceptance, GitHub CI/release qualification, feed/catalog coordination and final
documentation requirements.

Pre-publication CI selection validation finds and corrects one missing edge: changes to the shared
npm workspace projection select Harness packaging as well as all three providers. The regression
requires both selected jobs to succeed. The policy, release, integration-entry and publication-gate
suites pass all 273 tests after the correction.

The publication candidate integrates current main with a regular merge, preserving Whisper
retirement and moving its updated Hono and Node adapter versions into the actual provider lock
closure. The isolated CI helper passes again on this integrated source in 121.439 seconds with
716 passing tests, three Windows-only skips and all three provider checks/builds.

### Initial GitHub Qualification And Corrective Checks (2026-11-16)

The first PR CI attempt runs all selected components. Every build, provider/Harness check and all
four NativeAOT jobs pass; the required aggregate correctly fails on eight Core test failures.
The complete attempt takes 19 minutes 49 seconds, with macOS NativeAOT plus paired-update
verification on the critical path at 19 minutes 15 seconds. Providers take 2 minutes 25 seconds
and Harness takes 5 minutes 41 seconds. The nearest main Harness run takes 5 minutes 23 seconds
with a different installation-cache result; this comparison does not demonstrate an overall CI
speedup or measure a production Docker release build.

The corrective batch replaces stale Harness runtime and MCP wire expectations, adds valid
candidate manifests to activation fixtures, and isolates retained recipe read failures from
ordinary candidate-source availability on Linux. Valid aggregate recipes continue to bypass
obsolete legacy metadata. The affected local batches pass 33 contract/manifest cases, 10
activation cases and 21 inventory/source-availability cases.

Accepted PR findings also correct bounded opaque connection IDs and complete replacement of
run-owned MCP policy. Eight focused MCP regressions cover removed exceptions, automatic guard
invalidation, manual approval continuity, independent runs and concurrent catalog/configuration
updates. A full projected provider run reports one existing Ollama event-wait timeout; the exact
test passes three isolated repeats and its complete 39-test file without source changes. The
cause is not established. The clean final helper subsequently passes all 724 tests with three
Windows-only skips and all three provider checks/builds in 122.824 seconds. All 348 input hashes
remain unchanged and the temporary projection is removed.

An additional unfiltered local Core run is deliberately cancelled after 1,382.533 seconds without
a reported test failure or final count. A diagnostic stack shows Git-backed workspace preparation
in the owned test host; it does not establish the cause of the longer macOS duration. All owned
runner/host processes exit after graceful cancellation. This incomplete run is not a pass; the
corrected full Core suite remains required in GitHub CI. D5, D6 and D11 remain open.

### Hosted Core Qualification And Pagination Review (2026-11-16)

The corrected PR CI attempt 2912 passes all 26 jobs in 18 minutes 36 seconds on the reviewed
source. The full hosted Core suite passes 5,052 tests with seven platform/opt-in skips and no
failures, satisfying the earlier full-suite verification boundary. macOS NativeAOT with paired
update verification remains the critical path at 18 minutes 7 seconds; providers take 2 minutes
30 seconds and Harness takes 5 minutes 41 seconds. The additional cancelled local macOS run
remains explicitly incomplete. These runs do not establish Linux/Windows provider end-to-end
acceptance or production release publication.

The remaining pagination review is reproduced through the public HTTP/SDK path: mixed-case IDs
lose two of five entries with a page size of one. Connection and session lists now share one
ordinal comparator for sorting and cursor advancement, without changing identifier case. Two
regressions require complete enumeration, unique cursor roundtrips and existing invalid-cursor
bounds; the affected provider/surface/store batch passes 22 tests and runtime type checking.

The final isolated pagination candidate passes the actual all-provider CI helper in 125.610
seconds: 726 passing tests, three Windows-only skips, shared runtime type checking and all three
provider checks/builds. All 348 source input hashes remain unchanged and temporary staging is
removed. The PR candidate retains the previously approved artifact versions.

### Workflow Cleanup Observation Regression (2026-11-16)

The final review-candidate hosted provider job exposes one asynchronous test assertion race:
native stop confirmation is durably published before the synchronization tail removes its local
workflow server. A controlled terminal-publication observer reproduces the original assertion
failure; the observer is removed from the shipped test. The test now waits for confirmed native
exit and workflow removal together, retaining its original five-second bound, workflow-only
server assertion and prohibition on minting Core MCP authority. Production lifecycle ordering
and authorization remain unchanged. All 24 affected native-driver/workflow/MCP tests and runtime
type checking pass; an independent review confirms the correction.

The exact test-only cleanup candidate passes the isolated all-provider helper in 121.820 seconds:
726 tests pass, three Windows-only cases skip, and shared type checking plus all three provider
checks/builds pass. All 348 source hashes remain unchanged and temporary staging is removed.

### Swift Update Identity Gate Correction (2026-11-16)

The next full CI attempt passes the provider job but exposes an unrelated existing Swift client
assertion that compares retry JSON bytes. A bounded reproduction using the actual immutable
CoreUpdateAttempt model produces two 93-byte encodings across 128 encodes while every decoded
identity remains identical. Core binds a retained update by request ID and offer ID after JSON
deserialization; property order has no idempotency meaning. The corrected test checks both
requests against the exact two-field dictionary plus POST, path and content type, retaining the
dropped-response and fixed-ID recovery assertions. All 185 HostyKit tests pass in 25 suites, and
an independent review confirms the test-only correction. No Swift shipping behavior or artifact
version changes. The already-passing provider source and its verification remain unchanged.

### Admission-Scoped Workspace Lease Fencing (2026-11-16)

The next accepted review identifies a late-acquisition race between durable lease intent and
actual workspace claim creation. D20 serializes direct workspace operations and complete
agent-origin MCP prepare/acquire/release effects per admission, using a separate refcounted gate
that is removed only after all holders and waiters leave. The global metadata-write gate does
not span workspace effects. Cleanup persists a closing fence, including an empty intent list,
before acknowledging release; closed admissions and already-released UUIDs reject acquisition.
Cancelled/failed cleanup retains durable intents for exact retry after expiry, revocation or
Core/store reconstruction.

Agent-MCP individual release checks the retained session, UUID and actual claim owner under the
existing workspace mutation locks. A distinct private release journal kind preserves the original
request/command identity and prevents replay through ordinary broader workspace administration.
Interrupted release remains unknown without replaying foreign removal. Ordinary non-agent MCP
behavior and unrelated admissions remain independent.

The exact final Core project builds with zero errors. The final expanded batch passes all 49
cases: 13 lease interleaving/recovery cases plus the complete Core agent-provider and external
workspace MCP HTTP suites. Controlled real-claim barriers cover all three acquisition origins,
individual release, foreign reclaim, interrupted release, empty closure/reopen, cancelled waiters
and lost-reply/revocation recovery. All nine source/test hashes remain unchanged during final
verification and every owned test process exits. Independent source review finds no remaining
material issue in the five production paths.

The preceding reviewed head's hosted CI passes all 26 checks in 12 minutes 27 seconds, including
Swift and Windows NativeAOT. A prior single Windows replacement-readiness failure lacks enough
runner diagnostics to establish a cause and does not reproduce in that successful run; no timeout
or production startup change is inferred from it. The new lease source still requires its own
exact-head CI qualification. D5, D6 and D11 retain their remaining accepted scope.

### Durable Provider Workspace Cleanup Retry (2026-11-16)

D21 addresses transient Core failure after confirmed native stop. The provider saves a private
pending release receipt before dispatch, retains the original admission and deterministic request
UUID across failed or lost replies and reconstruction, and acknowledges only Core
`state: released`. The existing maintenance pump retries pending receipts without consumer reads,
decisions, execution renewal or native replay. Concurrent cleanup coalesces and shutdown drains
in-flight acknowledgements. Local MCP teardown remains immediate.

Only records with a persisted execution input are eligible: response-only superseded reservations
and before-admission cancel placeholders cannot acquire execution leases and create no cleanup
requests. Real executions with no initial workspaces remain eligible because MCP-created leases
are retained by Core. Both negative cases and three retry regressions reproduce failures before
the correction. The final affected batch passes all 60 tests, runtime type checking passes and
independent review finds no material issue.

The frozen final candidate passes the actual isolated all-provider helper in 122.500 seconds:
733 tests pass, three Windows-only cases skip, shared type checking and all three provider
checks/builds pass. All 348 source hashes remain unchanged and temporary staging is removed.
This uses an existing npm cache and is not a cold GitHub benchmark. The preceding Core-lease
head passes all 26 hosted checks in 16 minutes 29 seconds; this additional provider correction
requires fresh exact-head CI. D5, D6 and D11 retain their remaining accepted scope.

### Engine-Neutral Runtime Boundary (2026-11-16)

D22 restores the approved code boundary. Each provider owns its adapter, native event parsers,
account authentication/refresh, history and skill policy, capabilities, input preparation,
settings descriptors and build assets. Shared startup receives structural application contracts;
its connection bookkeeping, HTTP/SSE, execution journal and process containment contain no engine
catalogue or vendor SDK dependency. An unrelated engine exercises startup, settings, account
revisions/reservations and actual worker admission with an opaque engine identity. Source/dependency
checks enforce the production boundary. Existing storage formats, account/history paths and public
HTTP/SSE versions remain unchanged. The initial refactor candidate moves the three provider artifacts and private runtime from
0.1.0 to 0.1.1; Core, Harness and public SDK versions do not change for this refactor.

The frozen source passes the actual isolated all-provider CI helper on macOS arm64: 750 tests pass,
three Windows-only cases skip, shared/runtime and all three app type checks pass, and each provider
production build passes. Its 344 recorded source inputs remain unchanged and temporary staging is
removed. The commands are `CI=true CI_PLAN='{"version":1,"components":["codex-provider","claude-code-provider","ollama-provider"]}' node scripts/ci-agent-providers.mjs`,
`npm run test --workspace @haas/hosty-harness -- src/agent-providers/provider-admission.test.ts test/independent-agent-consumer.test.ts`
(10 passing tests), packaging fixtures (40 passing tests), and Node CI/policy/integration-routing
fixtures (58 passing tests). Version, documentation/link and whitespace checks pass.

`npm run test:integration -- agent-providers` passes the Core/CLI builds, scripted native probes,
production Harness Docker build and managed acceptance. After the final bounded engine-identity
and revoked-key usage regressions, the frozen candidate repeats
`python3 scripts/check-workspace-activation.py . agent-providers --managed` successfully. Normal
password/app-code login, all three provider readiness/settings, an independent SDK-only consumer
without Harness, restart/resume, pending approvals, unknown-stop fencing, confirmed cancellation,
queue/attachment durability and corruption isolation pass. Docker cold/warm startup measures
7.708/6.857 seconds locally; this is not a cross-machine performance claim. Both parent owners
Finish their child environments; independent checks confirm fixture roots and child-labelled
containers, networks and volumes are absent. No ordinary-data runtime is changed.

The optional installed-only Claude SDK probe is not enabled, and no personal provider credential
is copied or paid inference claimed. Linux/Windows end-to-end acceptance and final reconciliation
remain in D5 and D6. D11 is completed independently on main before this refactor is integrated.

### Public Stable Feeds And Marketplace Installation (2026-11-16)

The owner explicitly requests completion of provider publication and a fresh installation through
Marketplace. All three independent source releases are retained at version 0.1.0 from merged commit
`f1acc57c108eee0b6ec9f8bdafdf4c2f5b3d17c4`. Exact main CI passes all 26 checks in 17 minutes
26 seconds. The final PR CI passes all 26 checks in 26 minutes 55 seconds, including a five-minute
macOS runner queue; these are observed timings, not a controlled speedup.

The [Ready release run](https://github.com/alex-de-haas/docker-host/actions/runs/43879287198)
builds the production Harness coordinator image in 18 minutes 42 seconds and retains all three
complete provider candidates. Its overall result fails only because an unrelated Demo App
development-image lookup returns registry HTTP 401. Provider descriptor, release-ID, source,
manifest and icon hashes are independently recomputed before exact per-app stable promotion.
The [Codex](https://github.com/alex-de-haas/docker-host/actions/runs/43884264273),
[Claude Code](https://github.com/alex-de-haas/docker-host/actions/runs/43884268733) and
[Ollama](https://github.com/alex-de-haas/docker-host/actions/runs/43884273750) promotions pass;
anonymous public readback verifies unique stable defaults, immutable manifests and source pins.
No platform or unrelated application stable pointer changes.

[Catalog PR 26](https://github.com/alex-de-haas/hosty-catalog/pull/26) adds all three entries together.
Sixteen entry validations, sixteen tooling tests, offline generation and full network vendoring pass.
The exact merged catalog [Pages publication](https://github.com/alex-de-haas/hosty-catalog/actions/runs/43885883055)
passes and serves sixteen cards with matching provider icons and stable feed URLs.

A fresh Core-managed macOS child runs source Core 0.180.0 with public stable Shell 0.121.0 and
Marketplace 0.13.0. Normal password login, Marketplace Install buttons and Core confirmation pages
install each provider from its public stable feed with the production Local runtime. Core readback
verifies version 0.1.0, exact release/manifests/source paths, source commit, expected agent role,
three Decision permissions and healthy services without Harness. Each provider's embedded settings
complete normal Hosty sign-in and show the empty authenticated connection list. All nine anonymous
probes pass: health is ready and protected agent/settings APIs return 401. No provider account,
model download or inference is needed for this fresh-install check.

A duplicate Codex confirmation page invalidates its older form; the same original approval is
reopened and accepted normally after confirming no installation occurred. No duplicate install
request or approval bypass is used. Owned browser/helper consumers stop and release their claims.
Sandbox Finish succeeds, with no retained process or data root.

The catalog states Core 0.180.0 and local tool prerequisites. Public platform stable remains
0.172.0; daily supplies 0.180.0. This provider publication does not upgrade ordinary installations.
The remaining Linux/Windows end-to-end provider acceptance stays in D5; final reconciliation stays
in D6. D11 is complete without declaring those remaining deliverables passed.

### Refactor Integration With Current Main (2026-11-16)

The PR integrates the completed D11 release/updater cleanup and Codex sign-in diagnostics from
current main with a regular merge. The diagnostics and confirmed login cleanup follow the moved
Codex connection implementation; the shared runtime keeps its engine-neutral boundary. The already
released provider versions require the refactor artifacts to advance from 0.1.1 to 0.1.2, while
the private runtime remains 0.1.1 (main has 0.1.0). Final verification is repeated on this integrated
candidate before publication of the resolved merge. The owner separately authorizes committing
the refactor and opening its pull request.

The integrated candidate passes the isolated all-provider helper with 779 tests, three Windows-only
skips, four type checks and three production builds. All 345 source inputs retain their recorded
hashes and temporary staging is removed. Scripted native probes pass; the installed-only Claude
probe remains unselected. The final managed agent-provider acceptance repeats successfully against
this source, including normal login, independent consumer/provider readiness, restart/resume,
pending approvals, unknown-stop fencing and confirmed cancellation. Docker cold/warm startup is
7.589/6.656 seconds locally. Parent Finish confirms child resource removal, and the test process,
ports, fixture data, credentials and build/snapshot directories are removed. Documentation, version
and whitespace checks pass; D22 is verified on the integrated source. D5 and D6 remain open.

### Harness Context Recovery CI Checkpoint (2026-11-16)

The hosted candidate passes every check except Harness, where one offline-context recovery case
exceeds the polling helper's one-second persistence deadline. A controlled 1.2-second delay of only
the context transcript append reproduces the same assertion failure in both parameterized cases;
the hosted runner's exact scheduling cause is not established. The test subscribes before emission
and awaits the exact committed context notification before asserting its stored event count. The
original usage, identity, reopen and no-resubmission assertions remain, with the existing overall
test timeout and no production change.

Both cases pass under the same controlled delay, and that diagnostic probe is removed. The full
public-provider consumer suite passes 154 tests across 13 files; Harness type checking and diff
checks pass. This test-only correction changes no runtime artifact version. The existing Codex
review has no findings; exact-head CI remains the publication gate.

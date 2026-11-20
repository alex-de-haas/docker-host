---
created: 2026-09-29
updated: 2026-11-20
summary: Apps publish named interface implementations under scoped Core authority so Harness users can choose where to send dictation and text for read-aloud.
components: [apps/core, packages/app-sdk, packages/app-sdk-dotnet, apps/codex-provider, apps/harness]
---

# Provider Consumption And Speech

## Permissions And Review

Core accepts `providers.speech-to-text`, `providers.text-to-speech`, `providers.translation` and `providers.assistant`. Each grants discovery and
use of every confirmed provider in its category, including later installations. There is no separate
use permission or per-provider ACL. Supply roles are `speech-to-text`, `text-to-speech`, `translation` and `assistant` in `provides`. These
roles require installation/update confirmation. Ordinary runtime apps can supply and consume these
interfaces. Reviewed `agent` providers and `providers.agent` use the exact-operation execution
contract described below; their accounts and native sessions belong to independently installed apps.

Translation uses the same app-authorized credential flow as speech. The independent OPUS app
supplies the repository’s translation interface; Harness and the extracted agent providers expose no
translation interface. Text and Markdown travel directly to the selected provider; Core stores neither
source text nor translations. See [Translation providers](../translation-provider/feature.md) for
limits, SDK calls, Markdown integrity checks and measured latency.

`corePermissions` is required authority. `optionalCorePermissions` is optional authority. Lists must
contain known, unique, disjoint names. Core confirmation offers optional choices unchecked on install,
preserves previously selected unchanged choices on update, and removes grants for removed declarations.
New declarations and optional-to-required transitions require review. Core stores declarations, grants
and a permission revision independently of the live source manifest. Restart and source adoption do
not grant permissions.

Shell's administrator-only Permissions tab shows accepted declarations, effective grants and the
current manifest. Required changes and optional choices use isolated Core permission-only confirmation,
including live development edits and legacy installations. A delegated app can request review only
for itself using `permissionsAppId`. Confirmation is bound to installation, permission revision,
source/runtime and the complete manifest digest. See [App permission management](../app-permission-management/feature.md).
Changing optional grants invalidates an already reviewed update plan: enqueue rejects it synchronously
before marking the app as updating or starting background work. Interface contract validation identifies
the declared provider category in both the error code and message.

## Discovery And Authority

Server-side SDK clients use the calling app's `HOSTY_APP_ID`, `HOSTY_CORE_ORIGIN` and
`HOSTY_APP_SERVICE_TOKEN`. Internal Core routes are:

| Method and route (below `/api/internal/apps/{appId}`) | Behavior |
| --- | --- |
| `GET /permissions` | Own required, optional and granted permission names |
| `GET /providers/{kind}` | Confirmed static entries in an authorized category |
| `GET /providers/{kind}?named=true` | Static entries and the currently published named implementations |
| `POST /providers/{kind}/implementations` | Publish a full ordered snapshot for the caller’s reviewed interface key |
| `POST /providers/{kind}/token` | Non-agent category credential; `{ providerAppId, key }` selects one interface |
| `POST /provider/introspect` | Provider validates `{ token, kind, key }` on every request |

Descriptors contain app ID, opaque installation ID, name, category, interface key/version,
capabilities, URL and availability.
Discovery and credential issuance resolve provider API URLs from the endpoint's direct transport
address. Generated browser hostnames and configured public origins are excluded from backend calls,
so local speech recognition does not depend on browser-only name resolution or public ingress.
Core 0.125.0 also includes `uiSurfaces` for assistants: declared panel, navigation and entrypoint
endpoint identities, paths and resolved browser URLs. Consumers validate handoff destinations
against these surfaces without an additional `apps.read` grant or an assumption that API and UI
share an origin. SDK 0.24.0 exposes this additive field; older Core omits it. Plans 0.4.0 uses it
for [document discussions](../documents-app/feature.md#discuss-a-document).
Stopped providers remain discoverable but cannot receive a new credential. A running speech process
can still be loading its model; its capabilities response distinguishes inference readiness.

Core signs separate, two-minute `hosty_provider.1` credentials bound to both installations, both
permission revisions, the target category and key. Introspection checks live grants and availability;
revocation, updates, removal and reinstallation invalidate prior credentials. A provider cannot
introspect a credential for another provider. SDKs send the app service token only to Core and the
provider credential only to the selected endpoint. Audio travels directly from the consumer's backend
to the provider. Core stores neither audio nor recognition results. No automatic provider/cloud fallback
occurs. Grant changes block subsequent requests; they do not retroactively retract already accepted work.

Assistant calls additionally require `X-Hosty-User-Token`, an app identity or delegated token addressed
to the caller. Core checks the user's access to both apps. Harness retains its administrator-only policy,
accepts provider credentials only on `/api/assistant/v1/handoffs`, and binds handoffs to the acting user,
consumer app and consumer installation. These credentials do not grant access to other conversations,
settings, MCP, agent connections or general Core APIs. Finalization always uses a
draft-only policy for provider-originated handoffs, regardless of the immediate-handoff setting.
Only Harness's own operator clients can dispatch immediately. Provider credentials never become
general delegation.

### Named implementations

Core 0.184.0 supports the `implementations.named` capability on a reviewed interface entry. One
entry can publish several choices under the same key. Its backend authenticates as the current installation and publishes an increasing revision
with a complete list of up to 256 opaque IDs, display names and availability flags. An empty list withdraws every
choice. A retry of the same snapshot is safe. Core persists the catalog and rejects conflicting
replays and older revisions. Publication requires the installation-bound service token issued to
that runtime. A change to the reviewed interface declaration requires a new publication. Removal or reinstallation invalidates the old installation’s choices.

Consumers persist the app ID, installation ID, interface kind, key and optional implementation ID.
Discovery supplies a label such as **Codex Provider · Work** and distinguishes duplicate names.
Renaming preserves a choice. A named invocation presents a credential bound to the exact
installation, key and implementation. The provider checks the identity returned by introspection.
Legacy discovery exposes static entries only. Selecting a named entry requires its implementation ID.

## Agent Execution Providers

Core accepts the reviewed `agent` supply role and `providers.agent` consumer permission. Service-only
`GET /api/internal/apps/{consumer}/providers/agent` lists confirmed installations without granting
native invocation. An explicit `{ appId, installationId, key }` selection identifies a provider;
Core infers no vendor, account or authority from its name. Independent consumers need no Harness
installation.

Execution uses `POST /api/internal/apps/{consumer}/agent/authorize`, not the broad category-token
route. The consumer sends only the exact operation, method, path, SHA-256 body digest and bounded
configuration/resource ceiling. Core validates the original current user or retained exact task
attempt and the existing administrator requirement. Inputs, uploads, snapshots and SSE events travel
directly between consumer and provider. Core's own skills, MCP and Decisions keep their ordinary
platform responsibilities.

An installation with reviewed `providers.agent` can request read-only history delivery through
`POST /api/internal/apps/{consumer}/agent/history/token` using its service identity. The selected
provider introspects the credential with its own service identity through
`POST /api/internal/apps/{provider}/agent/history/introspect`. The resulting scope is this
consumer installation's own runs at that provider. Interactive operations keep their exact
authorization and the consuming app checks user access before serving its stored conversations.

The selected provider introspects the request, durably accepts the public command and admits native
work through its own Core identity. It renews admitted authority and obtains selected-tool MCP
credentials without depending on the consumer process. Renewal respects the original expiry and
current grants; the provider's service identity is not replacement user authority. Metadata-only
settlement of its exact Decision records can continue after execution expiry, but authorizes no
new native effects. Provider-only scoped workspace cleanup releases exact retained lease identities.

TypeScript exports `AgentClient`, request preparation, validators, SSE recovery and OpenAPI/event
schemas from the `/agent` entrypoints. Its authorization callback keeps Core credentials in the
consumer backend. .NET exposes `HostyAgentExecutionClient` and typed `HostyProviderClient` agent
bridges; its stream API uses explicit cursor/snapshot recovery. See
[Agent provider execution](../agent-provider-interface/feature.md) for routes, native resume,
immutable skills, ownership, capabilities, stop evidence and the clean-slate Harness boundary.

## Task Providers And Executors

Core 0.159.0 adds independent `tasks` / `task-executor` roles and
`providers.tasks` / `providers.task-executor` consumer permissions. Both declarations use version 1
and the existing reviewed installation registry. Attributed calls check user access to both apps at
issuance and introspection. Applications own task data and execution; Core has no task database.
The [basic task contract](../basic-tasks/feature.md) defines numbering, lifecycle, replay and stop
confirmation. TypeScript SDK 0.36.0 and .NET SDK 0.11.0 provide typed task/execution clients. Harness
keeps profiles private and preserves its administrator boundary. Provider tokens are valid only on
the corresponding task/executor routes.

## SDKs

TypeScript SDK 0.53.0 and .NET SDK 0.19.0 support named discovery, snapshot publication, speech
capabilities and streamed synthesis. A TypeScript consumer can resolve a saved dictation choice as follows.

```ts
const speech = new ProviderClient();
const providers = await speech.listImplementations("speech-to-text");
const selected = providers.find(p => p.appId === choice.appId && p.installationId === choice.installationId
  && p.key === choice.key && (p.implementationId ?? null) === (choice.implementationId ?? null));
if (!selected) throw new Error("Selected provider is not installed.");
const result = await speech.transcribe(selected, wavBlob, { signal, language: "ru" });
```

`permissions`, `list`, `speechCapabilities`, `transcribe` and provider-side `validate` accept cancellation.
`assistant(selected, getUserToken)` returns the existing version-one `AssistantClient`, minting fresh
bounded authority per operation. Provider changes require explicit reconnection. Redirects carrying
credentials are refused. Assistant HTTP failures expose `AssistantError` with the provider status
and code. Shell preserves these refusals, including a 409 `request_conflict` when a request identity
is reused with different input, instead of reporting a transport failure.

.NET `HostySdk.App` 0.7.0 exposes `HostyProviderClient` with `PermissionsAsync`, `ListAsync`,
`SpeechCapabilitiesAsync`, `TranscribeAsync`, `ValidateAsync` and `SendAssistantAsync`. The latter sends
existing `/handoffs` operations with the acting user's credential. Supply an `HttpClient` with automatic
redirects disabled and a suitable transcription timeout, plus `HostyAppOptions.FromConfiguration(...)`.
Long-recording consumers use a deadline of at least fifteen minutes thirty seconds. TypeScript
SDK 0.47.0 accepts `transcribe(..., { timeoutMs: 930_000 })`; its five-minute default remains intact.
The optional integer deadline is bounded to 1–930,000 milliseconds and covers authority issuance,
upload and response. A request-owned matching Undici transport aligns response-header/body timers
with that deadline without altering the global HTTP dispatcher.
Methods accept `CancellationToken`. Both SDKs retain stable HTTP status/error codes and refuse interface
versions other than 1. For container callers, loopback provider URLs are rewritten to the Core host's
`host.docker.internal` address; that address must be reachable from the container runtime.

## Speech Provider Applications

Speech recognition is supplied by an independently installed application with a reviewed
`speech-to-text` interface. Core and the SDKs discover the selected provider through the contract
above; neither requires a particular app ID, engine or model. Provider readiness and advertised
media, byte and duration limits remain authoritative for consumers.

Codex Provider exposes a named dictation or read-aloud option for each API connection whose
administrator enables that role. Local Speech can supply dictation alongside it. See
[Codex speech connection settings](../ai-gateway-providers/feature.md#speech-on-codex-api-connections).

The repository's former Whisper runtime app is retired in favor of the separately maintained Speech
application. Its native implementation, model settings and hardware acceptance plan are removed;
this does not change the generic provider contract or Harness dictation. Provider-specific builds,
models, inference tests and deployment requirements belong to the provider's own repository.

Text-to-speech v1 uses `GET /capabilities` and `POST /speech`. A ready provider advertises
`audio/pcm` and a maximum of up to 4,000 UTF-16 code units per request. The consumer sends
`{"text":"…"}` and receives streaming little-endian signed 16-bit mono PCM at 24 kHz.
Cancelling playback closes the upstream request.

## Harness Dictation

Harness 0.105.0 requests separate optional speech grants. **Settings → Speech** stores
**Dictation** and **Read aloud** separately for each signed-in user. Both choices survive chat
changes and reloads. A single static dictation provider preserves existing microphone behavior.
Selecting a named connection is explicit. A withdrawn selection remains visible as unavailable
until the user changes it. The
browser converts completed recordings to the WAV baseline. Chat recording stops before the smaller
of ten minutes and the selected provider's advertised duration/byte limit, with an elapsed/limit
display. Ready WAV capabilities are required before recording; an older two-minute provider keeps
that lower limit. Canonical chat uploads include a 44-byte WAV header and are bounded again on the
server using current provider capabilities. The separate feedback recorder retains its shorter
limit. See [Longer chat speech recordings](../long-speech-recordings/feature.md). Audio
capture requires a secure browser context (HTTPS or trusted loopback) and separate browser microphone
consent. Shell 0.90.0 delegates microphone access to an embedded app's origin only with the speech grant;
changing that grant remounts the frame to release the prior document's microphone resources.

Recognized text is appended to the current editable draft, preserving text and attachments and never
sending a message automatically. Cancellation, sending, unmount and switching conversations invalidate
late results and stop microphone tracks. Permission/provider errors retain the draft. An absent grant
leaves dictation disabled. One [microphone button](../harness-composer-controls/feature.md#dictation) starts capture using the saved choice. When Core advertises permission review, the tooltip
points to Dashboard → Harness → Settings → Permissions → Review changes, including legacy declarations.
Older Core versions retain guidance based on their stored optional declarations. Source observation
alone never grants access.
The microphone's tooltip remains available on hover and keyboard focus when the button is disabled.
It distinguishes loading, discovery errors, missing consent, no providers, an unselected provider,
an unavailable provider and a message being sent. Discovery failures do not imply missing consent.

### Read aloud

A user can read an assistant response or a rendered Markdown section, including its subsections
up to the next sibling or higher heading. Harness sends the chosen plain text in its displayed
language and plays the stream with an AI-voice disclosure and a Stop control. Long selections
use successive bounded requests. Stopping or switching chats cancels playback and synthesis.

## Assistant Activity Authority

Assistant-provider issuance requires the consumer's current interactive authority and live principal,
or an explicitly scoped [background grant](../continuous-app-access/feature.md). Provider token
validation rechecks that source online. Harness uses its own continuous sign-in for interactive MCP
and workspace/publication calls; conversations require no additional consent.

Agent consumers can optionally bind their own reviewed `task-executor` v1 `session-workflow`
interface to an admitted provider run. The provider sends bounded task business commands through
Core's `/api/internal/apps/{provider}/agent/workflow` service endpoint. Core rechecks the original
actor and current attempt and signs the exact request for that consumer's public executor route;
qualified task-source and executor keys remain distinct. Selected tool names and policy are fixed
in the admission, and Disabled tools are refused at Core dispatch. This optional task business
channel has its own provider-side tool presentation and Decisions and leaves general Core MCP
access unchanged. See the [agent execution boundary](../agent-provider-interface/feature.md).

## Managed Verification

On 2026-11-20 two synthetic Codex API connections appeared under both speech interfaces in
a child Core. Renaming preserved the selected identity. Withdrawing and restoring one role
disabled and restored that choice. Two separately authenticated administrators retained different
local and named selections, and a binding copied between users was rejected.

In Chrome, a single microphone in Shell-embedded Harness appended a Russian transcript to the
existing chat draft. Reading a nested Russian Markdown section sent exactly the expected text
to the fixture provider, including names and numbers. Its stream closed when playback stopped.
Dictation in a feedback annotation preserved the overall comment and the chat draft. The provider
adapters use synthetic OpenAI responses in tests. The browser check uses controlled microphone
input and a deterministic speech provider.

The managed agent-provider suite also exercised independent providers, restart and native
session recovery. The separate feedback suite passed browser capture, draft and submission
checks. Its agent-processing scenario still expects the legacy `hosty-workspaces` MCP server.

## Testing Expectations

- Core: optional defaults and updates, review-only mutation, stale consent, stored declarations,
  role confirmation, audience/category/installation binding, live revocation and user-access checks.
  Provider discovery and issued credentials use direct transport URLs for IPv4, IPv6 and LAN endpoints,
  including apps with a configured public origin; missing transport remains unavailable. Assistant
  API addresses use transport while declared UI surfaces retain their browser addresses.
  Grant changes in either direction must reject stale update enqueue without changing operation state;
  missing speech and assistant interface contracts must report category-specific validation errors.
- Agent execution: unrelated provider/consumer IDs, exact bytes and installations, original task/user
  authority, revocation, provider-owned renewal, tool ceilings, pinned skill removal, precise lease
  cleanup and expired Decision metadata that cannot admit native work.
- Publish two named implementations of an unrelated interface and verify ordered replay, duplicate
  display names, withdrawal, revocation and installation replacement. Resolve static entries through
  both legacy and named-aware clients. Exercise category and exact-operation authorization.
- Verify independent speech settings across users and sessions, single-microphone draft insertion,
  feedback destinations, selected-section text, streaming and upstream cancellation. Use synthetic
  credentials and provider receipts to distinguish billing destinations without spending API credit.
- Run `HOSTY_NAMED_SPEECH_ACCEPTANCE=1 npm run test:integration -- harness-local` with
  Playwright and Chrome to exercise the feature in a child Core. Set `HOSTY_SPEECH_PLAYWRIGHT_MODULE`
  if Playwright is installed outside the workspace. The fixture uses synthetic Codex connections
  and a deterministic PCM provider. It does not measure OpenAI latency or pronunciation.
- SDKs: credential separation, denied access, compatibility, cancellation and assistant handoff ownership.
- Harness/Shell: optional permission UI, iframe policy, editable insertion, cancelled/late results,
  conversation switching, existing composer actions and attachments.
- Integration uses Core-managed apps and real Core identity. Local macOS verification exercised Russian
  and mixed-language synthesized recordings through independent TypeScript and .NET consumers, a Core-managed
  Docker consumer and the authenticated Harness backend. Reviewed revocation returns 403 on the next
  Harness transcription. Browser verification confirms optional consent and iframe microphone delegation. Tiny
  recognition contains errors; this is interoperability evidence rather than an accuracy benchmark.
- Owner acceptance on 2026-10-10 confirms working speech recognition and text dictation. It does not
  establish detailed hardware measurements or acceptance of the replacement Speech implementation.

- With immediate handoffs enabled, provider-originated finalization remains a draft, while operator finalization dispatches immediately.

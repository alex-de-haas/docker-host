---
created: 2026-09-17
updated: 2026-11-21
summary: Harness discovers independent local agent providers and pins qualified accounts while provider applications own credentials, native execution and history.
components: [apps/harness, apps/codex-provider, apps/claude-code-provider, apps/ollama-provider, packages/agent-provider-runtime]
---

# Hosty Harness Provider Connections

## Behavior

Codex Provider, Claude Code Provider and Ollama Provider are independently installed Local
applications. Each owns its Settings surface, account registry, native authentication, execution
processes and native-session data. Their Local and development profiles run on the host. Harness is
a consumer of the [public agent interface](../agent-provider-interface/feature.md); its application
runtime does not determine where a provider executes.

An operator installs and starts a compatible provider through Hosty and opens that application's
Settings entry in Shell to configure an account. Provider Settings use normal Core password/app-code
identity and require an authorized host administrator. Provider credentials are separate from that
browser identity. No native login, credentials or conversations are imported from Harness or an
operator's CLI environment at startup.

Harness discovers connections for its conversation provider selector and agent profiles; it has no
Providers settings tab. Account editing and sign-in belong to the provider application's Settings
entry. Setup guidance names that entry without constructing a client-specific navigation URL.
Provider settings load on entry and after actions without periodically overwriting operator edits.

Each provider Settings page presents a compact Providers heading, an Add provider button and its
connection list. Embedded content uses the full settings-frame width, aligned with Shell's page
heading and App details action. Standalone pages retain their own heading and responsive padding.
The app icons use consistent square white tiles with proportional, padded vendor marks: OpenAI's
Blossom for Codex, Claude Spark for Claude Code, and the Ollama llama. Original vendor SVGs and
attribution remain beside the presentation assets. The white tiles remain legible in dark themes
and highlighted rows; Shell resolves the declared assets without provider-specific styling.

Each provider has its own account default; the first account in an empty provider registry becomes
that provider's default. Harness stores a separate, explicitly chosen default in
`agent-provider-preferences.json`. It does not select the first discovered provider automatically.
Adding an account or changing a provider's default does not change an existing Harness selection.
Harness has no translation provider interface, translation account/model configuration or
translation settings tab. The distribution's dedicated translation provider is
[Opus](../translation-provider/feature.md). Agent account selection remains independent of that
translation service. Retired Harness translation selections remain inert in existing settings files;
unrelated saves preserve them without exposing or executing them.

## Provider Accounts

| Provider | Authentication | Setup in the provider application |
| --- | --- | --- |
| Codex | ChatGPT sign-in | Use the supplied browser link and device code; the provider drives the dedicated native login process. |
| Codex | API key | Enter an OpenAI API key; native login receives it over stdin. |
| Codex | Existing host login | Explicitly select an absolute Codex home accessible to the provider's OS user. The external home remains operator-owned. |
| Claude Code | API key | Enter an Anthropic API key. |
| Claude Code | Claude Code token | Enter the token from `claude setup-token` and replace it when required. |
| Ollama | None | Select an existing Ollama server by URL and an installed tool-capable model. |

Accounts are shared within their provider application under its administrator boundary; an account
name is not a user boundary. Account type and authentication method are fixed after creation.
Secrets are write-only. Replacing credentials, changing an endpoint or changing an existing-login
directory advances the account revision; renaming alone does not. Editing or removing an existing
account requires its current decimal-string revision. Active executions protect account identity and credentials. Speech publication switches can change while a run is active. Changing the provider's default only affects later selections.

ChatGPT sign-in uses the provider's Codex app-server `account/login/start` with
`chatgptDeviceCode`. Success is reported after the native completion and Core secret publication.
Cancellation sends the native cancel request and closes the login process. Pending attempts expire
after 15 minutes; terminal status is retained for 10 minutes. A failed attempt preserves an existing
working credential. Claude has no custom OAuth flow.

Configured readiness does not prove paid inference, remote model entitlement or Ollama server
reachability. Model discovery and the first execution can report a missing server, removed model,
expired credential or upstream failure. Optional quota diagnostics distinguish unavailable,
unsupported and not-applicable data from an account's execution readiness.

Each provider resolves its own pinned runtime dependencies. Codex and Claude native execution
belongs to their respective applications. Ollama Provider connects to an operator-managed server;
it does not install/start Ollama, download model weights or change the server's environment.

### Speech on Codex API connections

Codex Provider 0.5.0 gives each managed OpenAI API-key connection independent **Provide speech to text** and
**Provide text to speech** switches, initially off. The API-key connection row shows the saved On or Off state
of each switch. Enabling a switch publishes one named
implementation under that speech interface. The connection name supplies the user-facing label.
Renaming preserves the selection. Rotating its API key changes its published identity. Removing
the connection or disabling a switch withdraws the corresponding choice. Users of ChatGPT
sign-in and existing host login retain their agent connection.

Codex Provider sends completed recordings to OpenAI file transcription with `gpt-transcribe` and streams
read-aloud audio from OpenAI Realtime using `gpt-realtime-2.1-mini`. Each call uses the credential of the selected connection.
The Harness user selects dictation and read-aloud independently of the chat's agent.
The shared provider runtime also retains the implementation identity in history and native execution references.
Claude Code Provider 0.4.1 and Ollama Provider 0.3.1 include that change.
See [provider consumption and speech](../provider-consumption/feature.md), [file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
and [speech generation](https://developers.openai.com/api/docs/guides/text-to-speech).

## Chats And Capabilities

Harness connection entries expose a neutral `agent` kind, an opaque logical connection ID,
display name, readiness and declared capabilities. Harness derives the logical ID from the
provider application, interface key, optional implementation ID and provider-owned account
ID. Each execution binds the exact installation and decimal-string account revision. Older
selection hashes resolve only with matching qualified evidence and a unique current account.

A new chat takes the explicitly configured Harness default unless its creation request or profile
selects another connection. The composer applies an empty chat's dropdown selection immediately
inside the shared [Agent settings panel](../harness-composer-controls/feature.md). A pending save
disables sending; failure preserves the confirmed selection. Before admission, selecting the
current account again can refresh a changed revision. A profile applies provider, model, effort,
role and skills together; see [Shared Agent Profiles](../agent-profiles/feature.md).

The first admitted message locks the provider/profile selection. The conversation retains its
qualified account binding and public provider session/run references. Native SDK session IDs,
processes and discovery homes remain provider-owned. Model and reasoning changes between turns
use the selected provider's current catalog and declared capabilities. Missing providers, changed
accounts and unavailable models fail explicitly; aggregate readiness never authorizes substituting
another connection. After a reinstall, ordinary owner Send can resume an exact context verified
by the current provider. Agent settings also offers explicit recovery or a fresh context with
a reviewed connection and model for this provider in the existing chat.
[Recovery after provider reinstallation](../provider-reinstallation-recovery/feature.md)

Harness explicitly captures Core-provenanced platform introduction text and adds the platform
package before its first provider configuration, alongside the operator's optional profile skills.
The captured text and selection survive consumer restart. This is Harness's own caller default;
the public provider interface does not impose it on an independent consumer's empty selection.

Core authorizes each public operation. A new session/configuration pins its selected skills as an
immutable Core snapshot with content digests. Resuming that configuration revalidates the same pin;
a library update does not silently replace package bytes. Deleted selections, missing native state
or a changed snapshot block execution rather than reconstructing a different session. Profiles
store references and instruction snapshots, while providers own the resulting native state.

The provider atomically owns account capacity and execution admission. Harness persists exact
request IDs and command bodies before delivery. Uncertain admission/control outcomes remain
fenced; retries keep their original bytes and identity. A response requiring another native turn
uses the provider's reserved continuation run and the original decision-response reference under
fresh Core authorization. It does not become an ordinary text message or a new random attempt.

## Storage And Recovery

Harness stores its conversation transcript, qualified preferences, public execution outbox and
committed replay watermark. Provider applications store their own public session/run journal,
native session bindings, account metadata and native conversation history. An app restart or
backup therefore operates on that app's state; a Harness backup does not include another
application's native history or credentials.

Each provider's `connections.json` contains account metadata and its secret cleanup journal.
Managed credentials use that provider's namespace in the
[Core App Secrets Store](../app-secrets-store/feature.md). Provider browser APIs return no secret
values or service tokens. Managed cache homes reconstruct API-key authorization from Core and
link native history to provider data. Renewable ChatGPT authorization synchronizes back to Core;
missing Core secrets are a reconnection requirement, never recreated from cache. Rotation journals
unreferenced secrets before publication, and cleanup retries after failed writes.

Native history is retained separately from managed cache authorization. Removing cache does not
remove native conversations. Removing an account deletes managed credential copies and secret
references while preserving retained history. An explicitly selected external Codex home is not
deleted. Restoring another host requires reconnecting accounts; restoring old metadata cannot
resurrect a removed Core secret. This is backup separation, not encryption or protection against
the host OS user.

Restarting Harness detaches observation and leaves provider execution independent. Reattachment
reads an authoritative snapshot and follows its committed cursor, with stable message/tool/
decision identities preventing duplicate transcript entries. Temporary projection failures retry
within a bounded policy; sealed or corrupt consumer storage requires recovery.

Stop cancels the exact public execution, including any reserved decision continuation. A result,
closed stream or client assertion does not prove native exit. Providers retain capacity and source
leases until their own supported stop operation and process-tree evidence confirm termination.
Unknown effects or missing proof remain fenced against replacement work and deletion. Provider
restart uses its own durable journal and evidence; it does not replay accepted input to discover
whether the earlier work happened.

## Fresh Harness Installation

The extraction release requires a clean cutover. Initial startup refuses legacy or unreadable
conversation inventories without deleting them. Legacy private-worker/native histories are not
imported, copied or rebound through a connection selector. After verified initialization, a
damaged consumer conversation remains isolated by its own storage recovery fence. The
[agent interface](../agent-provider-interface/feature.md) defines the current public ownership and
recovery boundary.

## API

Harness routes use its existing administrator identity, same-origin mutation checks and
conversation ownership rules:

| Route | Behavior |
| --- | --- |
| `GET /api/connections` | Read discovered metadata/readiness and the Harness default. |
| `PUT /api/connections/default` | Select `connectionId`; null clears the Harness default. |
| `POST /api/connections/:id/test` | Read the selected provider's advertised readiness/capabilities. |
| `GET /api/connections/:id/models` | Read the public provider model/effort catalog. |
| `GET /api/connections/:id/usage` | Read optional provider-declared usage diagnostics. |
| `PUT /api/sessions/:id/provider` | Select a current connection before the conversation locks. |
| `GET /api/health?sessionId=:id` | Read the bound chat's readiness and capabilities. |

Credential CRUD, native login and the former Prepare for Docker routes are rejected by the remote
consumer facade. Account administration belongs to the provider's own authenticated
`/api/settings/connections`, `/api/settings/default` and login routes. Its public agent operations
use the versioned HTTP/SSE interface and fresh Core credentials, rather than the browser Settings
cookie.

Browser usage updates use one-use stream tickets. WebSocket admission and later metadata reads
retain the ticket's validated actor rather than upgrade cookies or the HTTP request's transient
scope. Sampling caches are separate for different app grants, revalidate the current credential
before reads and stop when their last subscriber leaves or the stream expires.

MCP application permissions remain separate from agent account selection. Harness owns its
logical MCP preferences and the [Ask / Run unprompted / Disabled policy](../assistant-approval-rules/feature.md).
Core authorizes the selected targets; the provider owns its execution proxy. Supported policy-only
updates retain the admitted logical target set. Adding an interface requires declared full live
configuration or a fresh turn. UI search does not change permissions.

Harness composes its optional task workflow separately from general Core MCP. The invoking
consumer binds its task-executor interface, logical conversation and a fixed set of task operations
to the provider admission. The provider's local workflow tool adapter calls Core's bounded business
API; Core mediates the original actor and exact public provider session/run to Harness. It does not
create general Core MCP access or change a disabled Core connection. Without the optional
task-executor permission, ordinary conversations omit task instructions and task tools;
task-bound admission reports the missing setup before starting native work. A disabled required
`task_result` tool also prevents task admission.
The selected provider must declare `workflow.consumer`; Harness checks it before fresh and
resumed workflow turns and retains that requirement in the immutable prepared run command.

Chat subagent tools use the `workflow.subagents` capability and the consumer's reviewed
`agent-sessions` callback. The explicit tool selection supports child chats with or without
the task workflow. See the [provider contract](../agent-provider-interface/feature.md).

Workflow invocation rules are immutable for the admitted turn and apply to the next turn when
changed. Explicit task-specific Disabled rules remain disabled, and Run requires the same tool
definition. General Core defaults and Autonomous mode do not silently grant workflow calls.
Current Core permissions and the original actor remain subject to revalidation on each dispatch.
Signed workflow replies retain the original action/input UUID acknowledgement across response
loss and consumer restart.

Question and approval cards use conversation-local IDs qualified by the immutable public run.
Reusing a provider decision ID in a later turn does not reuse its previous answer or approval.
Public question answers preserve stable option IDs and multiple selections as arrays, including
permitted free text; completed cards display the option labels. Replay closes an answered card
only from its authoritative response, rather than inferring an answer from process completion.

## Docker Connections

Harness can consume an independently installed Local provider through the same public interface
while Harness itself uses Docker. Provider credentials, native processes and history remain in
the provider application. No private execution-worker image or native login directory is part of
the Harness consumer. Docker transport uses Core's authorized provider origin; it does not import
accounts or change the selected provider's runtime.

## Ollama Agent Adapter

Ollama Provider owns the serial model/tool loop and its durable checkpoint. Codex and Claude are
not Ollama runtime dependencies. The default URL is `http://127.0.0.1:11434` on the provider host;
an explicit override remains explicit. HTTP(S) URLs reject embedded credentials, queries,
fragments and redirects. Reachability is measured from the provider, not Harness's browser or
container. The application does not alter listeners or firewalls.

Catalog discovery uses bounded `/api/tags` and `/api/show` requests and retains exact installed
model tags. Models lacking completion/tools support and cloud-backed entries remain unavailable
with reasons. Thinking controls use advertised metadata, including boolean Off. Removing a
selected model fails explicitly. Ollama does not expose prompt suggestions.

### Tools, Context And Decisions

The loop streams `/api/chat` and dispatches only complete, validated tool calls, one at a time.
Completed assistant text enters the durable transcript before tool dispatch or final completion.
Local tools read/list/search text, inspect/apply an exact patch, run commands, ask questions, read
selected skills and discover authorized MCP tools. Search exposes up to eight matching schemas
on the next model step without granting access. The discovery catalog supports up to 4,096 tools
and a combined 16 MiB definition budget, with per-schema and pagination checks; excess fails
explicitly rather than silently dropping tools.

Normal mode asks before patches and commands. Decisions retain their original identities.
Patches check the original content hash both at proposal and immediately before replacement and
preserve replacement text literally. File tools reject workspace and symlink escapes. Newly
encountered nested `AGENTS.md` instructions require a fresh proposal. Shell commands retain the
provider's OS user authority; file path guards do not contain arbitrary shell code. Owned command
processes receive the selected execution environment without Hosty control credentials.

Instructions, selected immutable skill packages, applicable repository instructions, pending
decisions and effect receipts remain distinct inputs. Public Ollama execution accepts bounded
UTF-8 text attachments and rejects images/binary documents; its current per-attachment text limit
is 32,000 bytes. A vision-capable model alone does not enable image delivery.

Execution has limits of 32 model steps, 64 tool calls and 15 active minutes per turn, excluding
decision waits. Model requests have a five-minute deadline; commands default to two minutes and
allow at most five. Output is bounded and marked when truncated. Effective context is at most
32,768 tokens and no greater than the model's advertised limit, with an 8,192 fallback. Requests
reserve output space and compact older complete turns without dropping their tail. Oversized
current input or failed compaction stops explicitly; reported model usage remains distinct from
local estimates.

### Durable Continuation

Provider-owned checkpoints bind the public session's native continuation, resource and model and
retain messages, summaries and correlated action receipts. Effects with no durable result remain
unknown; completed tools are not replayed. Cache removal preserves this data. A provider restart
interrupts active execution and a later turn uses the retained checkpoint after required stop/
effect reconciliation. Preparing a different worktree mid-turn takes effect on a subsequent
authorized turn, with fresh repository instructions and explicit separation of earlier relative
paths.

## Verification

The following evidence predates independent provider applications and describes the then-current
Gateway/Worker architecture. It does not verify the extracted providers or their release packages.

On 2026-09-17, a Core-managed development app and Shell embedding completed real Claude-token,
external Codex-login and managed ChatGPT turns and resumed their native conversations. The account
owner completed device login. Empty-cache restoration reconstructed managed credentials from Core,
and the Core backup contained native history without those credentials. That release was
Gateway 0.29.0 → 0.30.0.

### Ollama Verification

The 2026-10-28 Ollama checks covered streaming, tools/decisions, MCP, literal patch races,
instructions/skills, compaction, attachments, unknown effects, model removal and process cleanup.
A disposable Core-managed child checked normal password identity, browser administration,
registered worktrees, durable continuation and production bundle recovery. A real Mac Ollama
0.40.12/`qwen3.8:27b-mlx` turn was a connectivity/streaming smoke check. Docker Desktop 29.9.2
Linux arm64 fixtures checked the former container transport and execution UID; Windows native
execution was not exercised. The recorded Harness 0.76.0 → 0.77.0 run passed 1,861 tests in
170 files and the then-current native integration commands.

Current extraction coverage is owned by the
[agent interface](../agent-provider-interface/feature.md) and
[CI feedback loop](../ci-feedback-loop/feature.md) testing contracts. Synthetic native peers verify
protocol handling and process ownership; they do not establish installed vendor CLI compatibility
or model quality.

## Testing Expectations

- Harness declares no translation role/interface/consumer permission, exposes no translation settings
  or provider route, and renders no translation settings tab. Existing ignored selection bytes survive
  unrelated settings saves without appearing in the active settings response.

- Verify provider-owned Settings through normal Core/app-code identity and its administrator
  boundary. Cover account CRUD with string-revision checks, failed/cancelled device login,
  secret rotation, synchronization failures, cache loss and same-/fresh-host restore behavior.
- Assert secret absence from browser responses and consumer backups. Exercise credential
  reconstruction separately from native-history survival and preserve external login directories.
- Discover unrelated provider app IDs and interface keys. Pin installation/account/revision
  references without vendor inference, implicit defaults or fallback after account replacement.
- Cover concurrent provider types/accounts, explicit defaults, creation/message retries,
  pre-admission selection, locked conversations, current capabilities and model catalogs.
- Verify consumer restart reattachment without resubmission or provider restart, stable output
  identities and append-before-cursor failure recovery. Keep unknown admission/control bytes
  fenced and retry the exact original command.
- Separate available results from confirmed native exit. Verify known descendant cleanup,
  stop during admission, reserved decision cancellation, provider restart, unknown effects and
  deletion/lease retention when stop proof is absent.
- Reuse native question/approval IDs across public runs and consumer restart without reusing
  old answers or controls. Exercise duplicate option labels, stable multi-select IDs and free
  text containing commas through the public manager and rendered UI.
- Verify optional task workflow authority independently of general Core MCP selection; omit
  unavailable workflow instructions for ordinary chats and reject task admission before native
  start when permission or the required completion tool is missing. Recover exact workflow
  acknowledgements after lost responses without redispatching completed business work.
- Reject legacy private-worker history adoption and startup cutover over an unreadable inventory;
  preserve healthy conversations after the verified format marker exists.
- Verify immutable skill pins per provider configuration, including empty selections, resumed
  sessions, missing packages, snapshot changes and changes to provider/account identity.
- Keep Ollama model fixtures deterministic. Cover catalogs beyond 128 tools, eight-schema search,
  aggregate budgets, completed text/tool/command persistence, decisions and revocation, literal
  patches, repository instructions, resource changes, cancellation, compaction and UTF-8 refusal.
- Run `node scripts/check-agent-provider-native.mjs` for disposable fake CLI/process/tool checks.
  Installed CLI metadata probes are the explicit `--installed-clis` variant and do not submit a
  model turn. Real account or model smoke checks require their own authorized fixture.
- Exercise `npm run test:integration -- agent-providers` for normal login, three independently
  installed Local providers and public Codex session/recovery behavior in a managed child.
  `HOSTY_OLLAMA_ACCEPTANCE=1 npm run test:integration -- harness-local` enables the deterministic
  Ollama model/tool journey; browser variants retain their separately selected prerequisites.
- Verify Harness and provider selections through Core/Shell with separate test data. Scope claims
  to the actual runtime/OS exercised and Finish managed children through their owner.

# Hosty Harness Rename

Status: Ready
Created: 2026-09-26
Updated: 2026-09-27

Part of [shared assistant development sessions](../assistant-development-sessions/plan.md).
The umbrella's common invariants apply; this feature has independent scope and requires its own Ready approval.

## Target Behavior

Owner direction, 2026-09-25: rename **AI Gateway** to **Hosty Harness** as part of this broader
redesign. Use that spelling consistently in the resulting product UI, app display metadata, setup
guidance and documentation. References to Gateway in this Draft still identify the existing
component and baseline; this documentation change does not rename the installed app today.

Owner clarification, 2026-09-25: change the application id as well as its display name. Planned
target: `hosty.ai-gateway` -> `hosty.harness`. The transition is an operator-performed uninstall of
the old app followed by a fresh Hosty Harness installation and manual configuration. No migration
or preservation of old sessions, history, provider settings, credentials or grants is required for
this replacement; the owner has no valuable state to carry over. Do not build an in-place upgrade,
legacy-id alias or automatic state import for this rename.

Update manifest identity, system-app registration/discovery, feeds/install references, token audiences,
permissions and client configuration coherently for the new id. Inventory related paths/routes and
documentation during implementation. A new installation must not silently reuse old credentials or
depend on the old app. This clean-install decision is specific to replacing the current AI Gateway;
the new Harness's normal source/session retention and safe workspace-cleanup requirements still apply.
This Draft does not uninstall anything now; the operator performs the replacement when it is ready.

## Interface, Distribution And Release Contract

Owner decision, 2026-09-27: rename the manifest interface from `ai-gateway` to `assistant`.
Keep application identity, confirmed role, API location and permissions separate:
`hosty.harness` is the new app ID, `provides: ["assistant"]` requests the role,
`interfaces.assistant` locates the integration API, and `corePermissions` requests authority.
The interface name alone grants neither the role nor any permission.

The [assistant provider permissions](../assistant-provider-permissions/feature.md) feature has shipped:
cross-app skill reads check `apps.skills.read`, and Shell checks the confirmed assistant role.
Shell still locates the API through `interfaces.ai-gateway`; Core's OAuth facade resource resolver
also reads that key. Update all consumers together, including tests, SDK/skill examples and current
feature documentation. This is not a Shell-only string replacement. Use the coordinated breaking
transition below; never return the new app ID under an old app's manifest/feed URL.
The new installation confirms the same role and permission without migrating old grants.
The MCP facade stays in Harness until its separate [plan](../mcp-facade/plan.md) resumes.

### Versioned Interface And Capabilities

Owner decision, 2026-09-27: `assistant` is a versioned contract. Its version covers a mandatory part
that every assistant implements; a new mandatory requirement or an incompatible change is a new major
version. Optional features are named capabilities. An app that lists a capability states that it
implements it. Adding a capability does not change the interface version. The meaning of an existing
capability is stable: an incompatible change requires a new capability identity/version or a new
major interface version, never a silent reinterpretation of the existing name.

The app declares both in its manifest, in its `interfaces.assistant` entry: a `version` and a
`capabilities` list. Shell and Core then read them without calling the app. These are additive
fields carried through manifest parsing/validation, persisted interface records, install/update
projection, app-directory/API summaries and Shell/SDK types. Accepting unknown JSON fields without
preserving and returning them is not sufficient. Cover existing records without the fields and
unsupported versions explicitly. A declared capability is a claim that Core cannot verify, so callers
still handle an explicit unsupported or missing-endpoint response.

Owner decision, 2026-09-27: Shell is replaceable too, so the mandatory part does not follow any one
Shell's features. It is the minimum every caller needs:

- the assistant handoff below with prompt text and application IDs;
- a result that identifies the created conversation and how to open it;
- explicit unsupported and error responses;
- the manifest declaration of `version` and `capabilities`.

Everything else is a capability. Initial candidates:

- `attachments` for the handoff, described below;
- a session backend API that lets another app present Harness sessions in its own UI, as described in
  the [umbrella](../assistant-development-sessions/plan.md);
- an [AHP](../assistant-ahp/plan.md) endpoint for full session clients.

The initial contract uses integer major version `1` and the capability name `attachments`.
The session-backend and AHP capabilities remain outside this slice and have no reserved names yet.
Require `version` and `capabilities` on every `assistant` entry, with unique nonempty capability
names. Other interface types do not acquire these requirements. Clients support version `1`, reject
missing/unsupported assistant versions with an actionable error and ignore unknown optional
capabilities. There is no fallback to the old `ai-gateway` interface.

#### Client Requirements

Each UI client, whether Shell or a replacement, defines which capabilities its features require and
which it can work without. Which assistant a client uses is that client's own setting, as the
[core extension model](../core-extension-model/plan.md) already states; Core does not validate it.
For the current Shell, this setting is **Settings → Shell → Assistant for Shell**, shipped in
Shell 0.83.0 by [assistant provider permissions](../assistant-provider-permissions/feature.md).
Hosty Harness is its only choice for now. This feature adds capability checks to that setting:

Owner approval, 2026-09-27: Shell requires the mandatory version-1 contract only; `attachments` is
optional. Text and app-context handoffs remain available without it. File and screenshot handoff
actions remain visible but unavailable with the missing-capability reason. Harness declares
`attachments`; a replacement assistant need not do so.

- Choosing an assistant that lacks a capability the client requires is refused with an error that
  names the missing capabilities. Such an assistant is never selected implicitly, even when it is
  the only one.
- Choosing an assistant that lacks a capability the client can work without succeeds with a warning.
  The warning names the client features that will not work. Those features then appear unavailable
  with that reason; they are not silently hidden.
- If an assistant update removes a capability, the stored choice is re-checked, following the
  existing rule for an invalid stored choice.

Other callers, such as apps that send assistant drafts, check the capabilities they need before
offering the corresponding action.

### Assistant Handoff

In this repository a handoff is one component passing an intent or data to another, which then
continues it; compare the Marketplace install handoff and the existing Shell assistant handoff in
[operation feedback](../shell-operation-feedback/feature.md). Here it is a request that creates a
new conversation in an assistant.

Owner direction, 2026-09-27: the interface must accept a new-conversation request containing a prompt
and attached application IDs. Files, including images, travel through the `attachments` capability
below. The typical caller is Shell. An operator asks
the assistant about an app, for example from an overlay that selects interface elements and captures
a screenshot. Shell sends the text, the related apps and the image to the default or selected
assistant, then opens the created conversation. The assistant owns its UI, conversation storage,
input modes and conversation naming. Shell does not implement the assistant's conversation engine.
Model/agent selection and a caller-supplied title are not required in this slice. Agent-provider
discovery remains with the [core extension model](../core-extension-model/plan.md).

Owner decision, 2026-09-27: attachments are one capability, `attachments`, with no split by file
type. An assistant that declares it accepts a file of any type, stores it and shows it in the
created conversation. Whether the file is useful is the assistant's and its agent's concern. For
example, a model that cannot read images, or a format the agent cannot process, is explained to the
user in the conversation rather than refused by the handoff.

The capability carries a guaranteed floor that every declaring assistant accepts, so callers can
design features within it. Owner decision, 2026-09-27: any file type, at least 10 MB per file and
10 files per request. The floor is a guarantee to callers, not an expected size; a typical Shell
screenshot is far smaller. The floor is 10,000,000 bytes per file and ten such files together.
Harness declares `attachments`; its current caps (25 MiB per file, 20 files and 100 MiB per session)
exceed the floor and remain unchanged.

#### Prepare, Upload, Finalize, Open

Use a bounded preparation flow with the HTTP contract specified below:

1. **Prepare.** The authenticated caller submits an actor-scoped request ID, prompt and application
   IDs. The assistant creates a pending handoff bound to a new conversation and returns its handle.
   Preparation never starts a model turn, even when immediate start is enabled.
2. **Upload.** If `attachments` is supported, upload each file as its own raw request body against
   the prepared handle and a stable caller-chosen attachment ID. Names are display metadata, not
   retry identity. Repeating an upload with the same ID and bytes returns the same attachment;
   conflicting content is refused. Stream size checks and the existing attachment limits apply.
3. **Finalize.** The caller submits the exact set of completed attachment IDs, including an empty set
   for text-only requests. The assistant verifies ownership and complete uploads, seals the request,
   and applies its draft/immediate-start setting once. Missing or partial files leave the request
   unfinalized. Later uploads cannot mutate a finalized request.
4. **Open.** The result contains the conversation reference, whether it was prepared as a draft or
   accepted for execution, and how to open it in the assistant's declared UI. Shell (or the calling
   UI client) selects and opens the panel/page. The assistant backend never manipulates Shell tabs;
   opening the UI never submits the prompt again.

Preparation, upload and finalization retries must survive an uncertain response and process restart.
Persist one finalization outcome and one execution dispatch identity, rather than triggering another
turn on each retry. If an execution outcome is unknown, reconcile it or report uncertainty; never
blindly execute the request again. An accepted turn is distinct from a turn already running or
completed. Inspect and cancel pending handoffs and clean abandoned uploads under the policy below
without deleting unrelated conversations or attachments. A finalized result remains retrievable if
opening the UI fails. Callers without a UI can consume that same result without opening anything.

Files are not embedded in JSON. Structured context, such as a selected element's page, app and
selector, travels as prompt text or as a JSON attachment; it needs no separate field in this version.
Reuse Harness's streaming attachment machinery, but add stable upload identity instead of treating
its existing filename deduplication as idempotence.

#### Version-1 HTTP Contract

Technical decisions delegated by the owner, 2026-09-27: resolve all routes relative to the selected
`interfaces.assistant` endpoint/path. Harness declares `/api/assistant/v1`; callers never hard-code
that prefix or infer it from the app ID. All operations require the existing authenticated assistant
access boundary. Scope request ownership to the authenticated user and verified calling app
installation where present; never accept an actor or caller identity from the JSON payload. Existing
direct user clients use their authenticated user scope. Recheck access on every request.

| Method and relative route | Input and result |
| --- | --- |
| `POST /handoffs` | JSON `{ requestId, prompt, appIds }`. Create a pending handoff and reserved conversation; return `201` with the status record. An identical retry returns `200` with the existing record; changed input under the same identity returns `409`. |
| `PUT /handoffs/{handoffId}/attachments/{attachmentId}?name=…` | Raw bytes, URL-encoded display filename and `Content-Type`. Requires `attachments`. Return `201` with `{ attachmentId, name, mediaType, sizeBytes, sha256 }`, or `200` for an identical completed upload. |
| `POST /handoffs/{handoffId}/finalize` | JSON `{ attachmentIds }`, an exact set without duplicates, empty for text-only input. Seal the pending input and return `200` with the recorded disposition. Repeating the same set returns that outcome; a changed set returns `409`. |
| `GET /handoffs/{handoffId}` | Return the current status, complete attachment records and any finalized result; never execute a turn. |
| `DELETE /handoffs/{handoffId}` | Cancel only a pending handoff and return its cancelled status. Repeat cancellation returns the same status; finalized handoffs return `409`. This is not conversation deletion or turn cancellation. |

Use caller-generated UUIDv7 `requestId`s and UUID `attachmentId`s. A request ID identifies one
intent and is reused with exactly the same prompt/app set after a lost response. Look up an existing
actor/request identity before applying the new-request age rule: an unseen request ID must be no more
than 24 hours old and no more than five minutes in the future. An unseen older ID returns `410`,
never a new conversation. This timestamp bounds replay retention; it proves neither identity nor
prompt authorship. Canonicalize app and attachment sets for retries without altering prompt text.
Callers retain the request ID until they receive the handoff ID; retrying Prepare recovers a lost
response. They never invent a new request ID to recover an uncertain submission.

The status record contains `handoffId`, `requestId`, `state` (`pending`, `finalized`, `cancelled`,
`expired`), `createdAt`, `expiresAt`, `replayUntil`, `conversationId`, completed `attachments`, and
effective attachment limits when supported. A finalized record also contains the immutable `result`:
`{ conversationId, disposition: "draft" | "accepted", open: { endpoint, path }, dispatchId? }`.
`dispatchId` is present for accepted execution; a separate `executionState` reports
`queued`, `running`, `completed`, `failed` or `unknown` without changing the finalized disposition.
The destination uses an endpoint of the selected assistant app and an absolute app-relative path,
optionally with query/fragment, within its declared UI surface. Reject external origins,
protocol-relative URLs and destinations outside that app's declared UI. Clients resolve it through
Core's existing app access/embedding mechanism; they do not assume Harness's conversation routes.

Serialize upload/finalize/cancel transitions per handoff. Write uploads to temporary storage and
publish an attachment record only after size validation and successful completion. Compute the digest
server-side while streaming. Same-ID retries compare bytes and metadata, not just filename; conflicts
return `409`. Interrupted uploads never count as completed and may be retried with the same ID.
Finalization requires the submitted set to equal all completed uploads, no uploads still in progress
and current authorized app context. Without `attachments`, only an empty attachment set is accepted.
Preparing or opening a reserved conversation cannot start a turn through another session endpoint;
it becomes a normal draft/conversation only after successful finalization.

Persist finalization, disposition and one dispatch identity atomically. Dispatch from that durable
record with session-side deduplication. Recovery may retry delivery of the same identity; if a native
adapter cannot establish whether execution already started, expose `unknown` rather than start a
second turn. UI opening failure does not roll back finalization or re-send the prompt.

Pending preparations expire 24 hours after creation, without extension by retries. Cancellation or
expiry removes only their staged files and reserved, never-finalized conversation. Sweep on startup
and periodically; crashed temporary uploads are removed before resuming the pending handoff. Keep
compact request fingerprints, terminal status and result references for at least 30 days from
creation, independent of transcript retention. Report that deadline as `replayUntil`; while a
conversation is retained, keep its finalized mapping too. If its conversation is deleted, keep a
tombstone for the remaining replay window and never recreate it. After record removal, the UUIDv7
age rule refuses a repeated Prepare. Status requests for removed records return `404`; retained
expired/cancelled records remain inspectable and refuse upload/finalize with `410`. Do not retain
prompt/file contents solely for replay protection. Cleanup retries must be recoverable after restart.

Use structured errors `{ code, message }`: `400` for invalid input, `401`/`403` for authentication or
access refusal, `404` for an unavailable/foreign handle, `409` for identity/content/state conflicts,
`410` for expired or cancelled mutations and stale unseen request IDs, `413` for size/count limits,
`422` with `capability_unsupported` for an undeclared capability and `503` for temporarily unavailable
dependencies. An unsupported manifest version is detected before dispatch; an advertised but missing
route remains a visible provider-contract error, never a fallback to the legacy API.

Reuse the existing session, app-context and attachment implementations behind a bounded integration
contract. Existing behavior is split between authenticated session creation, attachment upload and
iframe draft delivery; the combined handoff is not implemented today. Do not merely rename the
interface and claim these requirements are already covered.

The contract design must cover:

- An actor-scoped request identity and retry behavior that does not create duplicate conversations
  or duplicate attachments after an uncertain response.
- A prompt draft, application IDs resolved through Core, and explicit transfer of file/image content
  with names, types and limits. Do not treat a caller's local path or arbitrary fetch URL as a usable
  attachment. Preserve existing attachment caps unless separately changed by the owner.
- A result that identifies the created conversation and how to open it in the selected assistant's
  declared UI, without assuming every assistant uses the Harness page routes or naming scheme.
- Authenticated caller/user identity, authorized upload/read access, verified embedded message origins,
  partial-upload failure/retry behavior and actionable unsupported-input errors. These checks authorize
  the caller; they do not claim to prove who authored the prompt.
- Draft delivery or an immediate start as described in *Draft Or Immediate Start* below. Rendering
  or receiving context must not grant source access, MCP offers or development authority.
- Version and capability detection through the manifest declaration above, plus explicit responses
  that let callers distinguish unsupported input from a missing endpoint. Avoid a new general-purpose
  conversation synchronization protocol in this slice.

#### Draft Or Immediate Start

Owner clarification, 2026-09-27, superseding the earlier source-based exception: the assistant's
setting applies uniformly to every authorized handoff. Its default is a draft.

- With immediate start disabled, finalized handoffs remain drafts until the user sends them in the
  assistant. With it enabled, finalized handoffs are accepted for execution without a per-request Send.
- Do not introduce a user-versus-app prompt-origin field or classify prompt authorship for this
  decision. A caller can claim user authorship; the receiving assistant cannot prove that claim.
  Authentication still establishes the acting user and authorized caller where available.
- The operator deliberately accepts that enabling immediate start permits app-submitted prompts to
  execute without individual review. Explain this effect in the assistant's setting. This explicitly
  relaxes the former unconditional draft-only guard for third-party handoffs; it does not grant new
  MCP, filesystem, command or development authority and does not bypass tool approvals.
- The setting is receiver-owned and evaluated once at successful finalization. A retried finalization
  returns the recorded disposition even if the setting changed afterwards. Sending an existing draft
  later is a separate user action, not another finalization.
- An assistant without immediate start always returns a draft; no separate capability is required.

AHP is not required by the handoff. The [AHP plan](../assistant-ahp/plan.md) remains
the independent client-adapter evaluation for richer session access. This change does not move
session persistence into Core, define shared state between assistant apps with separate session
engines, or force third-party assistant UIs to use Hosty's chat layout.

### Coordinated Breaking Transition

Owner decision, 2026-09-27: update Core, Shell and Harness together in one feature PR, without a
backward-compatibility window, old-interface fallback or old-ID aliases. The operator update order is:

1. Update Core/CLI to the release containing the new interface metadata and Harness distribution
   descriptor; verify Core readiness before continuing.
2. Update Shell to the release supporting `assistant` version 1. Until Harness is installed and
   selected, assistant actions show an unavailable/selection-required state; the rest of Shell works.
3. Uninstall `hosty.ai-gateway`, install `hosty.harness` fresh, confirm its role/permissions,
   configure providers and select it in Shell. Reconnect external clients with new credentials.

Wait until the matching artifacts/source revisions are available before starting this sequence;
one merged PR does not make publication or operator installation atomic. A temporary assistant/facade
interruption is accepted. Mixed old/new combinations are not supported; neither auto-select the old
assistant nor rewrite a stored old app selection to the new identity. Show a useful selection error.

Move the runtime app to `apps/harness` and publish its manifest/feed there. Retire the raw
`main/apps/ai-gateway/manifest.json` and `feeds.json` paths in that same change: no frozen copies,
redirects, replacement IDs under old URLs or manifest-shaped tombstones. Older Core installations
and old app update checks can receive unavailable-source/404 errors after merge; they must update
Core and follow the manual replacement procedure. Document this breaking change and the update
order in current install/setup guidance and the PR description. This decision supersedes the
earlier frozen-URL compatibility-window proposal; it does not authorize a live uninstall now.

Re-register external MCP clients and authenticate against the actual new Harness facade resource.
The app origin/port may change with the new installation; query the assigned endpoint rather than
assuming the old one survives or that a particular new port is guaranteed. Cover Codex, Claude and
the Hosty connector/plugin. Old credentials are not imported.

Inventory app IDs, interfaces, token audiences, discovery, manifests/feeds, distribution descriptors,
CI job names and path filters, image/package names, root npm workspaces and `ai-gateway:*` scripts,
`scripts/check-versions.mjs`, SDK/skill examples and documentation links. Existing `ai-gateway*`
feature folders have stable documentation identities: update their content/links deliberately;
renaming every folder is not required by a product display-name change.

Owner decision, 2026-09-27: continue the Gateway version line with a minor bump for this breaking
feature (`0.34.1` -> `0.35.0` at the current baseline; re-evaluate if another release lands first).
Keep manifest/package versions aligned; do not reset the new identity to `0.1.0`. Add its
manifest/package version sources and independent release policy to `AGENTS.md` when the rename
ships; bump Core/Shell only for changes they actually ship under repository policy. The rename
can ship independently of AHP and the session-workspace implementation.

## Deliverables

- [ ] Inventory identity, interface, build, distribution and client references; implement the selected
  rename contract, coordinating `interfaces.assistant` across Core, Shell and Harness.
- [ ] Define the versioned `assistant` interface: its mandatory part, the manifest `version` and
  `capabilities` declaration, and the `attachments` capability with its guaranteed floor. Preserve
  metadata through Core parsing, persistence, update projection, discovery and client types.
- [ ] Implement the assistant handoff for prompts and app context in Harness and its `attachments`
  capability, with authenticated retry-safe preparation/upload/finalization, pending-request recovery
  and cleanup, the uniform draft/immediate-start setting and caller-driven opening of provider-owned
  UI. Update Shell entry points and relevant SDK integration, and verify the contract.
- [ ] Declare Shell's required and optional capabilities and validate the Assistant for Shell choice
  against them: refuse a missing required capability, warn about missing optional ones, and show the
  affected features as unavailable with the reason.
- [ ] Implement and document the old manifest/feed URL retirement and Core release order without app-state
  migration.
- [ ] Update native/external client discovery and reconnection guidance, documentation and skill references.
- [ ] Apply the chosen artifact version policy, add its AGENTS.md entry, and verify fresh install/update
  behavior.

## Approval And Implementation Preparation

The owner has settled the product choices and delegated the HTTP/recovery details recorded above.
No product question remains open. The owner approved implementation of the complete feature on
2026-09-27. This approval does not authorize replacement of the operator's live installation.
Reference inventory is implementation work in the first deliverable, not an unresolved product choice.

## Verification

- Verify a fresh `hosty.harness` installation and the documented operator uninstall-old/install-new
  flow. Configure providers anew and check Shell/client discovery, permissions, new sessions and
  subsequent updates under the new identity. No old sessions/settings/credentials are imported and
  no old-app dependency or legacy-id alias is needed.
- The fresh installation shows the assistant role and requested permission for confirmation, and
  Harness appears as an assistant only after they are confirmed.
- A repeated handoff creates one conversation and one copy of each attachment; text, images and app
  associations appear together in the destination UI. Refused or interrupted uploads cannot silently
  produce a successful incomplete handoff.
- Preparation and upload never execute a turn. Finalization refuses incomplete attachment sets;
  with the default setting it creates a draft, and with immediate start enabled it accepts one turn
  regardless of claimed prompt origin. Retry after response loss/restart does not duplicate files,
  conversations or dispatch; changing the setting does not alter an already finalized result.
- A failed UI open can be retried without resubmitting the request. Abandoned preparations can be
  inspected/cancelled and expire under the selected cleanup policy without affecting other work.
- Exercise concurrent upload/finalize/cancel, duplicate filenames with distinct IDs, interrupted
  uploads, changed retry payloads, clock skew, expiry and transcript deletion. After replay-record
  cleanup, an old request ID cannot create a second conversation. Foreign handles and invalid UI
  destinations disclose no content and cannot navigate outside the assistant's declared UI.
- Follow Core -> Shell -> Harness replacement with an intentional pause between steps. Shell remains
  usable and explains unavailable assistant actions; it does not call the legacy interface or reuse
  old credentials. Old raw manifest/feed URLs are retired rather than returning the new app ID.
- An assistant declaring `attachments` accepts files of any type at the guaranteed floor and shows
  them; an image sent to a model without image support is still stored and visible, with an
  explanation in the conversation.
- In Shell settings, choosing an assistant without a required capability is refused, and one without
  an optional capability is accepted with a warning naming the affected features, which then appear
  unavailable with the reason. An assistant update that removes a capability re-checks the stored
  choice. A handoff that uses an undeclared capability is rejected explicitly.
- Verify unauthorized callers, foreign attachment reads, cross-request attachment references, unsupported
  contract versions and undeclared capabilities; existing direct assistant use remains available.

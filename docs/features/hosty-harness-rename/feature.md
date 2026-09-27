# Hosty Harness Integration

Created: 2026-09-27
Updated: 2026-09-27

Hosty Harness (`hosty.harness`, `apps/harness`) is the optional administrator assistant and MCP facade.
It continues the former Gateway release line at 0.35.0. Core/CLI 0.110.0, Shell 0.85.0 and
`@hosty-sdk/app` 0.16.0 carry the matching integration. Historical feature-folder names remain stable.
Session storage, provider connections, conversation naming and UI belong to Harness. Core owns
identity, installation, lifecycle and discovery. This integration does not implement AHP or the
separate [development-session workspace plan](../assistant-development-sessions/plan.md).

## Discovery And Client Selection

```json
"provides": ["assistant"],
"corePermissions": ["apps.skills.read"],
"interfaces": {
  "assistant": [{
    "key": "default", "endpoint": "http", "path": "/api/assistant/v1",
    "version": 1, "capabilities": ["attachments"]
  }]
}
```

The app ID, administrator-confirmed role, interface location and granted permissions are separate.
Declaring an interface grants no authority. Core requires a positive integer `version` and an explicit
list of unique capability names for `assistant`; other interfaces retain their existing requirements.
These fields survive manifest validation, persisted registry records, updates and both Shell and
app-directory projections. Old records without the fields remain readable but do not satisfy v1.
Unknown positive versions are preserved, so a newer provider is discoverable without being selected
by a client that does not support its contract.

Version 1 requires prompt/app-context handoffs, a conversation reference and UI destination, and
explicit errors. Incompatible mandatory changes require another major interface version. Optional
features are capabilities; unknown capabilities are ignored. A capability name keeps its meaning.
`attachments` is the initial capability. It accepts any file type with a guaranteed floor of ten
files of 10,000,000 bytes each in one request. Harness supports 25 MiB per file, 20 files and 100 MiB
total. Its effective limits appear in handoff status. Model suitability is separate from storage.

Shell's **Settings → Shell → Assistant for Shell** requires only v1. An incompatible assistant is
refused, including implicit selection when it is the only installed assistant. Missing `attachments`
produces a warning naming unavailable file/image handoffs; text and application context still work.
The current Shell entry points send text and app IDs. The SDK exposes upload for clients with file
pickers. A stored choice is checked again after registry changes; a stale old app ID is not silently
rewritten to Harness. No client falls back to `ai-gateway`.

## Authenticated Handoff

Routes are relative to the selected interface URL, never inferred from the app ID. Harness uses its
existing administrator delegated-token or revalidated app-session authentication; cookie mutations
also require same-origin requests. Every operation checks access. Ownership is the verified user
scope available in those credentials. No body field supplies caller identity or prompt authorship.

| Method and relative route | Input / result |
| --- | --- |
| `POST /handoffs` | `{ requestId, prompt, appIds }`; 201 for a reservation, 200 for an identical retry |
| `PUT /handoffs/{id}/attachments/{attachmentId}?name=…` | Raw bytes and Content-Type; 201 for a complete upload, 200 for identical bytes and metadata |
| `POST /handoffs/{id}/finalize` | `{ attachmentIds }`, the exact set of completed uploads; 200 with the immutable result |
| `GET /handoffs/{id}` | Current status, completed uploads and any finalized result; never dispatches execution |
| `DELETE /handoffs/{id}` | Cancels a pending reservation; repeated cancellation succeeds, finalized requests return 409 |

Prompt text is bounded to 48 KiB; app context uses the existing authorized app-directory validation
and at most 16 app IDs. App sets are canonicalized without changing prompt text. Each preparation
reserves a conversation hidden from ordinary history and inaccessible for direct turns until
finalization. Preparation and upload never start a turn. Partial uploads never count as completed.
The finalizer rechecks current application context and refuses incomplete or changed attachment sets.

Request IDs are caller-generated UUIDv7 values. Callers retain the same ID and payload through an
uncertain response or restart. Existing actor/request records are looked up before age checks;
unseen IDs older than 24 hours return 410, and clocks more than five minutes ahead return 400.
Attachment IDs are UUIDs independent of display names. Two files with the same name survive;
reusing an ID with changed bytes, name or media type returns 409. Digests are computed while streaming.
Uploads land in temporary files and become visible only after validation and atomic publication.
Serialized transitions prevent upload/finalize/cancel races. Oversized streams return structured 413
responses without publishing partial files.

Status contains `handoffId`, `requestId`, `conversationId`, `state` (`pending`, `finalized`, `cancelled`
or `expired`), timestamps `createdAt`, `expiresAt`, `replayUntil`, attachment metadata and limits.
The finalized result is:

```json
{
  "conversationId": "…", "disposition": "draft",
  "open": { "endpoint": "http", "path": "/assistant?session=…" }
}
```

An accepted result also contains one `dispatchId`. Separate `executionState` is `queued`, `running`,
`completed`, `failed` or `unknown`; acceptance does not claim a model has already run. Errors use
`{ code, message }`: invalid input 400, authentication/access 401/403, missing or foreign handles 404,
conflicting identity/content/state 409, expired/cancelled mutation or stale unseen identity 410,
limits 413 and dependency unavailability 503. Clients refuse undeclared attachments before upload;
a provider without that capability refuses capability-specific requests explicitly (422
`capability_unsupported`). An advertised but missing route remains a visible provider-contract error.

## Drafts, Dispatch And Opening

Harness defaults to a durable draft. **Settings → Prompt → immediate handoffs** lets the administrator
accept execution at finalization. The setting applies equally to authorized app and user handoffs;
there is no claimed source-based exception. The UI explains that app-submitted prompts can execute
without individual review. Tool approvals and permissions remain unchanged. Empty context-only
handoffs stay drafts because they contain no turn to execute.

Finalization records its disposition and dispatch identity atomically before releasing the reserved
conversation. Retries return the same outcome even after settings change. Session-side dispatch
state is persisted before native execution can start. Retry can deliver a queued identity; unknown
native execution is never blindly sent again. Startup recovery exposes uncertainty, and the
conversation shows a recovery message. A queued request can be retried explicitly after its provider
is configured. GET and UI navigation never start or retry execution.

Shell validates the returned endpoint and normalized path against the selected app's declared panel,
navigation or entrypoint. External origins, protocol-relative paths, traversal and ambiguous encoded
separators are rejected. Endpoint identities accompany UI surfaces in Core's projection. Shell opens
the result through its normal embedded app authentication; Harness loads the stored draft and files.
Edited or deliberately cleared local drafts are preserved. Current app metadata is used again after
an update or port change. The SDK supports provider-owned routes and headless callers too.

Shell error toasts keep their request identity. App-context and embedded-app asks retain pending
identities in session storage across reloads, isolated by actor, assistant and canonical input, until
the destination has been accepted. A finalized request stays inspectable if opening fails; callers
can reopen `result.open` without preparing another request.

## Persistence And Cleanup

Atomic records live under Harness data `handoffs/<id>/record.json`, outside transcript retention.
Pending files are staged beside the record, then copied into the conversation's normal cache
workspace on finalization. Once released, replay protection retains metadata/fingerprints/results,
not prompt or file contents. A startup and minute sweep repairs interrupted local release, removes
crashed temporary uploads and expires preparations 24 hours after creation, without retry extension.
Cancellation/expiry removes only that pending reservation and its files.

Replay records remain for at least 30 days from creation and as long as the finalized conversation
exists. Deleting a conversation leaves a tombstone through the replay window and never recreates
it. After cleanup, the request-ID age rule prevents an old Prepare from creating a replacement;
GET of a removed record returns 404. Retained cancelled/expired records remain inspectable.

## Operator Transition

This is a coordinated breaking replacement without aliases, data migration or credential import.
Wait until matching artifacts are available; one merged PR does not make publication atomic.

1. Update Core/CLI to 0.110.0 or later and verify readiness. Its distribution descriptor points to
   the new manifest/feed and identity.
2. Update Shell to 0.85.0 or later. Assistant actions can remain unavailable during the pause;
   the rest of Shell works. A stale stored selection requires choosing the new assistant.
3. Uninstall `hosty.ai-gateway`, then install `hosty.harness` from
   `apps/harness/manifest.json` (or its published main URL). Review/confirm the assistant role and
   `apps.skills.read`, configure provider connections anew, and select Harness in Shell.
4. Discover the new app's assigned endpoint; do not assume the old origin or port. Re-register
   Codex and Claude MCP clients and the Hosty connector/plugin against that Harness facade's
   `/mcp` resource, then authorize fresh credentials. Old tokens and grants are not imported.

The old raw `main/apps/ai-gateway/manifest.json` and `feeds.json` paths are removed. They return 404
rather than a different app ID, frozen copy or redirect. Old app update checks and old Core
installers can report unavailable sources and must follow the order above. The old installation's
sessions/settings are not preserved by this replacement. Normal subsequent Harness updates use its
own manifest/feed and retain its app identity. The MCP facade remains in Harness.

For local/source verification use Core-managed install/start with the `dev` runtime, rebuild the
static web export after UI edits, and open through Core/Shell. Native Apple/Cardputer clients have
no hard-coded Gateway discovery contract to migrate in this slice; external MCP registrations use
the actual resolved facade resource. No live operator installation is replaced by development tests.

## Testing Expectations

- Core: manifest validation, legacy/unknown version records, registry reload/update and HTTP directory
  projection of version/capabilities; confirmed-role/permission and OAuth resource behavior.
- Harness: authentication, foreign handles, hidden reservations, retry conflicts, interrupted and
  oversized uploads, ten arbitrary 10 MB files, duplicate names, concurrency, expiry, clock skew,
  deletion tombstones, restart recovery and no repeated native dispatch.
- Draft/immediate behavior, empty context-only drafts, settings changes after finalization, local
  edits/clears, uploaded-file visibility and actionable queued/unknown execution.
- Shell/SDK: mandatory/optional contract checks, stale selection, request identity through uncertain
  transport and page reload, actor isolation and destination validation against current metadata.
- Build/lint/test Core, CLI, Shell, Harness and SDK; run version and generated documentation checks.
  Exercise fresh installation, launch-code identity, attachments and retry through a disposable
  Core-managed runtime. Native provider execution requires an explicitly configured real account;
  fake adapters cover dispatch deterministically without spending operator credentials.

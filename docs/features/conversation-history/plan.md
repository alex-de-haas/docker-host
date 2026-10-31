---
status: Ready
created: 2026-10-30
updated: 2026-10-31
summary: Core-owned conversation history contracts and API/MCP access for provider-owned messages, explicit sharing, search and future indexing.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Conversation History, Sharing And Search

## Goal And Accepted Direction

On 2026-10-30 the owner selects a common Core-owned conversation/message/history interface,
exposed through both ordinary API and MCP. The concrete consumers are authorized sharing across
conversations and applications, search over retained chats, and a separately connected indexer.
Core understands the common exchange contract; the application storing the messages understands
its richer native representation. Harness is one history provider, not a required platform service.
See [vision decision 67](../../vision.md).

The owner identifies Qdrant as the intended future indexing integration and explicitly defers
connecting it now. This plan prepares source and search contracts without installing Qdrant,
choosing embeddings or deploying a vector database. An index is derived data; providers retain
the authoritative conversations and full native records. No migration into a Core transcript store
is selected. The owner approved the complete v1 schema, grants and implementation scope on 2026-10-31
and requested development. D1-D2 are complete and this plan is Ready; see vision decision 68.

## Baseline And Existing Owners

At source baseline `9d932d89a50c4c9ac525a6bed2802918c664ce36`, Harness stores its conversation
records/events and provider-session bindings in [SessionStore](../../../apps/harness/src/sessions/store.ts).
Its [adapter event union](../../../apps/harness/src/harness/adapter.ts) includes text, tool calls,
results, usage and pending user interaction. These internal events are not a universal public
history interface or a guarantee of lossless native-state recovery. Core already knows selected
resource/session associations; the SDK assistant interface supplies handoff/navigation, not a
common cross-provider history, sharing or indexing contract.

[Core MCP](../core-mcp/plan.md) owns canonical catalog grouping and cross-client migration.
[Agent Providers](../agent-provider-interface/plan.md) owns execution/session/run references and
invocation; [Durable Agent Jobs D7](../durable-agent-jobs/plan.md#deliverables) owns Harness recovery.
[Shared Artifacts](../shared-artifacts/plan.md) owns deliberately retained materials and handoffs;
[Harness Orchestration D7](../harness-work-orchestration/plan.md#deliverables) owns their consuming
UI/context visibility. This feature supplies history-specific contracts instead of duplicating
those stores or engines. Broader knowledge search and learned memory remain in
[Ideas I1-I2](../../ideas.md#i2-search-across-knowledge-providers).

## Responsibility Boundary

- Core defines versioned public schemas, provider discovery/routing, operation authority and
  equivalent API/MCP behavior for history reads, explicit sharing and search. No first-party
  application ID, native database path or provider-specific payload determines platform authority.
- History providers retain original conversations, messages, events, attachments and native
  extensions. They expose an authorized common representation with explicit coverage limits.
  Provider-owned storage need not use the wire format. Harness supplies the initial adapter.
- Search/index providers may consume authorized source content and produce derived indexes.
  Their persistence, extraction and ranking do not become a mandatory Core dependency. Qdrant
  connection and any concrete embedding/index service are deferred beyond this plan.
- Consumers choose what to read, display or include in another conversation. Discovery, reading,
  sharing and model-context inclusion are distinct operations. History access is not execution
  authority, and a readable transcript is not a provider-native continuation checkpoint.

Independent resource operations, including environment lifecycle, do not require history support.
An execution-only provider need not fabricate a chat archive. A text-only history provider is
valid without tool-call or token-usage support.

## Candidate v1 Contract For Owner Review (2026-10-30)

The owner approved the following implementation contract on 2026-10-31. The original candidate
heading remains a stable link target. These choices replace the open alternatives above and are
the implementation baseline; approval is not evidence of shipped behavior.
The HTTP/JSON provider contract is Hosty-specific v1, with SSE only for live subscriptions.
MCP uses the same DTOs/services and structured results. ACP/AHP remain optional client adapters;
this feature neither adopts their whole session model nor implements an agent runtime.

### Identity And Provider Declaration

Reuse the installation-qualified identity pattern already used by `HostyTaskProviderRef`:

```ts
type ProviderRef = { appId: string; installationId: string; key: string };
type ConversationRef = { provider: ProviderRef; id: string };
type EntryRef = { conversation: ConversationRef; id: string };
type NativeSessionRef = { provider: ProviderRef; id: string };
type RunRef = { provider: ProviderRef; id: string };
```

References are scoped to the connected Core, not arbitrary remote URLs. IDs are opaque strings,
1-256 characters, never paths or credentials. Installation changes invalidate old references;
reinstallation cannot adopt another installation's grants. Conversation, native session and run IDs
are never interchangeable. Public revisions and sequence values are decimal strings, avoiding
JavaScript integer truncation. Core accepts no client-supplied acting-user identity.

Add the reviewed `conversation-history` provider role/interface, version `1`, with required
`history.read` and optional `history.search.text`, `history.sharing`, `history.changes`,
`history.attachments`, `history.tool-events`, `history.usage` and `history.extensions` capabilities.
The provider's capabilities response gives supported entry kinds, extension descriptors, maximum
page size and change retention. Harness implements the required and optional surfaces used below;
a third-party text-only provider may omit optional capabilities and returns `unsupported_capability`
for their operations. Execution providers without an archive need not declare this role.

Core resolves only reviewed declarations and current installation endpoints. It keeps discovery,
grant and operation metadata, not a new persistent transcript cache. Original history and any
materialized read/search projections remain owned by the source provider.

### Messages, Events And Dynamic Data

```ts
type Conversation = {
  ref: ConversationRef; revision: string; title: string | null;
  ownerUserId: string; createdAt: string; updatedAt: string;
  nativeSessions?: NativeSessionRef[]; capabilities: string[];
};
type ContentPart =
  | { type: "text"; text: string; format: "plain" | "markdown" }
  | { type: "attachment"; attachmentId: string; revision: string;
      mediaType: string; name: string; sizeBytes?: number }
  | { type: "resource"; resourceKind: string; owner: string; id: string;
      revision?: string; label?: string };
type HistoryEntry = {
  ref: EntryRef; revision: string; sequence: string;
  createdAt: string; updatedAt: string;
  actor: { kind: "user" | "agent" | "system" | "tool";
           id?: string; displayName?: string };
  run?: RunRef; parentEntryId?: string;
  data: EntryData;
};
type EntryData =
  | { kind: "message"; role: "user" | "assistant" | "system";
      parts: ContentPart[]; state: "streaming" | "complete" | "interrupted" }
  | { kind: "tool_call"; callId: string; toolName: string;
      input: unknown; disclosure: "complete" | "redacted" | "truncated" }
  | { kind: "tool_result"; callId: string; parts: ContentPart[];
      outcome: "completed" | "failed" | "cancelled" | "unknown";
      durationMs?: number; disclosure: "complete" | "redacted" | "truncated" }
  | { kind: "run_state"; state: string; stopConfirmed: boolean }
  | { kind: "usage"; scope: "turn" | "run"; source: string;
      inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
      estimated: boolean; cost?: { amount: string; currency: string } }
  | { kind: "extension"; name: string; version: number; payload: unknown;
      fallbackText?: string; disclosure: "complete" | "redacted" | "truncated" };
```

Times use UTC RFC 3339. Stable creation sequence orders entries; edits increment entry and
conversation revisions and preserve sequence. A separate change sequence orders mutations.
Deletion emits a tombstone; source payload is not retained just to populate the change journal.
Tool outputs and extension payloads cannot import access to attachments or resource content.
Provider-native hidden reasoning, credentials and internal checkpoints are not public history.
Providers apply disclosure rules before export; absent usage is unavailable, never inferred as zero.
Read projections include `coverage: {state: complete|partial, reasons: string[]}` so truncated
historical Harness events are not advertised as full native records.

Extensions use a reverse-domain namespace plus name, for example `org.example/review-card`, an
integer schema version, and a provider-declared JSON Schema. Core enforces envelope/size/schema
limits without interpreting proprietary fields. Unknown supported extension versions may pass
through as inert JSON with coverage/fallback information; clients must not execute payloads or
silently claim full rendering. Dynamic changes are revisioned entry replacements, not arbitrary
scripts or fetching a provider-supplied URL. Common fields evolve additively within v1; required
breaking meaning or field changes need v2. Unknown optional fields are preserved where relayed.

### Core API And MCP Operations

All paths below are approved new routes under `/api/history/v1`. Read POSTs use ordinary Core
CSRF protection for cookies. Direct scoped credentials use the same authorization resolver as MCP;
there is no browser cookie synthesized for an external caller. The provider-side v1 interface uses
the same relative operation names and DTOs at its declared service endpoint.

| HTTP method/path | MCP tool | Input and outcome |
| --- | --- | --- |
| GET /providers | history_providers | Compatible provider descriptors/capabilities and availability; no conversation contents. |
| POST /conversations/query | conversation_list | Explicit provider refs, optional title filter and cursor; visible Conversation records. |
| POST /conversations/get | conversation_get | ConversationRef; current visible metadata/capabilities. |
| POST /entries/query | history_read | ConversationRef, optional entry-kind filter, page size/cursor; ordered bounded history. |
| POST /entries/get | history_entry_get | EntryRef and optional expectedRevision; current entry or revision_conflict. |
| POST /attachments/resolve | history_attachment_get | EntryRef, attachmentId and revision; metadata and subject-bound Core retrieval handle. |
| POST /search | history_search | Provider refs, q, kinds, optional conversation refs and cursor; authorized source-cited hits. |
| POST /shares/query | history_share_list | ConversationRef; owner sees all grants, recipient sees only their own. |
| POST /shares/create | history_share_create | Exact selection, recipients, requestId and expectedRevision; durable read-only grant. |
| POST /shares/revoke | history_share_revoke | ConversationRef, grantId, requestId and expectedRevision; revocation receipt. |
| POST /exports/create | history_export_create | Provider/corpus and consumer selection, requestId; proposed Core consent record. |
| POST /exports/get | history_export_get | exportGrantId; current consent/status/revision, or content-free purge_required for its still-authenticated former consumer. |
| POST /exports/acknowledge | history_export_acknowledge | exportGrantId, requestId, expectedRevision and lastAppliedCursor or purgeComplete; consumer-owned checkpoint receipt. |
| POST /exports/snapshot | history_export_snapshot | Approved exportGrantId and cursor; bounded initial enumeration plus high-water cursor. |
| POST /exports/changes | history_export_changes | exportGrantId and change cursor; upsert/delete/access-reset records, next cursor. |
| POST /exports/revoke | history_export_revoke | exportGrantId, requestId and expectedRevision; stop further exports and require purge. |
| GET /operations/{requestId} | history_operation_get | Retained outcome visible only to the original authorized principal/user. |
| POST /subscriptions | no separate MCP stream tool | ConversationRef creates a short-lived subject-bound SSE subscription; each read is authorized. |

Provider lists can be read without history content access, but only for providers the caller may
use. Page size defaults to 50, maximum 200; aggregate JSON is at most 1 MiB, an entry at most
256 KiB and a single extension payload at most 64 KiB. Larger content is represented by authorized
attachment/resource references. A provider must not silently truncate JSON to fit these bounds.
Conversation refs per request are at most 100; provider refs at most 8; sharing recipients at most
16 and selected entry IDs at most 200. Query strings are at most 512 characters.

Attachment handles expire after 60 seconds, are bound to user/client/grant/revision and are not
bearer capabilities. GET/range requests recheck current source access and serve at most 1 MiB per
range; the full file stays with the provider. No local path, reusable provider credential or
arbitrary cross-origin fetch is exposed. MIME/name are descriptive, not rendering instructions.
Provider navigation uses its declared UI destination, never a hard-coded Harness route.

Mutations require a UUID requestId; changes to an existing object require expectedRevision.
The shared error body is `{error: {code, message, retryable, operationRef?}}`. Common codes are
`not_found`, `permission_denied`, `provider_unavailable`, `unsupported_capability`,
`version_unsupported`, `revision_conflict`, `request_conflict`, `request_expired`, `cursor_expired`,
`rescan_required`, `resource_in_use` and `budget_exceeded`. Use 401 for authentication, 403 for a
missing operation grant, indistinguishable 404 for inaccessible object identity, 409 for revision/
replay conflicts, 410 for expired cursors/receipts, 422 for unsupported declared input/capability,
429 for quota and 503 for provider unavailability. Unknown error codes remain explicit failures.
Same authorized principal, operation and UUID with identical normalized input returns its receipt;
changed input is `request_conflict`. Reauthorization precedes replay disclosure. Core persists a
pending routing receipt before provider dispatch; providers persist exact replay before effects.
A lost response is `pending`/`unknown`, never permission to retry with a new ID. Retain receipts for
the affected resource lifetime plus 30 days. After full receipt expiry, retain a compact request-ID
hash/fingerprint tombstone for the principal's lifetime and refuse its reuse with `request_expired`,
rather than treating an old UUID as a new create. Revoked/deleted principals cannot dispatch. No raw content/secrets enter Core receipts.
HTTP 202 means pending, not completion. MCP errors carry stable code, retryable and optional receipt
reference; unauthorized objects are indistinguishable from absent ones.

### Access Rules And Explicit Sharing

The effective authority is the intersection of the current user, current client/app permission,
source provider access and conversation/selection ACL. Administrative status alone does not read
another user's history. Core's existing MCP administrator gate stays in place for this release;
ordinary authenticated HTTP readers remain subject to their provider's user restrictions. Harness's
existing administrator-only admission is preserved, not generalized to other independent providers.

| Operation | Installed-app permission | Direct Core scope, in addition to mcp:read | Resource rule |
| --- | --- | --- | --- |
| Provider discovery | providers.conversation-history | mcp:history-read | Current compatible provider access; no history bytes. |
| Metadata/history/attachments/search/SSE | providers.conversation-history + core.history.read | mcp:history-read | Own conversations or an explicit live read grant; attachments/extensions independently included. |
| Create/revoke shares | providers.conversation-history + core.history.read + core.history.share | mcp:history-share + mcp:history-read | Source conversation owner only; recipients cannot reshare. |
| Export snapshot/change corpus | providers.conversation-history + core.history.read + core.history.export | mcp:history-export + mcp:history-read | Explicit owner-approved export grant for the exact consumer and source corpus. |

These are new grants, not aliases of generic read, workspace or assistant-provider access. New
permissions enter existing installation/OAuth review; no automatic upgrade of retained grants.
No extra per-read approval is added after the standing permission and source selection are granted.
Source providers introspect every request, including direct API access, and enforce the same ACL;
Core is not an identity-spoofing proxy or a path around provider admission checks.

For forwarding, extend the existing provider credential with a versioned Core-mediated invocation:
120-second lifetime; exact provider installation/interface audience; original user and installed-app
or direct-grant principal; operation family; bounded resource/grant references. Introspection
rechecks original grants, actor and installation revisions, provider access and token resource bounds.
The source provider independently checks its current conversation ACL after introspection; avoid
recursive Core-to-provider authorization calls from the introspection endpoint. Never represent a direct client as a fabricated installed app. Existing provider-token v1 consumers
remain unchanged; the new token form is required for these history routes.

Sharing v1 is read-only to named existing users of the same Core who have source-provider access.
No anonymous links, public access, groups, edit permission or recipient reshare. The owner selects
stable entry IDs (membership stays fixed while authorized revisions remain live), or explicitly
selects the entire conversation with `includeFutureEntries: true`. Whole-conversation sharing must
state that future messages are included; it is never inferred from workspace membership. Related
tool entries and attachments are shared only when explicitly selected/included. A read grant has an
optional expiresAt (default no expiry); source deletion or revocation always ends future reads.
Sharing an entry does not expose adjacent entries through search or context windows. Share creation
also accepts an optional owner-chosen label; recipients see that label or "Shared conversation",
not a private full-conversation title by default. A shared projection omits nativeSessions, hidden
parent references, unrelated attachment metadata and execution details outside separate session
permission. Returned conversation updatedAt/revision/coverage describe the permitted projection;
private entries do not appear in its counts or title/search snippets. New/revoked grants advance
the source ACL epoch and invalidate affected cursors/subscriptions before another content response.
Grant mutation compares the owner's current conversation revision and advances it atomically with
the ACL change; entry revisions change only when their content changes.

Native immutable snapshot sharing is outside v1. An intentional copied excerpt may be saved through
Shared Artifacts, whose source/version/retention rules apply separately; no claim of retracting
already delivered text is made. Generic history CRUD/edit/delete is also outside v1: the source app
owns authoring and deletion, and publishes the resulting changes. Share/index operations never
rewrite the original chat or inject its text into a different model automatically.

Export grants are separate Core consent records scoped to the source owner, exact provider
installations, `all-owned` or explicit conversation refs, the installed consumer or direct grant,
indexing purpose and optional expiresAt (default no expiry, explicit revocation remains available).
Shared-to-me content is not exportable in v1. The owner approves the
configured corpus once; it may include future owned conversations if explicitly selected. Provider
ACL and revocation still apply on every batch. Access to history does not imply bulk indexing.

### First Search Implementation

Use source-provider lexical search in v1; no vector database or external search service is required.
Harness maintains its own rebuildable search projection of public message text/title, with optional
tool-result text selected through `kinds`. Core holds no persistent text index. `q` is normalized
with Unicode NFKC and case folding, split on whitespace into 1-16 literal terms; all terms must match
the same permitted entry (no regex, query language or stemming). Default kinds contains `message`.
An extension is searchable only through the provider's explicitly disclosed fallbackText.

Search accepts 1-8 explicit providers. If omitted, query all currently permitted compatible
providers when there are at most 8; otherwise return `provider_selection_required`. Unknown or
unavailable providers never become a silent fallback. Results contain EntryRef, source revision,
conversation title, at most 500 characters of excerpt and observedAt. Merge by entry updatedAt
descending, then canonical provider ref and entry ID; do not compare provider-local relevance
scores. Return per-provider coverage/errors and `complete|partial`, without global corpus counts.
A provider lacking search support is reported as unsupported, not as zero hits.

Before emitting each page, revalidate current access to each hit and any excerpt/title/attachment
metadata. Removed access drops the hit; revoked provider access marks that source unavailable.
No stale cached bytes are substituted if the source is unavailable. Query/paging cursors are bound
to actor, provider set, filters and snapshot; changing any requires a fresh search. Deletion or ACL
changes may reduce later pages; disclose that coverage instead of restoring forbidden snapshots.

Qdrant is a deferred consumer of the export contract. A later integration may supply ranking and
semantic retrieval behind another declared provider; it must return original source references and
still obey current access. The present contract does not select embeddings, chunking or collections.

### Stable Reads, Changes And Live Updates

Providers offer a point-in-time read snapshot, held by the source for 15 minutes, with opaque cursors
and a high-water change sequence. Permission checks are current on every page, not frozen with the
snapshot. Expiry is `cursor_expired`, never an implicit restart that can skip/duplicate content.
Native provider stores may implement a separate local projection; this does not require Core storage.

History changes are `upsert` (full permitted replacement), `delete` (identity/revision only) or
`access_reset` (purge the grant's derived partition and rescan). Stable change IDs and monotonic
provider sequence give at-least-once delivery; consumers deduplicate by source ID/revision/change ID.
Start the feed strictly after the snapshot high-water mark to cover changes during enumeration.
Require at least 7 days of tombstones/change IDs for `history.changes`; longer retention is declared.
A cursor gap returns `rescan_required` and requires replacing the affected exported partition,
not retaining an unverified old index. Source payload deletion does not wait for an offline indexer.

Revoking an export grant ends all content access immediately. The authenticated former consumer may
read only a content-free `purge_required` status for its own grant; this allows recovery while the
owner retains no exported payload. Provider removal/reinstallation invalidates the partition.
Grant status and acknowledgement are control metadata, never a route to content after revocation.
An entirely revoked credential cannot authenticate even for status; a consumer must stop serving
its partition on failed revalidation and reconcile or purge before using it again. Acknowledgement
is monotonic, bound to issued cursors and the exact consumer, and cannot reinstate a grant.
An index consumer must acknowledge its last applied cursor and purge status; v1 acceptance uses a
test consumer, without installing Qdrant or promising erasure from uncontrolled third-party copies.

Interactive history uses per-conversation SSE after initial paging. Events notify stable IDs,
revisions and access changes; clients fetch authorized entries rather than receiving a second
unbounded transcript. Reconnect resumes the retained cursor or performs an explicit rescan.
Authorization is checked on delivery and grant changes; revoked streams close. Share connections
within the same authorized browser/backend context and preserve local drafts while refreshing.

### Concrete Examples And Compatibility

A text-only provider returns `message` entries with `history.read`; tool/usage capability is absent.
A Harness tool call/result shares callId and optional RunRef but not hidden native state. A custom
`org.example/review-card` extension can update revision 4 to 5 without changing its EntryRef; an old
client shows fallbackText or an explicit unsupported-details marker. None requires a Core update
when the already negotiated extension envelope remains valid.

For a share, the owner sends `{ref, requestId, expectedRevision, selection: {entryIds: ["m42"]},
recipientUserIds: ["u2"], includeAttachments: false}`. The source persists a grant and returns its
revision. User u2 can fetch m42 through an authorized client, but cannot read m41, export the source
corpus or start its agent. After revocation, the same fetch/search cannot return m42.

For indexing, an approved export returns snapshot page 1 at high-water 200. Entry m42 changes at
201 and is deleted at 202 while paging. The consumer finishes the snapshot, processes changes 201
and 202, removes m42 and acknowledges 202. A missed retention window yields rescan_required.
Reconstruction of a native session is a separate operation under the agent-recovery contract.

Design references: [MCP tool schemas and structured results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
and [ACP extensibility conventions](https://agentclientprotocol.com/protocol/v1/extensibility).
These inform the envelope; they do not supply Hosty resource authorization or mandate a protocol migration.

## Deliverables

- [x] D1. Review and approve the candidate v1 Core/SDK history and search contract above, including example exchanges: provider-qualified identities, message/event variants, extension negotiation, coverage, paging, change cursors, unavailable outcomes and the initial search execution path; reconcile agent-provider references and Core MCP catalog ownership.
- [x] D2. Review and approve the candidate v1 explicit sharing, source/current-caller access, attachment and extension disclosure, derived-copy/index retention, revocation/deletion and migration rules; distinguish references from snapshots and preserve existing private conversations by default.
- [ ] D3. After Ready approval, implement Core/SDK provider discovery and canonical API/MCP history, sharing and search adapters with equivalent authority, bounded results and no mandatory Harness or index database.
- [ ] D4. Implement the Harness history-provider adapter and supported initial search path over authoritative stores, including declared optional events/extensions, stable revisions, change/deletion export, current access and preservation of existing conversations; do not migrate native session state into Core.
- [ ] D5. Verify an independently named history provider, a text-only provider, a richer provider extension and an independent test index consumer through API/MCP; cover authorized cross-chat reads/sharing/search, paging/replay, edit/delete/revocation, unavailable providers and derived-result invalidation without Qdrant deployment or duplicate execution.
- [ ] D6. Document verified behavior and limits in feature.md, reconcile owning feature plans and migration documentation, remove this plan when all deliverables pass and regenerate the index.

## Approval And Implementation Sequence

The owner accepted the complete candidate on 2026-10-31: local named-user/live-reference sharing,
owner-approved bulk export, source lexical search before Qdrant, and bounded schemas/cursors.
D1-D2 are complete and the plan is Ready. Implement D3-D5, then complete D6 with verified feature
documentation. Provider-native recovery and independent environment MCP remain separately owned
and do not block read/search implementation. No Qdrant deployment is authorized by this approval.

## Verification

Documentation-only changes run `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check --base <integration-target>` and `git diff --check`.
The approval/documentation change alone requires no runtime, index server or version bump.

Implementation needs affected Core, Harness and SDK builds/tests plus Core-managed integration
checks through normal identity. Exercise an empty provider registry, independent installation IDs,
current permissions, unsupported optional features, unknown extension versions, dynamic revisions,
concurrent reads/changes, cursor recovery and authorized corpus boundaries. Prove denial before
search snippets/counts/content disclosure, deletion and revocation propagation, stale/unavailable
sources, retained-copy limits and no replay of historical tool effects. Include old-client/provider
compatibility and factual coverage notices. Bump changed artifacts under repository policy.

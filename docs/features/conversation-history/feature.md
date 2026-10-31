---
created: 2026-10-31
updated: 2026-10-31
summary: Provider-owned conversation history with Core API/MCP read, sharing, lexical search, attachment access and explicit consumer-bound exports.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Conversation History

## Ownership And Identities

Core defines the version-one `conversation-history` provider contract and its HTTP/MCP adapters.
Providers own conversations, entries, attachments, access rules and storage. Harness implements this
contract over its transcript and retained projections. Core stores routing, consent, operation and
checkpoint metadata; it does not become the authoritative transcript store.

Every reference carries an app ID, installation identity, interface key and opaque resource ID.
Reinstalling an app changes its identity. Conversation, native-session and run identities are distinct.
Optional references connect these resources without granting access or implying execution continuity.
Core discovery works with no providers installed and with independently named providers.

## Common Projection And Extensions

The common projection provides bounded conversation metadata and revisioned entries for messages,
tool calls/results, usage and supported events. A text-only provider needs no tool implementation.
Capabilities declare supported kinds, namespaced versioned extensions, page bounds, snapshot lifetime
and change retention. Provider-specific execution state remains private. Unknown extensions are not
implicitly interpreted or shared.

Opaque cursors bind their query and source snapshot. Responses report coverage, high water and
availability; expired or invalidated snapshots require a fresh query. Revisions are decimal strings
across SDKs. Source failures, missing capabilities, denied access and unavailable data are distinct
outcomes. Core bounds bodies, pages, searches, resources and cursors before forwarding or returning data.

## Access And Sharing

`/api/history/v1` and the corresponding MCP tools use the same current caller and source ACL checks.
A source request uses a short-lived, introspected Core-mediated credential bound to the originating
principal, provider installation, operation, method, path, body hash and selected resources. Provider
responses are revalidated against current origin and source authority before delivery. No service-only
or unscoped user fallback exists.

Conversations remain private by default. An owner can share fixed selected entry IDs or explicitly
include a whole conversation and future entries with named users in the same Core. Selected IDs
expose their current revisions, not an immutable copy. Attachments and named extensions require
explicit inclusion. Recipients cannot reshare or gain task, source or execution authority. Revocation,
owner changes and deleted content invalidate subsequent reads and derived results. Expiration of an
overlapping share also invalidates snapshots and pending responses when its disclosure changes, even
without a stored ACL or entry revision change.

Attachment resolution produces a short-lived subject-bound Core handle. Each bounded range read
rechecks source access. The provider's storage URL and credentials are not exposed. History and run
subscriptions use subject-bound SSE handles and content-free invalidations; current revocation can
interrupt an in-flight source notification wait.

## Search And Export

The implemented search path is source-backed lexical search over explicit authorized providers and
optional conversation/kind filters. Core normalizes and bounds the query, rehydrates source hits and
verifies their current revision and access before returning snippets. Removed, changed or revoked
hits do not survive through a stale result cache. Provider failures produce explicit coverage outcomes.
No Qdrant instance or mandatory vector index is installed.

Export is a separate owner decision, bound to an exact consumer installation and corpus. History-read
or sharing authority alone does not authorize a derived copy. Export grants carry selection, attachment,
extension, retention and purge rules. Snapshot and change delivery recheck both the consumer and source,
provide deletion/access-loss information, and retain monotonic checkpoints with replay/conflict checks.
Consent can be inspected, revoked and purged through supported API/MCP operations. Core stores no
exported message payload in the grant or operation journal.

Harness projects public transcript fields, checks current ownership/shares again immediately before
sending content, and removes deleted payloads from retained projections and snapshots. Internal
credentials, execution handles and provider-private state are excluded. Provider notifications describe
invalidation; they do not substitute for a fresh authorized source read.

## Testing Expectations

- Verify an empty registry, independently named text-only and richer providers, schema/extension
  negotiation, exact origin/tool authority, current source ACLs and bounded API/MCP parity.
- Cover private-by-default access, fixed and future selection, named recipients, no resharing,
  attachment ranges, cursor invalidation, edit/delete, revocation during long polls and unavailable
  providers. Search must drop stale, denied or changed hits.
- Use an independent export consumer to cover exact corpus/installation consent, replay, checkpoint
  conflicts, deletion/access loss, retention and purge. No live index service or provider secrets are
  required for contract verification.
- Run Harness projection/storage/route tests and both SDK suites. Managed session acceptance covers
  normal password login, cross-user sharing/revocation and actual catalog ownership; task acceptance
  reads and searches a real isolated executor transcript through Core.

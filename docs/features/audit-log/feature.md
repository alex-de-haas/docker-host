---
created: 2026-08-26
updated: 2026-10-10
summary: Core's bounded audit trail records security and lifecycle events, constrains exported metadata and searches retained history with explicit limits.
components: [apps/core]
---

# Audit Log — A Bounded, Append-Ordered Trail

Core records security and lifecycle events to `<core-root>/audit/audit.ndjson`, owner-only because
records include actor identities. Writers append one JSON record per line. Readers walk backwards,
and rotation bounds retained disk usage under normal filesystem operation.

## Records And Producers

`AuditRecord` contains id, action, resource type/id, outcome, actor user id, timestamp and `Details`.
Producers include authentication, credential issuance/revocation, delegated exchanges and app
introspection, approvals, notifications, backups, development workspaces, agent policy and
app-reported activity. Lifecycle endpoints and MCP record operator start, stop, restart, update,
configure, autostart and runtime-switch actions. MCP exposes start/stop/restart and planned updates;
see [Core MCP](../core-mcp/feature.md) for authority, tools and attribution.

HTTP captures the authenticated Host user; local control authenticates a host secret and therefore
has a null user with `via: control`. Refusals before an app-management principal is established also
have a null actor. Queued updates capture actor and transport before detaching, append `accepted`
before starting work, and later append `succeeded`, `failed` or `cancelled` with the same
`operationId`. Client cancellation does not erase a completed action. Lifecycle audit failures are
best-effort: they cost a record and emit a diagnostic, but do not change the mutation response.
The store itself propagates I/O failures; each producer owns its failure handling.

Append order is distinct from timestamp order. Concurrent writers can capture time before waiting
for the append gate, and wall clocks can move backwards. Readers preserve append order rather than
sorting by timestamps, and a timestamp outside the query window does not end the search.

## Details Contract

`AuditStore.AppendAsync` constrains details before JSON serialization. Producers use a reviewed
metadata schema selected by action family; unknown keys and unknown families produce no additional
exported data. New metadata requires an explicit policy change and regression coverage.

| Producer family | Permitted metadata |
| --- | --- |
| `auth.*` | Email, role, labels, expiry, counts, audience, scopes, tool/channel names, reason codes and related app/user/record ids |
| `app.lifecycle.*`, `core.lifecycle.restart` | `via`, `tool`, `operation`, `operationId` |
| Installation, permissions and MCP approvals | Request id, caller, operation, path-change classification, removal options and selected permissions/assistant policy |
| App activity with outcome `reported` | Tool name, actor labels, autonomy/mode/wait metadata and a session fingerprint |
| Notifications and backups | App id, status/reason, recipient/pruned/deleted/skipped counts and backup plan digest |
| Development workspaces and agent policy | Request/assistant ids and policy selections |

The first 32 supplied fields are considered; each accepted value is capped at 4,096 characters and
control characters are removed. App-reported `sessionId` is replaced with `sessionFingerprint`
(the first 12 hex characters of SHA-256), because a raw Core session id is a bearer credential.
Request bodies, settings, passwords, tokens, prompts and exception-message fields are not accepted.
Allowed metadata values still belong to the producer's contract; the policy is a structural schema,
not a detector for arbitrary secrets disguised as a label. Existing on-disk history is not rewritten.

## Rotation

At the next append after the live log reaches 8 MiB, Core renames it to `audit.ndjson.1`, replacing
any previous generation, then starts a fresh live log. The size can exceed the threshold by one
record. The renamed file retains its owner-only mode. Both generations are readable, so a first
rotation preserves the preceding events. Overwriting a previous generation discards older history;
this is an operational trail, not a long-term archive.

Appends and rotation share a gate. A failed rotation is retried at the next append; it can increase
disk usage rather than prevent an otherwise possible write. On the first rotation that overwrites
a previous generation, Core writes `audit.ndjson.discarded`. This marker survives process restarts
and tells later searches that retained history is incomplete. Marker creation is best-effort; a
filesystem failure can lose that completeness signal.

## Bounded Tail Reads

`ReadRecentAsync` serves `/control/v1/audit/recent` (default 100, clamped to 1–500).
`SearchAsync` serves MCP `search_audit` (default 50, clamped to 1–200). Both walk files backwards in
64 KiB blocks without materializing the whole file. A line crossing a block boundary is carried
into the next block. The reader opens both generations under the append gate before releasing it, so a concurrent
rotation cannot duplicate a generation. Each file walk fixes its starting length; later appends to
that file belong to a subsequent read.

Search combines optional resource id, action prefix and outcome filters with an inclusive timestamp
window, clamped to 60 seconds–30 days. It excludes future timestamps and scans at most 20,000 lines,
even when no records match. This bound remains necessary because timestamp order cannot justify an
early stop. A result states its effective range and limit, their clamp flags, returned count and
`truncated` flag, including when empty.

`truncated` is true when the result limit or scan ceiling is reached, or the discarded-history marker
exists. This deliberately conservative signal does not claim that another match definitely exists;
it says completeness is unproven. An exhaustive search on a host with no discarded history returns
false. Filtered search cost is bounded by the scan ceiling; recent reads normally touch only the
blocks needed for the requested records.

## Testing Expectations

- `AuditStoreTests` covers tail reads across block boundaries, a missing final newline, missing logs,
  rotation across both generations, snapshot uniqueness and persisted discarded-history signaling.
- Search tests pair matches and non-matches for all filters, combine filters, exercise both range and
  limit bounds and empty results, and verify exact time boundaries, future/unordered timestamps,
  result-limit and scan-ceiling truncation.
- Every producer family's metadata is preserved while credential/payload canaries are absent from
  the serialized file. Unknown schemas, control characters, oversized values and session
  fingerprinting are covered; real HTTP login, credential issuance and app-report tests verify secrets.
- Lifecycle HTTP tests exercise all seven verbs on HTTP/control, Shell-style app-management actor
  attribution, equivalent route casing/trailing slashes, refusals before and inside handlers, and I/O failure. Queued update tests pair
  acceptance with settled success/failure/shutdown cancellation and prove client cancellation and
  audit failure do not falsify applied work.
- Live acceptance stops a Core-managed app through MCP and Shell and reads both actions back through
  `search_audit`, including a refused MCP mutation, CLI attribution and background update outcomes.

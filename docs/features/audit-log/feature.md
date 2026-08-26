# Audit Log — A Bounded, Append-Ordered Trail

Created: 2026-08-26
Updated: 2026-08-26

Core records security-relevant events to one newline-delimited JSON file,
`<core-root>/audit/audit.ndjson`, owner-only because every line names an actor. Writers append, readers
read backwards from the end, and the file is capped so the trail costs bounded disk rather than
growing for the life of the host.

## What is written

`AuditStore.AppendAsync` takes one `AuditRecord` — id, action, resource type and id, outcome, actor
user id, timestamp, and a string-keyed detail bag — and appends it as a single line. Producers include
every login attempt, every credential issue and revoke, every delegated-token exchange and
on-behalf-of call (**refusals included** — they are the more interesting half of the trail), and every
named MCP tool call ([core-mcp](../core-mcp/feature.md)). The write is best-effort and never rewrites
history: once an action has happened, a failed append costs the line, never the truth of what ran.

The log is append-**ordered**, which is what lets every read stop early: the first record older than a
query's window means every record before it is older still.

## Rotation

The live log is capped at 8 MiB. On the append that finds it at or over the cap, the file is renamed
to `audit.ndjson.1` — replacing any previous generation — and the append starts a fresh live file.
Rotation is a rename, so it costs the same whatever the file's size, and the rotated file keeps its
owner-only mode by construction (it is the same inode).

Two generations are kept rather than one because rotation must not drop the recent past the moment it
fires: **reads span the live log and the generation behind it**, newest first, so a window is never
truncated by a rotation that just ran. Beyond that, history is dropped — this is an operational trail
for answering "what happened recently on this host", not a compliance archive.

Appends are serialized on a gate so a rotation cannot run underneath another append, which would write
into the file that was just moved aside. Audit traffic is auth events rather than a request flood, so
a gate around one small write costs nothing worth measuring. A rotation that fails (a locked or
read-only file) is swallowed and retried on the next append: losing a rotation costs disk, losing the
append would cost an audit record.

## Reads are tail reads

Both readers — `ReadRecentAsync` (the newest N, behind `/control/v1/audit/recent`) and `SearchAsync`
(filtered, behind Core's MCP audit tool) — walk the files backwards in 64 KiB blocks and stop as soon
as they have their answer. A line straddling a block boundary is carried into the next, earlier block
where its beginning is; splitting on the newline *byte* is safe because no byte of a multi-byte UTF-8
sequence can be `0x0A`. Nothing materializes the file, so the cost of a read is set by the size of the
answer rather than by how long the host has been up — the newest-50 read touches exactly one block
however large the log has grown.

`SearchAsync` additionally carries a scan ceiling (20 000 records) so a filter that matches three
entries in a very long file still cannot read all of it, and reports `Truncated` when it stopped on
the limit or the ceiling rather than at the window's start. The window travels with the result because
a caller that cannot see a clamp reports "nothing happened" when it means "nothing in the newest
fifty".

## Testing Expectations

- `AuditStoreTests`: a newest-first read is exact and complete across read-block boundaries (the carry
  is where a wrong tail reader silently drops or splices lines); a log with no trailing newline still
  yields its last line first; an oversized log is rotated aside and a read still spans the rotation;
  `SearchAsync` filters from the end, reports truncation when the limit fills, and stops at the start
  of its window; a missing log reads empty.

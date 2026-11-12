---
created: 2026-11-12
updated: 2026-11-12
summary: Per-conversation storage commits accepted Harness input before dispatch and isolates damaged history without replaying uncertain execution.
components: [apps/harness]
---

# Harness History Durability

## Source And Acceptance

Canonical conversations remain in `sessions/<id>/record.json` and `events.ndjson`.
Writes use unique temporary files, complete writes and file sync before atomic
replacement. Appends are flushed before publication. Parent directories are
flushed where Node supports it; Windows file sync precedes replacement and bounded
sharing-violation retries. This relies on successful OS/filesystem/device flush
semantics and does not recover a failed disk or an operating system that loses
acknowledged flushes.

Source message admission retains its original UUID, fingerprint and preparing or
dispatching intent before native execution. Acknowledged inputs, queue changes,
upload receipts and admitted immutable attachments have durable source evidence.
An incomplete or uncertain admission keeps its execution fence; an idle process
or a failed response does not prove that a model/tool call never started. A
same-session UUID recovers its original receipt instead of creating another send.
Accepted attachment receipts become claimed in the same source checkpoint as
their immutable snapshot, so repeated direct sends do not consume pending-upload
slots. Distinct retained bytes still respect the conversation's storage limits.

The API and Worker each hold an OS-backed exclusive writer lock for their data
role before startup recovery or mutation. The lock file contains no conversations.
Process termination releases ownership; PID reuse or an old heartbeat never
authorizes takeover. Ownership does not prove that detached native processes
from the previous Worker have stopped.

Settings, profiles and per-user suggestion preferences used during message admission
use the same flushed replacement primitive, so their unsynced writes cannot leave
a partial configuration file that blocks later messages.

Source commits settle before derived observers run. A history projection failure
is retained as a bounded diagnostic and retried on later reconciliation; it does
not convert a committed message into a rejected save.

## Per-Conversation Projection

The fresh `conversation-history-v2` store uses immutable, hash-addressed files for
individual conversation projections. `manifest.json` contains checksummed
partition references, trusted owner/revision/ACL metadata, global share receipts
and the monotonic change stream. It contains no transcript payloads. Changed
partitions are flushed before one atomic manifest publication; healthy unchanged
partitions are reused.

Sharing receipts retain global `(principal, user, requestId)` identity across
conversations. Share mutation, ACL metadata and its replay result publish in the
same manifest. The change high-water mark and entry/conversation revisions remain
monotonic within this store. A failed publication retains evidence and seals
further mutations until reopening determines the committed view.

The owner selected a fresh format after deleting the previous sessions. Harness
does not import the old `conversation-history` directory. Cursor keys belong to
the new store, so legacy continuations require rescan. Export grants whose old
checkpoint exceeds the fresh store must be revoked, purged and replaced with a
new owner-approved grant; a rescan cannot reset Core's retained checkpoint. There is no automatic
authority migration or old-binary downgrade path.

## Corruption And Restart

Journal reads validate sequence identity and distinguish absent data from corrupt
or inaccessible evidence. A complete last event without a newline remains valid.
A proven incomplete terminal append is preserved as recovery evidence before
repair; another append cannot concatenate with it. Interior damage or conflicting
sequences require recovery instead of silently dropping messages. The next event
uses reconciled durable high water even if the record checkpoint lagged behind
the journal when the process stopped.

Source deletion first commits an identity-only tombstone outside the removed
conversation directory. A stale restored directory or delayed callback cannot
recreate that retired identity. Unreadable deletion evidence requires recovery
instead of being interpreted as either a confirmed deletion or a new conversation.

An unavailable record is not deletion. Inventory and projection reconciliation
retain its authority and do not create false tombstones or remove shares. A
damaged partition is omitted from common enumeration with explicit partial
coverage; authorized direct access reports recovery required. Corrupt global
authority blocks common sharing/export, while private source sessions remain
independent. Missing current authority never silently selects an older ACL,
receipt or idle state.

One bad Worker record retains its original run identity and blocks resubmission
of that identity. Startup continues for healthy runs and independent recovery
stages. An uncertain Worker publication cannot later report successful admission
without reopening and reconciliation. Neither recovery path repeats accepted
work automatically. Existing explicit native-exit confirmation remains necessary
for interrupted execution.

The assistant shows bounded storage diagnostics to current administrators. A
valid owned session with a storage/admission fence retains its visible draft and
attachments while Send and mutation controls are blocked. Source-only admission
recovery uses the same explicit operator confirmation and stable recovery UUID
as interrupted-execution recovery; it preserves the transcript and original
message receipt. A retained native handle blocks attestation until supported Stop
confirms exit; Stop remains available for a failed admission. Live status changes
and a settled admission review refresh the authoritative session snapshot, so a
temporary admission fence does not permanently block a tab's preserved draft.
If source storage cannot record cancellation, Stop still attempts to stop the
retained native handle. Confirmed process exit clears only volatile execution;
the durable admission, run and source leases remain fenced for reconciliation.
The request reports the storage error instead of claiming a saved cancellation.
An unconfirmed Stop retains its handle and is not automatically retried.

Corrupt or expired paging snapshots invalidate their own continuation rather than
unrelated queries. Cursor keys are created exclusively from flushed bytes. Deleted
payloads are removed from active projections/snapshots and obsolete partition
generations; rejected or uncertain writes retain bounded recovery evidence rather
than becoming a second live source.

## Verification On 2026-11-12

Verified in a registered local Core workspace on macOS ARM64 with Node 24.18.0,
.NET 10.0.402 and Docker 29.9.3:

- `npm run harness:lint` passes backend/web TypeScript and ESLint.
- `npm run harness:test` passes 3,007 tests across 253 files. Four child-process
  crash probes stop after preparation, input commit, native-effect simulation and
  accepted-receipt commit; reopening never duplicates the synthetic effect.
- `npm run harness:build-web` and
  `npm run build:local --workspace @haas/hosty-harness` pass production web and
  API/Worker bundle preparation.
- `npm run test:integration -- worker` passes container lifecycle, identity and
  native-contract fixtures without provider credentials or model inference.
- `HOSTY_HISTORY_DURABILITY=1 HOSTY_SUGGESTIONS_BROWSER=1 npm run test:integration -- harness-local`
  passes normal child Core password login and launch-code identity, compiled
  assets, accepted paused input/attachment and UUID replay after real API/Worker
  restart, isolated corrupt session/run records and the controlled Chrome UI
  scenarios. Cold start is 45.301 s, warm restart 2.044 s and missing-output
  recovery 40.117 s. Parent Finish confirms resource removal.
- Version consistency, documentation links/index and whitespace checks pass.

Standalone storage checks on Windows with Node 24.19.0 pass 11 scenarios plus a
measured cold sharing-lock probe: real file sync/replacement, exclusive creation,
append, terminal JSON/UTF-8 repair, checkpoint fencing, corruption isolation,
deletion tombstones and writer-lock release after killing only the owned fixture.
A real `EPERM` sharing violation succeeds after the temporary handle closes.
The fixture processes exit and its private Windows temporary directory is removed.

These are synthetic storage faults, process termination and isolated runtime
restarts, not physical power-loss tests. Windows full-app/Core/browser deployment
and live provider inference are not exercised. Node's unsupported Windows
parent-directory sync is explicitly omitted. The optional heavyweight `tasks`
integration suite is not selected. Core/CLI fixture builds retain the existing
ILCompiler advisory/analyzer warnings and complete without errors.

## Testing Expectations

- Inject failed/delayed writes, sync, replacement and publication; check the
  acknowledgement/dispatch boundary and the affected mutation fence.
- Kill an isolated writer and reopen its store. Preserve exact request identity,
  committed journal high water, queue pause, attachment bytes and unknown effects.
- Cover incomplete/NUL terminal appends, missing newline, interior corruption,
  duplicate sequences, missing records and per-session/run failure isolation.
- Verify lost manifest replies, revoked shares, global receipt UUID conflicts,
  monotonic deletion of a damaged partition and bounded partial coverage.
- Verify accepted attachment identity after cache loss or same-name replacement,
  and repeated direct references without exhausting pending-upload capacity.
- Seal source storage during execution and verify Stop reaches the real native
  child or Worker while retaining durable recovery evidence and source leases.
- Attach during normal admission, settle it through authoritative refresh, and
  preserve the draft and newer live status without automatic send or recovery.
- Exercise real Windows sharing/replace behavior and writer death in a private
  temporary fixture; separate this from physical power-loss evidence.
- Run affected unit/HTTP/component suites, Harness lint and production builds,
  `HOSTY_HISTORY_DURABILITY=1 npm run test:integration -- harness-local` with normal
  child Core login and real API/Worker restart, and the Worker integration suite.
  Finish the owned child and verify resource removal. No live provider credential
  or production fault injection is required.

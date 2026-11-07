---
created: 2026-11-06
updated: 2026-11-07
summary: Core measures managed disk storage in one cached snapshot shared by Shell's overview and application details.
components: [apps/core, apps/shell]
---

# Managed storage usage

Core measures disk usage inside its configured data root. Shell presents the measurement under
administrator-only Settings > Host > Storage and the Storage tab in application details. The overview
uses colored stacked bars and keyboard-accessible legends, with categories for applications,
sources/worktrees, test environments, backups, Core and other files. Categories and resources
are ordered by size. The overview bar represents measured Hosty storage; available space on
the containing volume is separate context.

Storage uses the existing Settings navigation at `/settings?tab=host&section=storage`; there is
no separate Storage item in the main sidebar. The previous `/storage` address redirects to that
Settings destination and preserves assistant continuation parameters. Application details link
back to the same Settings overview.

## API and authority

`GET /api/storage` returns `{ snapshot, isScanning, lastError }` without starting filesystem
acquisition. `snapshot` is null until the first recount. `POST /api/storage/refresh` accepts
`{ requestId: <UUID> }`, starts or joins one background scan and returns the same state with
HTTP 202. The previous completed snapshot remains available while its replacement is measured.
Refresh requests are retained for bounded replay within the Core process; an uncertain response
must be retried with its original UUID. Snapshot and replay state reset when Core restarts.

Both routes require the current acting user to be an administrator. Refresh also requires the
normal mutation CSRF contract. App-mediated requests additionally require `core.storage.read`
and `core.read` for GET, or `core.storage.read` and `core.configure` for refresh. The storage
permission exposes aggregate sizes, resource names and relative paths, without granting source
contents or source-management authority. An existing Shell installation needs the new required
permission approved through its ordinary permission review.

Snapshots contain an identifier, start/completion timestamps, duration, allocated and logical
byte counts, partial status, volume capacity when available, category totals and resources.
Resources include stable root-relative identities, type, label, path, application/workspace
associations and storage parts. Measurement issues carry bounded relative paths and machine
codes; the total issue count can exceed the retained issue list.

## Ownership and scope

An application's own files include its data, cache, logs and installed/runtime files. Managed
source checkouts are classified as sources, and worktrees and shared repository storage are
separate resources. Backups and child-environment storage have their own categories. Unclassified
files and files left by removed applications remain in the measurement.

App details reuse the same snapshot. Related source, workspace, backup and environment resources
are shown separately from the application's own total. Several applications can refer to one
resource without adding it to the overview more than once. Each measured filesystem identity is
charged to its first encountered resource; hard-linked files do not inflate category totals.

Only data inside the selected root is measured. Nested mounted filesystems, bind mounts and
symbolic-link targets are excluded. Docker images, container layers and other storage outside
that root are outside the measurement. The scanner reads filesystem metadata plus bounded
Core resource metadata for labels and associations; it does not read application file contents.

## Measurement semantics

Allocated bytes represent the filesystem's reported allocation. Logical bytes represent file
lengths, with directory allocation included only in allocated sizes. These figures are not a
promise of uniquely owned physical blocks or bytes reclaimed by deleting a resource: compression,
copy-on-write clones, filesystem snapshots and other sharing can affect physical capacity.

The scan is an observation over a time interval, not an atomic filesystem snapshot. Unreadable,
changed or disappearing entries and acquisition limits produce an explicitly partial result.
Unavailable allocation is represented as null rather than a logical-size substitute or zero.
The scanner bounds duration, entries, resources and retained issues. The UI preserves prior
measurements during refresh and distinguishes loading, partial, failed and unavailable states.

Shell loads state on entry and observes an active recount for a bounded period. Idle pages do
not poll or trigger scanning. Hidden pages pause recount observation; Check status performs an
explicit read when observation is paused or failed. Recount retries retain an uncertain operation's
UUID. An older Core or missing permission is displayed as an error, without automatic mutations.

## Testing Expectations

- Isolated fixtures cover empty registries, unrelated application IDs, classification, source and
  workspace relationships, backups, unknown files and additive category/resource totals.
- Filesystem checks cover allocation, hard links, symbolic links, mount boundaries, unreadable or
  disappearing entries, metadata races and bounded partial results.
- HTTP checks cover anonymous/non-admin denial, CSRF, delegated storage permissions, explicit
  acquisition, concurrent refresh coalescing and request replay.
- Shell checks cover route authorization, bar/legend interactions, tiny resources, unavailable
  allocation, shared app resources, loading/errors, recount observation and no idle polling.
- Runtime acceptance uses a Core-managed child with synthetic files, normal password login and
  authenticated Core/Shell routes. Native behavior requires validation on each supported OS;
  macOS results do not establish Windows or Linux runtime readiness.
- `npm run test:integration -- shell` exercises storage through the installed Shell. Setting
  `HOSTY_SHELL_STORAGE_BROWSER=1` and `HOSTY_PLAYWRIGHT_MODULE` to an installed Playwright module
  adds real Chrome navigation, recount, resource disclosure, mobile layout and app-details checks.
  Browser credentials travel over stdin and browser state is discarded after the run.

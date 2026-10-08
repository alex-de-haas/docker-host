---
created: 2026-10-08
updated: 2026-10-08
summary: One Core-owned consent page for review-required app updates, with frozen change metadata and direct routine update actions.
components: [apps/core, apps/shell]
---

# A Single Core Review For App Updates

Shell's ordinary update action reads Core's valid cached snapshot or rebuilds once when missing,
expired or following a failed check. Routine updates go directly to the queued apply endpoint;
review-required updates open Core confirmation without a preliminary Shell plan dialog. Failed
checks and missing digests trigger preparation or an actionable error, rather than inventing new
permissions. A definite stale-plan refusal before queue acceptance triggers one refresh and a new
routine/review classification. Transport failures and errors after acceptance never replay the
mutation. The menu's Update app action follows the same rule. Update all includes only eligible
routine offers, continues past individual stale refusals and queues Shell last. No scheduled automatic apply is introduced.

Core review renders the frozen current/target versions and runtimes, source, backup outcome,
actual manifest changes and safe settings schema deltas. It omits empty change sections and secret
values. Added and removed settings show type, sensitivity, required-at-launch and default-presence
metadata. Mount declaration changes include addition/removal, access mode, service scope, required
launch binding and cardinality. They require review even when existing paths remain usable; queued
routine apply rechecks those changes against the installed manifest, including legacy cached plans.
Permission badges compare previous required/optional declarations; effective missing or
revoked rights are separate access information. Existing accepted optional choices remain selected,
new ones start unchecked, and legacy baselines are explicitly unavailable. Snapshot metadata is
included in the plan digest and never re-fetched from a moving feed during consent.

Candidate configuration readiness is shown before approval. Apply rechecks under the app lock
and leaves an incomplete target successfully installed and stopped, preserving automatic startup.
The shared [configuration experience](../app-configuration-experience/feature.md) provides the
Configuration required warning and Configure action. This does not add a lifecycle state.
An incomplete Shell update leaves Shell itself offline. Its Core review explains recovery through
the local Core control API and an explicit `hosty apps start hosty.shell` after configuration.

Installed feed selection belongs to Settings → Source. Saving it changes the followed update source
and refreshes the candidate; installed version, runtime and permission grants are untouched. The
next update is a separate action with normal Core consent when required. Core confirmation has no
feed selector.

Popup reservation remains synchronous in a user gesture and blocked windows retain an explicit
opening action. Cancellation does not apply changes. Approved operations run in Core's background
and report persistent progress; uncertain mutations are never blindly repeated. Reviewed requests
recover by status using the same request identity. Shell self-update retains its wait/reconnect and
manual reload guidance.

## Testing Expectations

- Frozen review tests cover declaration/grant differences, optional-to-required moves, legacy
  metadata, safe settings details, mount declaration deltas, exact source/runtime/backup information
  and secret-safe HTML escaping. Mount-only changes and legacy routine snapshots cannot bypass review.
- HTTP tests cover current administrator/caller authority, nonce/Origin, stale snapshots and atomic
  one-time execution, including channel/runtime changes before consent.
- Shell tests cover bounded stale preparation through the real row transport, reclassification,
  accepted/uncertain mutation guards, bulk continuation, routine routing and blocked popup fallback,
  cancellation, uncertain status recovery and self-update reconnect.
- Browser acceptance checks a review-required update opens exactly one Core review, a routine
  update opens none, feed changes do not apply automatically and incomplete apply remains stopped.

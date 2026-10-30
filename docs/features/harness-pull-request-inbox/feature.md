---
created: 2026-10-29
updated: 2026-10-30
summary: Harness PR page, compact panel and manual actions backed by installed-app discovery, shared CI presentation and adaptive GitHub observation.
components: [apps/core, apps/harness]
---

# Harness Pull Request Inbox

Harness exposes a **Pull requests** navigation page at `/pull-requests` and a separate list-only
panel at `/pull-requests-panel`. Both use Core's repository-level read API. A PR needs no Hosty
conversation, task or workspace; Dependabot and other externally created PRs appear alongside
workspace publications. Browsing starts no agent work. Explicit manual Merge and Update branch controls use fresh GitHub authorization and recoverable Core commands.

## Installed Repositories And Access

Core derives candidates from installed application source records, including stopped or failed
applications. It normalizes source URLs and coalesces provider repository identities, retaining the
associated app labels. It does not enumerate account repositories, fetch Git, create a checkout or
use workspace-only repositories to expand the inbox. Missing and unsupported source metadata have
explicit coverage notices. The provider adapter supports GitHub.com.

An active administrator uses their existing personal source connections. An app client supplies its
service token and a current user app identity with `apps.sources.full`; ordinary Core sessions use
normal authentication and CSRF protection for POST requests. Private-source grants remain bound to
their reviewed owner, repository and connection. Core uses an exact reviewed connection or a sole
eligible account. Ambiguous selections and conflicting canonical aliases require selection through
existing source settings. Public repositories also use a connected account; a local clone establishes
no provider access.

Repository/PR identities use provider IDs. A repository rename can follow one validated GitHub
repository-identity redirect on the fixed API authority. Requests never follow arbitrary provider
URLs with credentials. Local permission, installation, source and connection changes are rechecked
before reads; changed bindings evict protected cached data. Shared detail reads and cache hits
also recheck each recipient's current app installation, source permission and source/account binding
before returning the result; authorization of the initiating reader does not authorize other waiters. Remote repository proofs last at most
five minutes. Confirmed repository denial hides its rows and details; missing check/review capability
has an unknown/unavailable state instead of implying an empty or passing PR.

## HTTP Contract

All routes use `/api/pull-requests` and return `Cache-Control: no-store`.

| Method and suffix | Result |
| --- | --- |
| `GET /repositories` | Accessible installed repositories, associated apps, coverage and installation-scoped preference key. |
| `GET /` | Open/draft summaries with repository, app, author/bot, draft, CI, review and text filters. |
| `GET /{repositoryId}/{number}` | Description, current summary, versioned reference and authorized related workspace links. |
| `GET /{repositoryId}/{number}/checks` | Current-head check contexts with bounded opaque pagination. |
| `GET /{repositoryId}/{number}/review` | Current-head review-thread previews and provider links. |
| `GET /{repositoryId}/{number}/diff?head=...&base=...` | Immutable-SHA comparison verified before and after the provider read. |
| `GET /{repositoryId}/{number}/actions` | Fresh action eligibility, auto-merge status and an unresolved owner/installation-bound command, if present. |
| `POST /{repositoryId}/{number}/actions` | Explicit head/base-bound Merge or Update branch with a UUID receipt. |
| `POST /{repositoryId}/{number}/actions/recover` | Read-only result recovery; a missing request is never dispatched. |
| `POST /refresh` | UUID-keyed, coalesced bounded refresh request; queued/deferred receipt. |
| `POST /subscriptions` | Short-lived, actor-bound, one-use stream handle for bounded scopes. |
| `GET /events?subscriptionId=...` | Authorized SSE revision hints, readiness and keep-alives. |

List pages default to 50 rows (maximum 100). The compact panel requests 30. Opaque list/detail
cursors expire after two minutes and cannot cross actors, binding changes or detail head changes.
No route accepts an arbitrary repository URL. Receipts separate freshness from completeness;
partial scans and inaccessible repositories do not become a successful empty result. The aggregate
includes known totals only when coverage is complete.

Descriptions are limited to 256 KiB. Checks and review threads use 100-item pages, up to 500 items.
Thread previews contain the first comment and link to the complete provider discussion. Diff reads
use the shared publication comparison parser, reject the 300-file completeness boundary and bound
provider bodies to 4 MiB. Missing patches remain unavailable previews, without guessing whether the
file is binary. A changed head/base requires a new comparison; old review coordinates are not applied
to a new revision.

## Manual Actions

The full detail view shows Merge, Update branch and GitHub auto-merge status. Confirmation identifies
this PR, its destination branch and displayed head. Core rechecks the administrator/app installation,
installed-source binding, selected account and remote eligibility, and requires the same head/base.
It repeats the local binding check after provider pacing immediately before dispatch. GitHub remains
the final authority over permissions and branch rules. CI counts alone never authorize a merge.

Merge requires an open non-draft PR with GitHub `clean` readiness, repository write permission and
merge commits enabled. It calls the asynchronous GitHub REST merge API at version `2026-03-10`,
with the expected head, `merge_method: merge`, `merge_action: direct_merge` and `bypass_rules: false`.
There is no squash/rebase selection, admin bypass, or implicit queue enrollment. A merged response
is verified against the requested head; an existing queue entry is not reported as a completed merge.

Update branch is offered for GitHub's `behind` state with no conflicts, and merges the base into the
PR branch using `expected_head_sha`. This initial adapter supports updates within the same repository;
fork updates use GitHub's separate branch permission flow via the provider link. Acceptance remains
pending until reads prove that the new head contains both the previous head and observed base.
New CI evidence belongs to that new head. Unknown or blocked requirements disable the buttons with
an explanation. Auto-merge is displayed as enabled, disabled or unavailable; its enable/cancel controls
and unattended merging are not part of this manual action contract.

Core writes a credential-free, owner-only receipt before dispatch. One bounded journal retains up to
4,096 commands per owner; reaching that limit refuses new actions instead of removing replay evidence.
Commands bind their UUID to actor, repository, installation/source/account authority, PR, action and
head/base. A reused UUID with different input fails. Unresolved actions block new dispatches for that
PR, and successful writes cannot be repeated for the same head/action. Pending/uncertain receipts
survive Core and browser restarts; the UI restores Check result. Recovery only reads the remote result,
including GitHub's asynchronous request receipt where available. Missing or expired provider receipts
and unrelated head changes are not success evidence. Explicit provider rejection is a failed action;
network loss after dispatch stays uncertain. Starting another command clears the previous result;
only a result with that command's UUID affects its status or recovery controls. Older availability
reads cannot replace a newer pending command. No automatic write retry occurs.

Action availability loads on entry, relevant head/state changes and explicit refresh, without another
polling loop. Writes and recovery share the provider budget, invalidate cached details/compact facts,
and request normal scoped observation updates. Browser credentials never include the GitHub token.
The [GitHub REST contract](https://docs.github.com/en/rest/pulls/pulls) defines the provider operations.

## Shared Observation

Core owns one scheduling path for inbox inventory, compact PR facts and eligible existing workspace
publications/references. Harness proxies reads and bridges the scoped SSE stream through its existing
WebSocket transport; it has no independent GitHub polling loop.

| Relevant admitted stream demand | Target interval |
| --- | --- |
| Repository discovery | 60 seconds |
| PR with running/pending CI, or a recently seen head with unknown checks | 10 seconds |
| Quiet PR | 60 seconds |
| No relevant subscribers | At least 300 seconds |

Intervals add stable positive jitter up to ten percent. Demand starts when the stream is admitted,
not when its handle is issued. Workspace scopes only promote registered references through their
current authority. The page subscribes to its displayed page and selected detail; a hidden narrow
screen list does not retain fast summary demand. Visibility loss, disconnect and stream disposal
release demand. A 120-second stream lifetime, 15-second keep-alives, 5-second write deadline and
45-second client watchdog bound abandoned or stalled streams. Reconnect obtains a new handle and
re-reads authorized state. Streams contain revision/resource hints, not durable business events.

Browser change hints coalesce for 150 ms and retain at most one trailing snapshot refresh. Background
snapshots are serialized, with at least five seconds after a completed refresh before the next one;
quiet streams and heartbeats schedule no reads. Stream revisions reflect only subscribed repositories,
individual PRs and workspaces; unrelated observations do not invalidate a consumer. The owner-wide
change signal only wakes server-side reconciliation and is separate from the emitted scope revision. Hide/unmount cancels queued reads. Stream readiness
performs one reconciliation after connection, scope changes or visibility restoration, without an
additional pre-connect read. Explicit refresh remains immediate. These limits affect Harness-to-Core
snapshot requests independently of the provider polling intervals above.

Inventory reads use stable REST pagination with ETags. A compact GraphQL query batches up to ten
due PRs and separates checks from descriptions/review bodies. Partial results preserve known facts
with explicit incomplete coverage. Disappearance from a partial inventory is not proof of closure;
Core requests current PR facts. A short owner/connection/repository cache coalesces overlapping
workspace and inbox observations. Compact display facts never establish publication completion;
merge/release/cleanup evidence still uses the existing verifier. A missing alias in a partial status
response gets a separate 30-second retry deadline with positive jitter. Its last successful observation
time remains unchanged and its displayed facts remain stale until a successful status read; requested
or missing-inventory markers cannot bypass that deadline or crowd out other due PRs.

The shared account budget allows one request per account, at least two seconds between starts and
four concurrent requests globally. Automatic observation has 2,000 REST charged reads and 2,000
GraphQL points per hour ceilings and reserves 20% of known provider allowance. Conditional `304`
responses consume pacing but not the charged-read ceiling. Rate/reset/poll headers, GraphQL cost,
secondary limits and transient failures delay work. Manual refresh and invalidations use this same
queue and cannot bypass the budget. Sequential requests in the publication verifier wait for account
pacing, including after a compact observation, while cancellation, automatic allowance reserves and
provider backoff remain effective. A manual refresh has a ten-second repository cooldown.

The owner limit is 100 accessible repositories, 1,000 retained PRs per repository and 10,000 per
owner. The persisted summary cache is bounded to 32 MiB; capacity eviction marks partial coverage.
Detail cache limits are 64 MiB per owner and 256 MiB globally, with a 30-minute idle expiry and
60-second revalidation window. Restored summary files contain no credentials and grant no authority:
Core revalidates local bindings and obtains a fresh remote proof before exposing their contents.

## Page, Panel And Optional Context

The full page presents searchable/filterable rows and description, check, review and change sections.
Initial detail loading shows the shared H indicator centered in the detail pane, with an accessible
loading label. Detail tabs appear with the loaded PR; the narrow-screen return action stays available
during loading and errors. Background refreshes retain the displayed PR.
Descriptions and review bodies render Markdown mixed with sanitized HTML, including native keyboard-
accessible details/summary disclosures used by Dependabot release notes and commit lists. The parser
runs before the GitHub-style allowlist sanitizer; scripts, active embeds, forms, inline styles and
handlers are removed. The shared link policy rejects unsafe schemes and opens permitted links in a
separate tab. Images remain explicit links rather than automatic remote requests. Chat messages
retain their existing escaped-HTML behavior.
Both lists reuse the workspace card's two-line summary and status icon without a disclosure control:
title/number, then repository, author for active PRs (Merged for merged PRs) and compact CI counts.
App names are retained in inventory/filter context rather than repeated on each row. The detail
view and expanded workspace card share the segmented CI bar; the inbox bar opens its Checks tab.
CI text separates passed, failed, running, pending, skipped, neutral, cancelled and unknown states.
Completed counts do not imply all checks passed. Expanded detail pagination is retained during live
revalidation, and the diff retains the selected file. An exact head/base diff is not fetched again
for unrelated CI or review observation hints; changing either revision fetches the new comparison. Keyboard selection and the narrow-screen
list/detail return path use the same data model. Browser storage holds display filters under a key
scoped to Core, owner and app installation; descriptions and diffs are not persisted there.

The panel opens a selection with SDK main navigation using the current bound navigation entry and
app installation. It keeps the compact view mounted. An unsupported host gets an explicit
separate-window link. Core contains no Harness route or first-party app-ID policy for this behavior.

Each summary includes a v1 PR reference with provider/host/repository/PR identity, verified URL,
head and observation revision. Related links come from authorized workspace inspection and are
absent when no relationship exists. Routine, analysis and decision capabilities are optional and
have no fabricated actions. A bounded internal invalidation adapter accepts only already authorized
known resources; duplicate and older signals request reconciliation without overwriting facts.
Its resource envelope also represents non-PR subjects, including a game position, without GitHub
fields. Webhook registration/receivers, durable event publication, routines and decision storage are
outside this inbox implementation; their remaining scope is linked from the [plan](plan.md).

## Testing Expectations

Core tests cover source/connection changes, stopped apps and canonical aliases, remote denial,
unknown check capability, bounded provider requests, conditional inventory, head changes,
stream admission/disposal, account pacing/budgets and publication evidence separation. Regressions
cover in-flight coalesced readers whose app permission is revoked or whose installation changes,
partial-status retry fairness and stale receipts, and background verifier completion after pacing. Harness tests
cover proxy restrictions, scoped subscriptions, bounded notification bursts, slow/trailing snapshot
reads, owner/visibility isolation, immutable diff reuse, explicit CI counts,
main/fallback navigation, shared row/CI rendering, mixed Markdown/HTML disclosures, unsafe HTML/URL
removal, inert remote images, confirmation, changed-head rejection and recovery with the same UUID. Existing publication tests remain required.

Run affected Core tests/build, Harness tests/lint/web build, `npm run check-versions`, documentation
validation and `npm run core:aot`. `npm run test:integration -- pull-requests` builds a separate
acceptance executable with an injected GitHub fixture and runs the full read path in a Core-managed
child with separate password-authenticated users, Harness containers and deterministic provider data. Fixture actions cover branch updates, merge, replay, missing-request recovery and denied users without any real GitHub write.
The test executable has no shipping runtime switch; it refuses non-fixture credentials and external
network forwarding. `HOSTY_ACCEPTANCE_HOLD_UI=1` retains the disposable child for browser checks
through Shell until its documented `finish-ui` acknowledgement; the parent then verifies Finish.
`npm run test:integration -- sessions` covers existing workspace/publication lifecycle regressions.

These fixture checks do not prove live GitHub compatibility. The separately authorized live read and
its account-consent prerequisite remain tracked in [D7](plan.md#deliverables).

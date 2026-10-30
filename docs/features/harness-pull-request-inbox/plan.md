---
status: In Progress
created: 2026-10-29
updated: 2026-10-30
summary: A dedicated Harness page with detailed PR views and a compact list-only side panel for repositories of installed applications, including Dependabot.
components: [apps/harness, apps/core, packages/app-sdk]
---

# Harness Pull Request Inbox

## Goal And Authorization

Provide one Harness view of active pull requests in the repositories of applications installed on
the current Hosty instance, regardless of whether Hosty created the PRs. Include Dependabot and
other external PRs alongside workspace-linked PRs. Derive the repository set automatically from
installed application source records, subject to current read access. There is no favorites list,
manual repository enrollment or arbitrary repository picker. Browsing requires no assistant chat.

On 2026-10-29 the owner explicitly asked the agent to resolve the remaining technical decisions
and bring this plan to Ready, without implementation or commits. D1 records that approved design.
The owner subsequently authorized implementation without commits. The read surface is present;
the deliverables below track verified progress and remaining live-provider acceptance. This develops [idea I18](../../ideas.md#i18-active-pull-request-inbox-and-repository-observation).

The selected first feature is a dedicated Harness navigation page with PR list/details and a separate
compact list-only panel. Core supplies adaptive polling and a shared cache using existing personal
GitHub connections. Relevant live stream subscriptions select faster observation; no subscribers
means a five-minute baseline. The owner also requested a design that can later accept webhooks for
public production origins; this version implements polling only, with a shared invalidation boundary.

On 2026-10-29 the owner authorized implementation of the Ready plan, without commits.
On 2026-10-30 the owner authorized committing and publishing this workspace as a PR, addressing
review findings, waiting for CI and code review, and merging with a regular merge commit. The
previously deferred live GitHub acceptance remains open. PR automation, general
assistant events and the webhook receiver retain their own separate scope and are not prerequisites.

Owner clarification, 2026-10-29: installed applications determine repository membership, including
installed apps that are stopped. Several apps can reference the same repository; observe and list
it once and show its associated installed apps. User-selected display filters do not redefine this set.
The owner further selects only currently accessible repositories/PRs for observation and display,
using existing Core connection rules. Installed-source metadata defines candidates; verified access
defines the effective tracked set. A local checkout or installed runtime does not prove remote access.

The initial feature is installed-app repository discovery, observation and browsing. It must work with the general
durable-event, routine and decision features absent. Their links define compatible boundaries;
they do not silently expand this feature into an automation system.

## Baseline And Change

At inspected Hosty main `fee7bece4b6b50810c929a7ea6daee8e31c56664`,
[Assistant Pull Request Lifecycle](../assistant-pr-lifecycle/feature.md) owns publication and
observation for registered workspaces, and [workspace review design](../design-system/plan.md#pull-requests)
describes their PR cards and review page. The publication observer uses a 30-second timer to refresh
registered publications and external references. This is not discovery of all open PRs in installed
application repositories, nor an aggregate repository-level inbox.

[Runtime source records](../runtime-source-workflows/feature.md) and
[source-provider handling](../source-providers/feature.md) supply the installed-source/credential
foundation. The existing SourceDocumentService derives repository entries from installed apps and
also adds workspace-only entries, grouping by repository and branch. Reuse appropriate identity/access
logic, but do not consume that broader collection unchanged: this inbox requires installed-app
associations and repository-level deduplication, independent of branch and local checkout availability.

Existing [panels](../sdk-panel-system/feature.md) and [UI composition](../sdk-ui-composition/feature.md)
support separately declared app-owned tools. Reuse them for a compact Harness PR list panel,
with a separate full-page list/detail surface reached through its own Harness navigation entry. Core must not recognize a fixed Harness app ID or know
its internal route. Showing a PR must not create a source workspace, conversation or task.

## Selected First Experience

1. Select the new Pull requests navigation item in Harness to open its dedicated list/detail page,
   or open the separately declared compact PR list panel in a compatible host. Both derive
   repositories from the current installed-app inventory without starting a chat.
2. See those repositories and their associated apps automatically. Use existing authorized GitHub
   connections for reads; connection setup or selection resolves access, not repository membership.
   The first PR adapter is GitHub.com; show unsupported or missing source metadata explicitly.
3. See open PRs, including drafts, across the installed applications' repositories. Active means open or draft;
   merged/closed items leave the active list after a verified observation. Existing open PRs appear
   on the first successful scan, including Dependabot PRs that have no Hosty references.
4. Filter the view by associated app, repository, author/bot, draft state, CI or review/attention state. Search title
   or number; scope identical numbers to their repository. Preserve filters and selected PR through
   refresh. Show counts only with their coverage/completeness meaning.
5. On the full page, select a PR to inspect its description, author, repository, branches/current
   head, PR and review status, detailed CI checks, discussion summary and exact-revision diff where
   supported, plus its verified GitHub URL. Show authorized workspace, analysis, routine-run and
   decision links when available. Selecting a compact-panel row opens this full detail destination;
   the side panel itself retains only the list.
6. Refresh explicitly or receive shared updates while viewing. Show last successful observation,
   refreshing, stale, partial, inaccessible and retry states. One failing repository must not erase
   the other repositories or be presented as an empty successful result.

The two surfaces share the data model, authorized observation cache and status presentation, while
their information density differs. The full page contains the list and detailed selected PR, including
its description rendered as safe Markdown with loading/unavailable/truncated states. Read description
and discussion metadata through the supported provider API; the existing workspace summary alone
is not evidence that those fields are already supplied. A description can change without a new head,
so its observation revision must not be inferred solely from the commit SHA.

The side panel shows only compact PR rows: title/number, repository, author/state and a small
CI summary such as passed/total, failed and running/pending counts. Keep skipped and unknown results
distinct from passed or failed. Reuse the collapsed workspace PR card's visual language and status
helpers, without copying its expandable details into the new panel or changing the workspace view.
A row opens the corresponding full-page detail through supported app-owned navigation; preserve
selection/scroll and the host's unrelated conversation or document. No chat is required.

On a narrow full-page layout, navigate between list and detail while retaining state. Keep keyboard
navigation, accessible status labels and readable summaries; color alone does not explain status.
Render provider text as untrusted content. Opening, filtering or refreshing performs no inference.

## Installed Application Repositories, Identity And Access

The source of membership is Core's current installed application records and their reviewed source
repository metadata, not a per-user list in Harness. Include installed running, stopped and failed
apps alike. No development workspace, downloaded checkout or source runtime is required. Resolve
the canonical remote repository through supported source metadata/provider resolution; do not infer
it from a container image, Marketplace listing, dependency, arbitrary local remote or a preferred fork.
Missing, local-only without a supported remote, inaccessible and unsupported sources remain explicit
coverage states rather than invented GitHub identities or successful empty PR lists.

A derived entry records provider/host, canonical repository identity, current display name/URL and
the installed app/installation references that caused inclusion. Authorized connection/cache state
and per-user display filters are separate. The set of installed apps visible under current authority
must not disclose another user's private repository metadata or credentials.

Several apps in a monorepo produce one repository entry, scan and PR row. Preserve all authorized
app associations as labels/filter context. Different source branches, pins and app subpaths do not
duplicate the repository. Show repository-wide open PRs; an app association does not claim that a PR
changes that app, and app subpaths must not silently hide unrelated-file PRs in the same repository.
A PR reference adds its number/provider identity, with head/base and observation revisions separate.

Reconcile membership when apps are installed, uninstalled or their reviewed source repository changes.
Installing an app adds its source repository as a candidate automatically, with tracking subject to access. Removing one of several apps retains the
shared repository; removing the final association removes it from this inbox. A supported source change
updates the mapping without changing app source settings from the PR panel. Runtime start/stop and
temporary workspace activation do not create a new repository selection. Preserve provider identity
across verified renames and reconcile transfers explicitly.

Owner decision, 2026-10-29: reuse Core's existing personal GitHub connections and selection rules.
Do not introduce a shared host GitHub account, a second login flow or a new credential store. Shell
manages connections; Harness consumes authorized selections and Core performs provider requests.
At this baseline those source/PR flows require the current administrator and existing app/source
authority. This feature does not implicitly expand them to ordinary-user source administration.

The inspected existing paths are specific:

- A registered publication persists the selected owner's `ConnectionId`; subsequent observation uses
  it through `UserConnectionService.UseForSourceAsync`, which checks ownership and renews expiring
  OAuth credentials inside Core.
- External workspace references use the reviewed workspace/app Git-source binding when present.
  Otherwise they require exactly one connected matching provider account belonging to that owner.
  No match yields `connection_required`; multiple matches yield `connection_ambiguous`, with selection
  resolved through existing source settings. They do not try another user's account or pick at random.
- Existing PR API reads require a connection even for a public GitHub repository. Public installation
  and anonymous Git reads are separate capabilities. This version reuses the authenticated PR path;
  it adds no anonymous PR polling mode.

See [source providers](../source-providers/feature.md),
[personal connections](../user-profile-connections/feature.md),
[private source bindings](../private-app-sources/feature.md),
[publication connection use](../../../apps/core/src/Haas.Hosty.Core/PublicationService.cs),
[external-reference selection](../../../apps/core/src/Haas.Hosty.Core/PublicationExternalReferences.cs)
and [credential execution](../../../apps/core/src/Haas.Hosty.Core/UserConnectionService.cs).

Apply the same owner/binding and unambiguous-selection rules to installed-app repository reads.
A connected account is only a candidate credential; provider reads still need to establish current
repository and PR access. Observe and include only that accessible subset in the main list and
repository filters. Do not enumerate unrelated repositories visible to the account. A missing,
expired, ambiguous or denied connection blocks tracking for the affected candidate rather than
producing fake empty/green results or borrowing a credential. Stop protected reads after confirmed
access loss and resume only after valid selection/access recovery; avoid repeated failing requests.
Distinguish authority failures from temporary provider outages/rate limits, which can retain permitted
cached rows with stale/error labels and bounded retry.

Known source URLs or local files can remain after disconnection or app installation from an artifact.
Those facts do not establish GitHub API access. A separate coverage/setup notice may explain that
some installed-app sources cannot be observed, using only metadata the viewer is already authorized
to see. Exclude inaccessible PR content and never expose another user's private repository details.
If no usable connection exists, show the supported connection-setup destination rather than claiming
there are no open PRs. No downloaded checkout is required for an otherwise accessible repository.

Harness's browser and model never receive GitHub credentials. The technical decisions below define repository read/demand
APIs and integration with these selection boundaries and the Core scheduler/cache. Reuse
provider implementation, keeping Core-facing additions usable by unrelated authorized applications.
Connection selection resolves access for derived candidates; it is not an Add repository flow.

Check current app/user/connection/repository access on reads and subscriptions, including cached
details and background delivery. Installation identifies what to observe; it grants no new GitHub
access, private transcript visibility, mutation rights or unattended execution. On access loss, stop
returning protected cached content and retain only permitted unavailable-state metadata. Keep the
actual supported Harness user boundary; ordinary-user execution/isolation remains separately owned.

Removing a repository from the derived set does not close its PRs, delete workspaces or imply that
remote PRs disappeared. Optional routine subscriptions that consume installed-app scope must reconcile
membership and current authority through their owners; previously accepted work keeps its documented
recovery/cancellation policy. Other independently authorized consumers retain their own scope. View
filters never enroll/untrack repositories or create a separate monitoring allowlist.

## Current Workspace PR Refresh Baseline

Inspected source at the baseline above implements two separate stages:

- Core's `PublicationObserver` performs an initial observation cycle and then uses a 30-second timer
  for eligible registered publications and linked external PR references. It calls the GitHub provider
  with the selected authorized connection; this path uses polling, not incoming GitHub webhooks.
  Background observation is limited to active, non-closed workspace workflows; pause/closure and
  revoked source/connection authority prevent ordinary background observation. It does not require
  an open browser or an agent turn. External references have a shared batch budget of up to ten
  references and ten seconds per cycle with rotation, so the timer is not a per-PR freshness guarantee.
- Saving publication evidence advances the workspace publication generation and publishes a
  `workspace.changed` hint without scheduling another Git scan. Harness receives the Core event
  stream on its backend and bridges it to the browser over an authenticated WebSocket. The browser
  shares a workspace stream within the app/tab, coalesces notifications, reloads inventory and reads
  details when that workspace's relevant version changes. It also reconciles on reconnect/visibility
  recovery and supports explicit refresh. The 30-second `now` timer in workspace details only ages
  visible freshness labels; it is not another GitHub polling loop.

Relevant source: [publication observer](../../../apps/core/src/Haas.Hosty.Core/PublicationService.cs),
[external reference budget](../../../apps/core/src/Haas.Hosty.Core/PublicationExternalReferences.cs),
[publication invalidation](../../../apps/core/src/Haas.Hosty.Core/WorkspaceObservationState.cs),
[shared UI subscription](../../../apps/harness/web/src/lib/workspace-events.ts),
[browser stream transport](../../../apps/harness/web/src/lib/event-stream.ts) and
[workspace PR presentation](../../../apps/harness/web/src/components/workspace-pull-request.tsx).
These observations describe existing workspace PRs, not the unbuilt repository-wide inbox.

## Observation And Freshness

Core owns the shared PR observation scheduler and cache, reusing its existing provider/connection
boundaries. Use one authorized observation path for repository lists, PR details, existing workspace
references and optional consumers where their scopes permit reuse. Harness declares demand through
a supported app-neutral contract; it does not run another GitHub poller. The technical decisions below fix the API,
cache keys and integration with existing observers. Repository lists and detail/check/diff reads have
separate bounded demand within that shared scheduler.

Handle pagination and request failures explicitly. An incomplete scan cannot prove that a PR closed
or disappeared. Confirm state changes with authoritative reads or a complete defined snapshot before
removing an item. A failed detail/check request does not become green CI or an empty review list.
Expose unknown/missing/skipped checks distinctly; aggregate green CI is not a statement that merge
requirements, business review or change safety are satisfied.

Reuse Harness's existing live-update delivery pattern for active UI consumers, with initial loading
and reconciliation on reconnect/visibility recovery. The current Core-to-Harness stream is SSE and
the Harness-to-browser bridge is WebSocket; avoid adding a competing transport or a GitHub poller
per surface. Share subscriptions and preserve selected PR/filter state. An ephemeral update can
refresh the view; it is not evidence of durable event delivery to automation.

### Selected Adaptive Polling Policy

Owner decision, 2026-10-29: use adaptive polling with a shared cache for this version. Do not add a
GitHub webhook receiver, relay, tunnel or webhook registration. The initial cadence defaults below
apply to backend observation; UI delivery continues to use the existing push pattern. The owner's
latest refinement uses live authorized event-stream subscriptions as consumer demand: while relevant
subscriptions exist, discover PRs on a minute cadence and refresh actively changing PRs faster.
When none remain, both discovery and per-PR observation return to the five-minute baseline.

| Authorized demand | Initial target cadence | Scope |
| --- | --- | --- |
| Repository discovery with relevant live subscriptions | 1 minute | Check accessible installed-app repositories covered by live PR subscriptions and reconcile list membership. Do not reload all checks or diffs in every scan. |
| Known PR with active work and a live scoped subscription | 10 seconds | Refresh mutable state, head and CI/check summary for queued/running/pending checks or another explicitly represented transition a consumer is awaiting. |
| Known PR with a live scoped subscription but no active work | 1 minute | Revalidate its mutable summary/check state without keeping the fast tier solely because the PR is visible. |
| Repository or PR without relevant live subscriptions | No more often than once every 5 minutes | Perform bounded baseline discovery and PR-state reconciliation only where current background read authority remains valid, even if CI is still running. No authorized access means no provider read. |

These are initial policy defaults, not freshness guarantees. The technical decisions below fix
activity predicates, capacity, the one-minute quiet tier and recovery. Limits, provider latency and
failures can lengthen intervals. Keep cadence in one tested policy object without adding settings UI.
No relevant subscriber means the five-minute baseline also applies to discovery.

Count subscriptions to the requested repositories/PRs, not every SSE connection to Core or every
socket in Harness. One shared stream may carry several scoped subscriptions. Dashboard/chat traffic,
transport keep-alives and a stored workspace PR reference do not imply PR demand. A PR subscription
also identifies its repository so discovery cadence can follow the same scoped demand.

A consumer may be the PR page, compact panel, workspace PR card or an authorized backend watcher
holding a live scoped event subscription. A compact row needs current CI just as a full detail page
does. Declare only the summaries the view consumes; opening any list must not promote every open PR.
The owner calls this SSE demand; preserve the current Core SSE and Harness browser WebSocket bridge
instead of requiring a new browser transport. The backend must propagate subscription lifetime and
scope faithfully through that bridge. A workspace watch is internal demand, not an external webhook.

Observe a newly discovered or newly demanded PR as needed to establish activity within the same shared
budget; unknown CI must not be treated as completed. Detect a new head or a check rerun and promote
the PR when a consumer exists. A completed/cancelled CI run releases the fast tier if no other observed
transition remains active. An unchanged list response cannot establish that a completed check has not
been rerun; retain the quiet per-PR revalidation path. Open/draft status alone is not active work.

Merge overlapping demand by canonical resource and compatible authorization scope. The strongest
current demand and observed activity determine cadence, with one in-flight read per representation and
shared results for entitled consumers. A fast refresh also updates its cached list row where appropriate;
an additional tab or panel must not add a second provider poll. Integrate existing workspace publication
and external-reference observation into this scheduling path rather than retaining a separate fixed
30-second loop alongside it. Preserve their workflow eligibility, authority and publication/cleanup
semantics. This plan changes no live timers before implementation.

Bind demand lifetime to the authorized stream subscription. Unsubscribe on navigation away or
hiding; explicit stream closure releases demand, while bounded liveness timeout handles half-open
connections and crashed bridges. Removing one subscription from a multiplexed stream must release
that resource's demand even when the underlying connection remains open for other features. The
stream-scoping and reconnect decisions below bound this lifetime; no independent permanent fast-watch
flag is inferred from a workspace record.

Serve permitted cached state on entry, then revalidate when due; reconnect and explicit refresh
coalesce with pending work. After the last relevant subscription closes or times out, return to the
five-minute baseline for that scope. A backend consumer can keep a subscription alive with UI panels
closed, but paused/completed work must release it; without any live subscription it gains no fast tier.
Installed-app membership starts neither a model turn nor a routine and does not persist a bearer
session token. Background reads use existing durable connection/source authority.

Use conditional requests where the provider supports them, retaining ETag/Last-Modified validators
per request representation and authorization scope. Treat unchanged list data separately from CI:
a list's unchanged response does not establish that check runs are unchanged. Cache PR state/check
summaries separately from descriptions and revision-specific diffs; the 10-second tier is not a full
description/comment/diff download every time. Description edits without a new head must still become
visible through their own revalidation. Cache lifetimes and capacity limits are fixed below.

Apply a shared request budget for the actual provider rate-limit bucket, across discovery, summaries,
workspace observation and manual refresh. Prioritize actively changing PRs with consumers while
reserving capacity for list discovery and eventual background convergence; bound concurrent work
and spread scheduled requests.
Respect provider retry/reset guidance, back off on failures or low remaining budget, and stop protected
reads on authority loss. Even unchanged conditional reads are not an unlimited request allowance.
When the target cadence cannot be met, preserve last successful data with explicit age and delayed,
partial or error state. Never report a failed scan as an empty list or a failed check read as green CI.

Conditional-request and rate-limit handling follows the
[GitHub REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
The selected polling policy belongs to this PR observer; it does not constrain generic assistant events
to polling or require the durable-event/routine platform to implement this browsing feature.

## Technical Decisions (2026-10-29)

These decisions close D1. They describe the implementation contract, not shipped behavior. The owner
authorized completing the technical design and making this plan Ready, while explicitly withholding
implementation and commits. The numeric limits below are initial bounded defaults, not throughput SLAs.

### Core Read Contract And Authority

Add a repository-scoped PR read service under `/api/pull-requests`. Use the existing direct Core
administrator authorization and app-management identity/service-token pair. Register each app-facing
route in `AppManagementAuthorization` with `apps.sources.full`; retain current administrator,
installation, assignment and source/connection-owner checks. `apps.sources.read` currently means
documentation access and must not silently gain PR diff or private review access. No new permission,
GitHub login flow, user role, MCP command or SDK protocol is needed for this version.

Harness adds a bounded same-origin BFF for this route family using its existing verified app session.
It never forwards Core cookies, arbitrary provider URLs or caller-supplied user identity. Browser
responses use `Cache-Control: no-store`; caching belongs to Core. Direct authorized API clients and
an unrelated installed app with the same reviewed permission must work without Harness or Shell.

| Planned operation | Contract |
| --- | --- |
| `GET /api/pull-requests/repositories` | Accessible installed-app repository projections plus separately authorized coverage/setup states; no Git checkout or workspace-only enrollment. |
| `GET /api/pull-requests` | Cached open/draft summaries; bounded repository/app/author/bot/draft/CI/review/search filters, 50 rows by default, 100 maximum and opaque snapshot cursor. |
| `GET /api/pull-requests/{repositoryId}/{number}` | PR metadata and safe Markdown description; cached response with an observation receipt and queued refresh when due. |
| `GET .../{number}/checks` and `GET .../{number}/review` | Paged check details and read-only review/thread summary for the observed head; 100 items per page, explicit incomplete/unknown states. |
| `GET .../{number}/diff?head=...&base=...` | Bounded immutable comparison for server-verified current SHAs; reject a stale requested pair with `409 pr_changed`. |
| `POST /api/pull-requests/refresh` | Bounded repository/PR references and UUID request ID; return cached state and `queued`, `coalesced` or `deferred` with `nextAttemptAt`. Never bypass provider limits. |
| `POST /api/pull-requests/subscriptions` | Create a short-lived, actor/app-bound scope handle; this alone creates no fast demand. |
| `GET /api/pull-requests/events?subscriptionId=...` | Admit the handle once under the same actor/app, attach scoped demand for the lifetime of the SSE stream and send authorized invalidation hints. |

No route accepts arbitrary repository URLs. `repositoryId` is an opaque Core reference to an installed
candidate, mapped to provider/host plus provider repository ID after resolution. PR identity is that
repository identity plus number, with a provider PR ID retained where available. Head/base SHAs and
observation revision are separate. Validate current membership and access on each read; a stale URL
cannot re-enroll an uninstalled app. Verified repository renames update display URLs without changing
identity. Transfers require revalidation through the selected account; no credential follows an
unverified redirect. Several apps/branches/subpaths of the same repository produce one candidate.

Extract only the installed-app discovery/projection from `SourceDocumentService`; do not invoke its
Git fetch, branch resolution or mixed installed/workspace inventory to list PRs. Reconcile local
membership on app/source/connection changes and at most every 30 seconds as a recovery scan; this is
an in-memory/local-record check, not a GitHub poll. For each owner, reuse an exact current reviewed
source binding; otherwise use their sole connected matching account. Conflicting reviewed bindings
or multiple unbound accounts remain an explicit selection-needed state; do not fan out over accounts.

After an authorized inventory read, Core retains only owner/app-installation/resource/connection
references for baseline observation. Each scheduled read rechecks current administrator, app source
permission, source grant where required, installed membership and selected account. Browser logout
does not erase a valid source connection; it releases UI demand. Revoked permission, disabled owner,
removed last app association or disconnected account stops that registration. Tokens and browser
session grants are never copied into this registry. Workspace-only observations retain their own
existing authority and never enter the installed-app inbox merely by sharing the scheduler.

### Response And Provider Data

Every snapshot carries `schemaVersion: 1`, an opaque `revision`, `observedAt`, `lastSuccessAt`,
`nextAttemptAt`, `freshness` (`fresh`, `stale`, `refreshing`, `delayed`, `unavailable`), `completeness`
(`complete`, `partial`, `unknown`) and a sanitized optional error/reason. Completeness is separate
for membership, checks, review and diff. Counts distinguish loaded items from provider totals; unknown
is never zero. A partial scan cannot certify a PR closed. Confirm missing previously known PRs with
targeted state reads before removal, because provider list pagination is not a transactional snapshot.
Snapshot cursors expire after two minutes; an expired cursor requests a fresh first page, not a
continuation mixing generations. A PR that closes while selected remains readable with its final
state and provider link, while leaving the active list after verified closure.

Extend the existing GitHub adapter with workspace-independent read methods. Reuse transport ownership,
URL validation and observation parsing, but do not create a synthetic `PublicationRecord`/workspace.

- Discovery uses REST `GET /repos/{owner}/{repo}/pulls?state=open&sort=created&direction=desc&per_page=100`.
  Keep pagination parameters stable and retain validators per page. Store only bounded summary fields
  from list responses; do not expose every description in the aggregate payload.
- Use one compact GraphQL query for mutable PR state and current-head check rollup, including check
  identity/name/status/conclusion/URL, review decision and comment counts. Batch up to ten due PRs
  using parameterized aliases under the same owner/connection. Include rate-limit cost/remaining/reset;
  omit descriptions, review-thread bodies, artifacts and diff. GraphQL has its own budget and no REST
  ETag assumption. Partial field errors must not discard successful authorized PRs or imply green CI.
- Page check contexts in groups of 100, up to 500 per PR. Keep provider IDs and current-head context;
  do not deduplicate by display name alone. During pagination discard a generation if head changes;
  incomplete counts remain partial. Missing check permission leaves the PR visible with unknown CI.
- Description and review detail load on demand. Fetch description via the REST PR read; reuse fresh
  bounded body data already obtained during discovery when available. Review threads/comments are
  paged separately from fast status reads. Description edits revalidate independently of head SHA.
- Extract the existing SHA-based compare/read-only rendering path from `GitHubPublicationReview` for
  external PRs. Read server-authoritative head/base, compare immutable SHAs, then recheck them before
  presenting the result. Preserve the current refusal at 300 files, missing-patch handling and a
  verified GitHub link for unsupported/oversized previews. Never label a missing patch as certainly binary.

The present `PublicationObservation` lacks description/author and its query couples status with review
threads. The new DTO and compact query are required additions. The current `pull-request-checks.ts`
groups neutral/skipped with passed; the inbox gets explicit passed, failed, running, pending, skipped,
neutral, cancelled and unknown buckets. Reuse visual components through an adapter without changing
existing workspace completion/merge semantics. Show completed/known-total and passed separately; a
green rollup is not a merge authorization or proof that all required checks were discovered.

Provider facts and limits were checked against [PR REST reads](https://docs.github.com/en/rest/pulls/pulls),
[conditional reads](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api),
[GraphQL checks](https://docs.github.com/en/graphql/reference/checks) and
[GraphQL budgets](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

### Stream Scope And Liveness

Use one shared PR subscription per actor/app/browser tab, with the union of mounted visible consumers.
The subscription body is at most 32 KiB: up to 100 repository references and 100 PR references, or
`allInstalled: true` for discovery plus explicit PR references needing summary refresh. A selected
detail PR is included even when off-page. A workspace consumer may instead supply up to 50 existing
workspace references; resolve only their already registered PRs through current workspace authority.
This adapter permits existing workspace-only PR observation without adding them to the inbox scope.
Bound totals to 200 resolved PRs per stream; return a clear capacity error for excess demand.

Creating a scope returns a random opaque handle expiring in 30 seconds. Opening its SSE stream
requires the same current actor and caller installation and consumes the handle. Unopened handles
and closed streams create no demand. Limit admission to 32 streams and 64 pending handles per user,
256 streams per Core. Client scope changes debounce for 150 ms, close the old stream and reopen with
the updated union; shared cache/in-flight reads prevent duplicate provider work during handover.

Send `stream.ready` after registering demand and include a current revision; clients then read the
authorized snapshot. Coalesce `pull-requests.changed` hints for 250 ms, containing only affected
authorized IDs/revisions. Missing hints, reconnect or a dropped bounded queue trigger a full scoped
reload. These are disposable UI hints, with no durable replay guarantee or model execution.

Core emits a heartbeat every 15 seconds, revalidates authority before emission, bounds write/flush
to five seconds and ends each stream after 120 seconds. Normal expiry reconnects immediately with
a new handle and fresh authorization; transient failures back off from one to 30 seconds. This
fixed lifetime bounds stale demand even across a half-open bridge. Release demand in `finally` on
closure, timeout or revocation; hidden/deactivated views unsubscribe even if retained in the DOM.

Extend Harness `EventStreamTransport` with one allowlisted PR-stream target using the opaque handle;
reuse its single-use ticket, actor/origin checks, one-MiB buffer and existing WebSocket bridge. Its
25-second ping/pong interval detects a lost browser within about 50 seconds and aborts upstream.
The browser's 45-second no-frame watchdog and activity/visibility handling remain applicable.
Other workspace/chat/SSE connections do not count as PR demand. Backend consumers retain faster
observation only while their own authorized scoped stream is live. No new websocket protocol or
independent permanent watch flag is required.

### Activity, Budgets And Cache Limits

Use the selected 60/10/300-second policy with the quiet subscribed PR interval fixed at 60 seconds.
Fast activity means queued/requested/waiting/in-progress checks or pending commit statuses. A new
head or initially unknown CI gets a two-minute discovery window while subscribed; after that,
unknown/no-check state returns to quiet refresh. Waiting for a human review, draft/open state,
mergeability calculation and an already completed failure do not keep the fast tier. Actual provider
pending checks remain active, subject to budgets; completion/cancellation demotes them. Revalidation
of quiet PRs detects reruns on unchanged heads. Unsubscribed scopes use at least 300 seconds for
both discovery and individual state reads. Failed/partial refreshes retain the last success timestamp.

All PR observation, details, workspace display and manual-refresh reads enter one scheduler. Group
rate budgets by provider/host and verified provider account, with separate REST and GraphQL ledgers;
keep cache/access partitions by Hosty owner, selected connection and repository grant. Rotating a
token does not create a fresh budget; sharing a provider account never exposes another owner's data.
Use one concurrent request per provider account, at least two seconds between request starts and
at most four concurrent provider reads per Core. Initial automatic-read caps are 2,000 charged REST
requests/hour and 2,000 GraphQL points/hour per account, or the provider's lower allowance. All HTTP
attempts, including unchanged conditional reads, count toward the 30-starts/minute pacing limit.

Reserve 20% of the provider-reported remaining-window limit for other work: when remaining falls
below that floor, defer automatic observation until reset. Reconcile every response's headers/cost;
respect `Retry-After`, reset time and any larger provider poll interval. Without explicit retry timing,
secondary-limit backoff starts at 60 seconds and doubles to 15 minutes. Network/server failures use
15/30/60-second backoff up to five minutes. Confirmed credential/access failure suspends the affected
scope; connection/grant change, explicit retry or a bounded 15-minute access recheck can recover it.
An unusable/disconnected credential never triggers remote rechecks. Manual refresh has a ten-second
per-resource cooldown and uses the same queue/budgets; duplicate UUIDs coalesce for five minutes.

Within available capacity use weighted round-robin slots: three for active subscribed PRs, one for
discovery, one for quiet/baseline reads; unused slots can be borrowed. Age queued work to avoid
starvation. Demand selects target cadence, not guaranteed capacity; positive jitter of up to 10%
spreads due work without beating the idle minimum. Delayed responses expose `nextAttemptAt` and
reason. No per-agent, per-workspace or per-panel provider loop may bypass these controls.

| Resource | Initial bound / retention |
| --- | --- |
| Installed candidates | Evaluate all local installed records; admit at most 100 accessible distinct repositories per owner for provider observation. Excess is explicitly capacity-limited, with no false complete count. |
| Open PR inventory | Up to 1,000 PRs/repository and 10,000/owner; rotate provider pagination in at most two pages per repository per scheduling pass. Preserve partial coverage when limits are reached. |
| Summary cache | Persist latest bounded normalized summaries and validators in owner-only Core cache storage, at most 32 MiB/owner. No credentials or source worktrees. Restart revalidates authority and resumes baseline before any stream promotes demand. |
| Cached access proof | Recheck remote repository visibility at least every five minutes while serving cache; successful repository/PR reads renew proof. Expired proof hides protected bytes until revalidated. Local grant checks apply on every read and emission. |
| PR descriptions/review | 256 KiB description; 100 review items/page, 500 items/PR, explicit truncation. Revalidate on entry when older than 60 seconds and every 60 seconds while that detail view is subscribed. |
| Diff | Existing 4 MiB provider-response ceiling and fewer than 300 files. Immutable SHA-pair cache; missing/oversized previews link to GitHub. |
| Detail/diff cache | Memory LRU, 64 MiB/owner and 256 MiB/Core, idle eviction after 30 minutes; authority checked before serving. Never pin an obsolete head as current. |
| Closure/removal | Closed PR summaries retained up to 24 hours for a currently selected detail, then evicted. Last app association removal or confirmed access loss evicts inbox data immediately; independent workspace records retain their own policy. |

No interval/limit settings UI is added. Keep these defaults in one tested policy object so later tuning
does not fork behavior. Report capacity limits explicitly rather than selecting arbitrary extra accounts
or making the user maintain a repository allowlist.

### Existing Workspace Integration And Future Inputs

Replace provider polling inside `PublicationObserver` with registration of eligible publication and
external-reference jobs in the common scheduler. Existing workspace reads receive compatible display
projections and publication-generation invalidation. Preserve pause/closure, owner and connection
checks; visible workspace PR cards register scoped stream demand through the same consumer adapter.
Do not require installed-app membership for an already authorized workspace's own PR observation.

Compact inbox evidence is display-only. It must never set `PublicationObservation.Complete`, satisfy
merge policy or authorize cleanup. A detected merged state or pending cleanup/release verification
queues the existing full publication verifier under its own authority and budget. Explicit publication,
merge and review mutations still take fresh authoritative checks through their existing commands.
Separate the provider-read cadence from local lifecycle bookkeeping: lowering UI demand must neither
cancel an authorized completion workflow nor release source based on incomplete compact evidence.

Keep observation scheduling separate from receipt of a change signal. Define an internal bounded
`invalidate(repository, optionalPr, reason)` input that only coalesces a due read for a known authorized
resource; neither the UI nor a producer may supply arbitrary fetch URLs or a trusted snapshot. Polling
is the only producer implemented by this feature. D6 verifies this boundary with synthetic signals.

Owner addition, 2026-10-29: retain webhooks as a possible later alternative for production instances
with public origins. A future provider-owned receiver can validate a configured endpoint and GitHub
signature, deduplicate delivery IDs and feed the same invalidation input. Public reachability does
not grant repository webhook administration. Out-of-order/duplicate deliveries must converge by
reading current provider state; initial scans, reconnect reconciliation and a low-frequency polling
fallback remain necessary. Keep callback registration/secrets, delivery storage and receiver lifecycle
out of this version; [I18](../../ideas.md#i18-active-pull-request-inbox-and-repository-observation)
retains that possibility until a separate implementation plan is selected. No relay, tunnel or
webhook HTTP endpoint is added now, and the UI does not depend on the observation input mode.
The later receiver must follow GitHub's [delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [failed-delivery recovery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
contracts; a public origin alone is not a complete delivery/recovery design.

### Page, Panel And Optional Context

Declare Harness navigation label `Pull requests` at `/pull-requests`, and panel ID `pull-requests`
at `/pull-requests-panel`, both on its existing HTTP endpoint. The full page uses query parameters
`repo=<opaque-id>&pr=<positive-number>` for selected details, allowing SDK main navigation to keep
the declared route intact. Add the entry to Harness's custom navigation as well as its manifest.
Use a split list/detail view above the existing 900-pixel responsive breakpoint and stacked navigation
below it. Initial sort is provider `updatedAt` descending, then repository/number for stable ties.
Preserve selection, keyboard focus and scroll anchors across resorting and updates.

The compact panel shows 30 rows per page, with repository, author/state, title/number and compact
CI counts. Installed-app associations remain available through filters instead of row labels. It never embeds the full description/diff. Full-page lists use 50 rows. Save filters/sort
per Core, owner and installation; query parameters override saved display preferences. Do not persist
private descriptions/diffs in browser storage. The visible page's PR references, plus selected detail,
form summary demand; filtered-out and off-page rows are not automatically fast consumers.

Panel selection uses `ui.navigate(entryKey, { placement: "main", search, requestId })` with the runtime
navigation entry key and currently bound app installation. The host keeps the source panel and any
unrelated conversation mounted. If main navigation is unsupported, show the validated separate-open
link; do not navigate the compact frame into the full page. Reuse existing SDK APIs without modifying
Core to recognize a Harness ID/route or changing SDK contracts. Existing workspace review routes remain.

Optional context v1 is a bounded PR reference (`schemaVersion`, provider/host/repository ID, PR number,
verified URL, head and observation revision) plus authorized related links. Only existing verified
workspace relationships are populated initially; analysis/routine/decision links are absent unless
their owner exposes a supported authorized reference. No private-store scraping, invented links or
new runner is included. The schema uses optional opaque domain revision when carried by general
events; non-PR event fixtures must not require GitHub fields. Existing draft-discussion handoff may
be reused without auto-send, but adding a new assistant action is not required for this browsing UI.

### Verification And Release Decisions

Use deterministic Core provider fixtures for discovery pagination, compact GraphQL partial errors,
ETags, rate headers, access denial, new heads/reruns, large reviews/diffs and fake-clock scheduling.
Add contract tests for the proposed route family and subscription lifecycle, including a third-party
app ID, absent standard apps, two owners and same-account credentials with isolated caches. Extend
Harness event-transport/UI tests for selection, page/panel composition, scoped disconnect and limits.
Keep existing publication/cleanup/review and source-connection regression suites passing.

Implement a reproducible `pull-requests` integration suite in the existing managed integration runner
as part of D7; it does not exist at this baseline. Use a child Core with Docker Harness and Shell,
normal setup/login and separate users/data. A test-only injected provider adapter supplies two
installed repositories (including a shared monorepo), a stopped app, missing source, inaccessible
source, human/Dependabot/draft PRs, live CI transitions and a workspace-only PR excluded from the inbox.
It must not add a production unauthenticated fixture API. Verify the HTTP contract with an independent
client and page/panel placement through Core/Shell and standalone URLs; close all subscribers and
advance the controlled clock to verify the five-minute baseline and eventual recovery.

Before implementation completion run affected Core unit/HTTP tests and build, Harness `npm test`,
Harness and web lint/build, the new `npm run test:integration -- pull-requests`, and the existing
`sessions` integration suite for publication/workspace regressions. Run Core AOT and version/docs
checks before publication. Use `harness-local` when its runtime startup/transport wiring is changed.
Record exact commands/platforms/results rather than treating fixture UI as proof of live GitHub.

One bounded real GitHub read with a consenting test account verifies current provider shapes against
installed test repositories; private denial and failure scenarios stay deterministic. Fresh consent
in the child Core is a verification prerequisite, not permission to copy production credentials or
create/merge PRs. If that prerequisite is unavailable, report the gap and keep D7 incomplete. Export
sanitized evidence and Finish the sandbox through its owner, confirming resource removal.

Implementation ships one feature PR with a Core/platform minor and Harness minor bump from their
then-current versions. No SDK or Shell implementation change is required by this design; ordinary
manifest navigation is consumed by existing hosts. If an actual integration defect needs their code
changed, apply their normal artifact version policy and document the deviation. The implementation changes Core/platform 0.163.0 to 0.164.0 and Harness 0.80.0 to 0.81.0.
The owner continues to prohibit commits. Isolated managed acceptance does not authorize a live-data trial.

## Details, Related Work And Mutation Boundary

Reuse review presentation and provider access where their contracts fit. A PR with no Hosty workspace
must still have useful details and a provider link. A supported repository-level read path can supply
an exact-head diff without allocating a worktree; do not fabricate a workspace link to satisfy an
existing route. Bound diff size, report truncated/binary/unavailable files and re-fetch on head changes.
Do not attach old review coordinates or summaries to a new head silently.

Related work is optional and explicitly correlated by provider/repository/PR/head where relevant.
Only expose sessions, run summaries, artifacts and decision records the current user can access.
Use supported links or adapters with an unavailable state when a capability is absent; the inbox
does not read other applications' private stores or copy their chat transcripts.

### Approved Manual Actions And Shared Presentation

On 2026-10-30 the owner approved Merge and Update branch buttons and auto-merge status display,
plus the workspace card's compact presentation and segmented CI bar across inbox surfaces.
This explicit scope amendment is approved for implementation without commits or real GitHub writes.
It supersedes the original read-only UI constraint only for these two user-initiated commands.

- Merge uses a regular merge commit, an explicit expected head, GitHub's current readiness and
  write permission, and the asynchronous REST merge contract with rule bypass disabled. No squash,
  rebase, administrator override, automatic retry, or implicit merge-queue enrollment is offered.
  A repository that disallows merge commits gets a disabled action and an explanation.
- Update branch merges the base branch into the PR branch using expected_head_sha. It is separate
  from Merge: GitHub acceptance does not mean completion, and new commits need fresh CI evidence.
- Show enabled/disabled/unavailable auto-merge status from GitHub. Enabling/cancelling auto-merge,
  merge queues, unattended execution, and review submission are outside this approved first stage.
- Core resolves installed-source and personal-connection authority itself, refreshes remote facts
  before sending, and revalidates local authority after pacing. Browser input cannot choose a URL,
  connection, merge method or bypass option. Both commands bind to the displayed head and base.
- Persist bounded owner-scoped request receipts before remote writes. Reusing a UUID with different
  input is rejected. Recovery of a dispatched/uncertain request only observes its result; it never
  resubmits the mutation. Unknown/pending outcomes remain explicit and are not shown as success.
- Use the existing source-management permission and administrator/CSRF boundary. Successful or
  uncertain dispatch invalidates detail/status caches and publishes ordinary observation updates.
- Share the compact row content with workspace cards. Inbox rows have no disclosure control or
  app-name list; active rows show their author, merged rows show Merged. App associations still
  drive membership and filters. Keep accessible CI counts and partial/unknown states.
- Share segmented CI presentation with workspace details, preserving skipped, unknown, partial and
  stale evidence. Clicking the inbox summary opens its Checks tab.

Provider contract: [GitHub pull request REST API](https://docs.github.com/en/rest/pulls/pulls).
Verification uses isolated HTTP fixtures and the managed test Core. No real PR merge, branch update,
credential copying or live-Core restart is authorized by implementing these controls.

## General Events, Routines And Decisions

PR observations are one domain source of facts. The general event contract must also fit game moves,
application job completion and decision responses without GitHub or PR concepts. Generic envelopes
carry authenticated source, versioned event type, subject/resource reference, opaque revision where
applicable, event identity and correlation; adapters own domain fields such as head SHA and CI state.
No common subscription requires a repository, PR number, Dependabot author or live conversation.

| Owning feature | Boundary with this inbox |
| --- | --- |
| [Notifications D6](../notifications/plan.md#deliverables) | Owns shared durable delivery, authorization, retention and replay. This view does not depend on it for reads or UI freshness. |
| [Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) | Owns authorized event input, conversation binding and receipt interpretation. A PR source supplies facts, not arbitrary private conversation IDs or model instructions. |
| [Durable Agent Jobs](../durable-agent-jobs/plan.md) | Owns configured routines, event-triggered job/session creation, budgets and recovery. A PR filter is one consumer policy, not a hard-coded Core wakeup rule. |
| [Shared Decisions](../shared-decisions/plan.md) | Owns addressed questions, answers and material revisions. The panel can link to a relevant decision; it does not introduce a second approval store. |
| [Harness Work Orchestration](../harness-work-orchestration/plan.md) | Owns joined work/decision presentation and richer delegation; the inbox supplies an independent PR entry point. |
| [Assistant PR Lifecycle](../assistant-pr-lifecycle/feature.md) | Owns existing workspace publication/merge operations and their evidence. Repository discovery and this aggregate view are the new scope here. |

D6 below defines the PR-facing identity/reference and optional observation projection for these
consumers, including capability-absent behavior. It does not implement the durable bus, live event
publication, routine execution, a Decisions UI or automatic merge. If PRs are later selected as the
first live event producer, scope that producer/outbox integration explicitly with these owners before
implementation. Do not make the whole PR panel or GitHub availability a prerequisite for generic events.

The Dependabot example remains useful for design: detect a verified author, wait for required checks,
review the exact head, then report, ask a decision or act under a configured policy. A new head
invalidates old analysis/approval; duplicate observations must not create duplicate work. The first
scan, including a repository newly added by app installation, displays existing PRs. Automation
backfill is a separate explicit policy, not a side effect of installing an app or opening this view. Waiting for CI or a human must not repeatedly call the model.

## Deliverables

- [x] D1. Resolve the installed-app/access projection, Core read API, connection rules, scoped stream lifecycle, provider reads, activity predicates, cache/budget limits, page/panel navigation, optional context and webhook extension boundary; verify these decisions against baseline code and primary provider documentation, define acceptance, and record the owner-authorized Ready state without starting implementation.
- [x] D2. Implement automatic repository derivation from installed applications and the supported repository-level read contract through existing connection boundaries; cover shared monorepos, install/uninstall/source changes, stopped apps, missing/unsupported sources, pagination, rename/access loss and safe cached reads without a repository picker or new workspaces/conversations.
- [x] D3. Implement the shared Core scheduler/cache with stream-scoped demand: 1-minute discovery, 10-second active PR refresh and 1-minute quiet PR refresh while relevant subscriptions exist, otherwise baseline discovery/PR reads no more often than 5 minutes; handle stream close/timeout, activity transitions, conditional reads and budgets, integrate workspace observation without duplicate loops or eligibility/cleanup regressions, and verify errors, manual refresh, backoff and reconnect. Observation alone must not start model work.
- [x] D4. Implement the dedicated navigation page with active open/draft list, filters/search and selected PR description, metadata, detailed status/check/review/diff presentation with provider links and exact revision handling; include Dependabot and external PRs with no workspace/task/session association, accessible status text and useful incomplete/unavailable states.
- [x] D5. Add the separate declared list-only side panel with compact rows and CI counts following the workspace PR summary conventions; share data/status logic with the full page, open the selected PR in that page through existing SDK navigation, preserve selection and responsive/keyboard behavior, and verify normal authentication, embedding and installation changes without requiring a conversation.
- [x] D6. Implement and verify the specified versioned PR reference/observation projection, supported workspace-link adapter and bounded invalidation input shared by observation producers; test duplicate synthetic signals, absent routine/decision capabilities and a non-PR reference example. Keep webhook receiver/registration, durable event publication, execution and decision storage outside this feature.
- [ ] D7. Add the specified managed pull-requests integration suite and verify the complete read-only journey, scoped-stream/budget/recovery matrix, real authorized GitHub reads and representative fixtures; cover cross-user denial, revoked connections, partial scans, changed heads, existing workspace lifecycle and optional capabilities absent, exercise an independent API consumer and record checks/results and sandbox cleanup.
- [ ] D8. Document shipped behavior, supported surfaces/provider limits and recovery in feature.md, reconcile linked plans and I18 without completing their remaining scope, apply only the changed artifacts' release versions, remove this plan on full completion and regenerate the index.
- [x] D9. Add head-bound manual Merge and Update branch contracts, fresh provider eligibility and auto-merge status, durable request recovery, cache invalidation and authorized Harness controls; verify stale heads, blocked/draft/conflicting PRs, denied writes, ambiguous delivery, replay and successful fixture actions.
- [x] D10. Unify inbox rows and detail CI presentation with workspace components, remove app labels from rows, preserve navigation/filters/accessibility, and verify both surfaces in the managed sandbox.

- [x] D11. Correct reviewed shared-detail authorization, background verifier pacing, partial-status retry/freshness and command-result recovery; verify dedicated regressions and the managed PR suite.

## Sequence And Readiness

D1 closes the technical design under the owner's explicit 2026-10-29 instruction to make the plan
Ready. There are no unresolved product or architecture questions for the scoped PR browsing feature.
The choices above supersede earlier tentative intervals, connection questions and placement options.
The owner authorized implementation and subsequently PR publication and merge. D2-D6 are verified; D7 retains the explicitly
deferred live GitHub read, and D8 retains final acceptance reconciliation and plan removal.

Keep D2-D10 on one feature branch/PR. Implement the Core read/inventory contract first, then shared
observation and workspace integration, page/detail/panel presentation, optional references and
invalidation boundary, managed acceptance and final documentation. Do not wait for the generic
event/routine platform or a webhook receiver. The source baseline must be reconciled when coding
starts; if an upstream change invalidates a decision, record the concrete deviation instead of
silently weakening authority, completeness or acceptance.

Consent for the live provider acceptance fixture is an execution prerequisite, not an unresolved
design choice. Fixtures do not authorize copying credentials or remote writes. Automatic merge,
general agent routines and webhook installation remain separately scoped work, with the webhook
possibility recorded in I18. Their implementation is not part of the remaining deliverables here.

## Verification

Documentation validation uses `node scripts/docs-index.mjs --fix`,
`node scripts/docs-index.mjs --check --base <integration-base>` and `git diff --check`, including
stable deliverable/idea identities and local links. The implementation also requires the runtime
verification below and the stated Core/platform and Harness version changes.

Implementation acceptance must include:

- At least two repositories derived from installed apps, including a shared monorepo, stopped app,
  human and Dependabot PRs, open/draft states and overlapping PR numbers. A PR needs no Hosty
  workspace/task/session. Opening creates no chat, task, worktree or inference call.
- Install an app, change its reviewed source, remove one shared-repository app, then remove the last
  association. Reconcile membership automatically without duplicate rows or treating removal as PR
  closure. Verify missing/unsupported source states and no added repositories from workspace-only,
  favorite, container-image or unrelated local-remote records. App/repository filters affect display only.
- Empty, initial-loading, partially scanned, stale, inaccessible and rate-limited states beside
  successful reads; pagination and repository rename/transfer. Incomplete scans never imply closure.
- Deterministic scheduler checks for minute discovery with live subscriptions, active-and-subscribed
  10-second PR refresh, quiet subscribed PR revalidation, and five-minute discovery/PR baseline without
  subscribers. Cover CI start/finish/cancel/rerun, new heads, unknown activity, active CI without demand,
  equivalent compact/workspace consumers, stream close/timeout, background subscriptions and paused/
  completed workspace release. An unrelated SSE stream or one remaining multiplexed connection must
  not keep unsubscribed resources fast. Verify deduplication and preserved publication cleanup.
- Connection selection with a reviewed binding, one eligible account, ambiguous accounts and no account;
  public installation without PR credentials, private-source metadata retained after access loss,
  an authorized repository without a local checkout, and temporary failure versus confirmed denial.
  Verify accessible-only PR lists, scoped coverage notices, recovery and no credential borrowing.
- Conditional cache hits, changed validators, CI changing while the PR list is unchanged, isolated
  authorization scopes and description edits without a head change. Verify bounded request counts,
  shared rate-limit exhaustion/backoff, manual refresh coalescing, overload fairness and delayed-state
  presentation; no test should assume every endpoint can meet its target under an exhausted budget.
- Head update during detail/diff reading, changed CI/review evidence, merged/closed disappearance,
  missing/skipped checks and oversized/binary diffs; stale data cannot become a fresh approval badge.
- Two users and connections, revocation during a cached read, changed installations and unauthorized
  related session/decision links. UI composition supplies no extra repository or conversation access.
- Dedicated navigation page and list-only side panel with normal Hosty login, narrow/keyboard use,
  compact CI counts, row-to-detail navigation, retained filters/selection and shared observers. Verify
  full description/status details on the page, no expanded details in the panel, description changes
  without a new head, disconnect/reconnect and no routine/event/decision features installed.
- Contract fixtures for optional PR references, duplicate/out-of-order invalidation signals and a
  non-PR domain event. Validate that common envelopes/routing require no GitHub fields and the UI
  consumes the same snapshot regardless of its observation input; fixtures do not prove a webhook
  receiver, live durable event delivery or auto-merge.
- A bounded real GitHub read using expressly authorized test repository access; private-access denial
  and provider failure fixtures separately. Do not create or merge real PRs merely to seed this read
  acceptance, or copy ordinary-host provider secrets into a test instance.
- Affected unit/contract/integration checks and builds in a registered workspace; actual identity and
  panel acceptance in a managed child Core with separate users/data. Record commands, results and
  any unavailable coverage, export useful sanitized evidence and Finish the sandbox through its owner.
  Apply Harness and any changed Core/SDK artifact version policy only when implementation ships.


## Implementation Verification (2026-10-29)

The owner authorized implementation without commits and subsequently explicitly left the real-GitHub
acceptance read open. Current behavior is documented in [feature.md](feature.md). No production
connection credentials were copied, no real PR was mutated, and no live Core/app was switched.

Verified on macOS arm64:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter
  'FullyQualifiedName~PullRequest|FullyQualifiedName~Publication|FullyQualifiedName~GitHub'`: 219 passed,
  including combined workspace/explicit scope bounds, workspace repository/target guards, current
  observation timestamps and shared backoff for GraphQL rate errors returned with HTTP 200.
- `npm run test --workspace @haas/hosty-harness`: 1,900 passed. An earlier isolated routing failure
  passed on the focused rerun and on the complete repeat. The subsequent affected UI run
  (`pull-requests.test.tsx`, `pull-requests-events.test.ts`, `pull-requests-api.test.ts`,
  `workspace-pull-request.test.tsx`) passed all 11 tests after the final UI changes.
- `npm run harness:lint` and `npm run harness:build-web` passed, including TypeScript. Web lint
  retains one pre-existing `tasks.tsx` effect-cleanup warning. Final managed acceptance also rebuilt
  the Harness API/worker and Shell images successfully.
- `npm run test:integration -- pull-requests` passed normal password/app identity, installed-source grouping,
  stopped apps, Dependabot, detail/check/review/diff, cross-user denial, a direct Core SSE consumer
  and immediate cache exclusion after disconnect. Parent Finish confirmed resource removal.
- Browser review verified both Shell surfaces, standalone details/checks/review/diff, search,
  keyboard selection and the 600-pixel list/detail return path. A separate Playwright browser
  completed normal password login through Core and clicked a Dependabot row inside the Shell
  panel: the exact PR opened in the main detail frame while the compact panel stayed mounted.
  This closes the nested-frame click gap encountered with the first browser tool. The temporary
  browser was closed; the managed fixture owner verified Finish and child resource removal.
- `npm run test:integration -- sessions` passed shared-workspace authority, retained dirty/sessionless source,
  lease-refusal recovery, verified-merge cleanup and deletion replay. Parent Finish confirmed removal.
- `npm run core:aot` passed after the final Core source edit: native osx-arm64 startup was ready
  in 1,046 ms, with no new trim/AOT warnings. Existing platform warnings remain unchanged.
- `node --test scripts/test-integration.test.mjs`: 14 passed. Version consistency, documentation
  index/link checks against `fee7bece4b6b50810c929a7ea6daee8e31c56664` and `git diff --check` passed.
- Linux/Windows runtime checks were not run on this macOS host. The full repository test matrix
  was not repeated; affected components and the existing workspace integration were verified.

D7 remains open for the real authorized GitHub read, explicitly deferred by the owner on 2026-10-29.
D8 retains final acceptance reconciliation and plan removal; neither this record nor local tests
claim that these remaining items are complete. No commits or publication were performed.


## Manual Actions And Presentation Verification (2026-10-30)

D9 and D10 are verified in the same registered workspace on macOS arm64. The owner approved
these changes without commits. The primary Core and its live Harness were not restarted or
rebuilt to apply this batch; their selected workspace does not imply that its latest code is running.

- Core regression command `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj
  --no-restore --filter 'FullyQualifiedName~PullRequest|FullyQualifiedName~Publication|FullyQualifiedName~GitHub'`
  passed 222 tests. After the final provider/recovery changes, the focused
  `--filter 'FullyQualifiedName~PullRequest'` run passed 42 tests. These cover fresh authority,
  expected head/base, draft/blocked/permission rejection, rate-limit rejection, asynchronous merge,
  branch-update ancestry, durable recovery and prevention of duplicate or conflicting writes.
- `npm run test --workspace @haas/hosty-harness` passed 1,904 tests. After the final compact-row
  and recovery changes, `../../node_modules/.bin/vitest run --configLoader native --no-cache
  --no-fsModuleCache pull-requests pull-request-actions workspace-pull-request pull-request-checks`
  from `apps/harness` passed 23 tests across seven files.
- Harness backend TypeScript and web `eslint --no-cache` plus `tsc --noEmit --incremental false`
  passed. The existing `tasks.tsx` effect-cleanup warning remains. The final Harness API Docker
  image rebuilt the production web export successfully; no primary-instance web output was replaced.
- `npm run core:aot` passed after the final Core edit, with native osx-arm64 readiness in 1,051 ms
  and no new trim/AOT warnings.
- `HOSTY_ACCEPTANCE_HOLD_UI=1 npm run test:integration -- pull-requests` passed the real Core/Harness
  HTTP path against an isolated fixture provider: actor-bound commands, accepted update, durable
  recovery, merge, replay, conflicting request denial, independent scoped SSE and connection
  revocation. These results do not establish live GitHub write behavior.
- Browser checks used normal password login through Core/Shell. The full page and compact panel
  share title/number, state icon, author and CI presentation without app-name lists. CI remains
  visible at the compact panel width; the segmented summary opens Checks. Panel selection opens
  the main detail frame while retaining the panel. A fixture branch update remained recoverable
  after browser reload and an in-place test Harness update; recovery observed the new head and
  completed CI. Explicit merge confirmation then merged that fixture and removed it from both
  active lists. No real GitHub PR was changed.
- The first browser hold expired after a browser-tool stall; its parent still confirmed child
  resource removal. A replacement isolated run completed all checks. The test Harness update
  preserved data and returned healthy API/worker services. The test browser was closed, Parent
  Finish confirmed resource removal, and the runner removed test processes, ports, credentials,
  fixture data, builds and snapshots. Neither temporary parent belongs to the primary Core's
  environment inventory.

D7 still requires the live GitHub read deliberately deferred by the owner; D8 still requires final
acceptance reconciliation and plan removal. No commits or publication were performed. The existing
platform 0.164.0 and Harness 0.81.0 pending feature versions cover this approved amendment.


### Embedded HTML Rendering Correction (2026-10-30)

The owner reported escaped Dependabot HTML in PR descriptions. The scoped rendering correction
uses the shared Markdown renderer with PR-only raw-HTML parsing followed by sanitization, native
release-note/commit disclosures and the existing link/image policy. Review bodies use the same
renderer; chat HTML remains escaped. No Core API or production Core behavior changed.

- From `apps/harness`, `../../node_modules/.bin/vitest run --configLoader native --no-cache
  --no-fsModuleCache markdown pull-requests` passed 44 tests across seven files, including compact
  HTML, Markdown inside disclosures, tables/tasks/code, incomplete HTML, malicious markup/URLs,
  inert remote images and unchanged chat escaping. The PR page test uses the actual renderer.
- Targeted web `eslint --no-cache` and full web `tsc --noEmit --incremental false` passed.
- `HOSTY_ACCEPTANCE_HOLD_UI=1 npm run test:integration -- pull-requests` rebuilt the production
  Harness web image and acceptance executable and passed the managed suite. Browser verification
  used normal test-account login through Core/Shell, mouse/Enter/Space disclosure toggling,
  formatted links/lists and a 700-pixel viewport with no description overflow. Fixture icon/access
  diagnostics and transient Shell postMessage warnings were observed; no Markdown rendering error
  was observed. The browser was closed and Parent Finish confirmed child resource removal;
  the runner removed test processes, ports, data and credentials.
- Version consistency, generated documentation/link checks against the existing integration base
  and `git diff --check` passed. The full Harness suite and Core AOT were not repeated for this
  frontend-only correction; their previous results above remain scoped to the earlier code.

The existing pending Harness feature version covers this correction. The primary instance's static
web output was not replaced and no live Core/app restart, real GitHub mutation or commit occurred.
D7 and D8 remain open for their previously recorded acceptance requirements.


### Browser API Traffic Correction (2026-10-30)

The owner reported high Core API activity with the PR page open. The inspected path refreshed
repositories, the PR list and selected details for every owner-wide observation hint, and also
performed redundant pre-connect reads when consumers were added or visibility was restored.
The browser now coalesces notification bursts into serialized refreshes with a five-second pause
following each completed background snapshot and one retained trailing read. Readiness reconciles
once; hidden/unmounted consumers cancel pending work. Explicit refresh remains immediate. Exact
head/base diffs are reused during unrelated observations. Core/GitHub polling policy is unchanged.

Verified in the registered workspace on macOS arm64:

- From `apps/harness`, `../../node_modules/.bin/vitest run --configLoader native --no-cache
  --no-fsModuleCache pull-requests workspace-pull-request` passed 19 tests across five files.
  New cases cover 120 notifications over a simulated minute, retained final state, slow responses
  without overlapping reads, hidden/unmounted cancellation, visibility/activity restoration and
  immutable diff reuse. Existing owner isolation and revoked-access checks remain passing.
- Targeted web `eslint --no-cache` and full `tsc --noEmit --incremental false` passed.
- `HOSTY_ACCEPTANCE_HOLD_UI=1 npm run test:integration -- pull-requests` passed with normal
  Core/Shell test-account authentication. The baseline Docker Harness was measured, then updated
  in place through its owning test Core after a successful `docker build -f apps/harness/Dockerfile
  -t hosty-harness-api-acceptance:local .`. Its API and worker returned healthy and fixture data
  remained available. The fixed page's manual Refresh action succeeded.
- A controlled browser sample injected 60 local change hints over 30 seconds into the existing
  test stream; all resulting HTTP reads went to the real isolated Core with its fixture provider.
  The baseline made 204 PR snapshot requests (68 repositories, 68 list, 68 selected detail); the
  fixed build made 18 (six of each). Natural fixture notifications continued during both samples.
  This is synthetic burst evidence for one test page, not a measurement of the owner's main Core
  or real GitHub traffic. A preliminary sample crossed the normal stream renewal; the recorded
  baseline was restarted with a fresh stream for a complete measurement window.
- The test browser was closed and Parent Finish confirmed child resource removal. The runner
  removed test processes, ports, credentials, fixture data and builds. Documentation/link,
  version-consistency and whitespace checks passed. Core production code did not change; Core AOT
  and the full Harness suite were not repeated for this scoped browser correction.

The pending Harness feature version is unchanged. No primary Core/app restart or web-output
replacement, real GitHub mutation, commit or publication occurred. D7 and D8 retain their previously
recorded open acceptance requirements.


## Review Corrections (2026-10-30)

The owner requested verification of four findings against the uncommitted `fee7bec` work. All four
are confirmed and corrected under D11:

- Coalesced detail waiters revalidate their own app installation, source permission and current
  source/account binding before receiving data. The initiating reader's authority does not authorize
  a waiting app. Cached descriptions also recheck after reading related workspace links.
- Background publication verification waits for account pacing after compact observations and
  between sequential release checks. It still obeys automatic budget reserves, provider backoff
  and cancellation.
- Missing aliases in a partial status response get a separate retry deadline. Their successful
  observation timestamp is not advanced; stale display survives until actual facts arrive. Requested
  and missing-inventory flags do not cause immediate retries or exclude other due PRs from service.
- A new Harness command clears the old result. Result display and recovery use the matching UUID;
  late availability snapshots cannot replace a newer command.

Focused Core regressions cover waiting-app revocation/reinstallation, partial-result retry fairness
for explicit and missing-inventory requests, paced release completion, cancellation and automatic
reserve protection. Harness regressions cover an old failed result followed by lost delivery, a
mismatched result and a late pending-command snapshot. The source review did not change PR policy,
connection selection, provider credentials or permissions.

Verified on macOS arm64 in the same registered workspace:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore
  --filter 'FullyQualifiedName~PullRequest|FullyQualifiedName~Publication|FullyQualifiedName~GitHub'`
  passed 237 tests, including seven new Core regression cases. Before the fixes, the waiting-app
  revocation/reinstallation and background-verifier pacing cases failed with the reported behavior.
- From `apps/harness`, `../../node_modules/.bin/vitest run --configLoader native --no-cache
  --no-fsModuleCache pull-request-actions pull-requests workspace-pull-request pull-request-checks`
  passed 32 tests in seven files. The old-failure/lost-response and mismatched-result regressions
  failed before the correction; all four new Harness recovery cases pass on the final candidate.
- `npm run harness:lint` passed type checks and ESLint with the existing unrelated `tasks.tsx`
  effect-cleanup warning. Core compilation retains existing unused-parameter/platform/analyzer
  warnings; none was introduced by these fixes.
- `npm run test:integration -- pull-requests` rebuilt Core, CLI, the acceptance executable and
  production Harness API/web/worker and Shell images. The managed fixture passed normal user/app
  authentication, installed-source discovery, detail/check/review/diff, scoped SSE, disconnect
  exclusion, manual actions, durable recovery and replay. Parent Finish confirmed child resource
  removal; the runner removed test processes, ports, fixture data and credentials.
- `npm run core:aot` passed native osx-arm64 compilation with no new trim/AOT warnings and startup
  readiness in 1,058 ms. Version consistency, documentation/index/link validation against `fee7bec`
  and `git diff --check` passed.

The full repository/platform matrix and another browser walkthrough were not repeated for these
scoped logic corrections; focused UI tests and the managed HTTP journey cover the changed behavior.
The explicitly deferred real GitHub read remains part of D7; this correction does not complete D7
or the final D8 reconciliation. The existing pending Core 0.164.0 and Harness 0.81.0 versions cover
this batch. No commits, publication, primary-instance restart or real GitHub mutation occurred.

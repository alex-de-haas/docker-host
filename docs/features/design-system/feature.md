---
created: 2026-10-21
updated: 2026-10-23
summary: Shared ink-and-lime tokens and local fonts in Shell, Harness and Marketplace, with Dashboard, settings, tools, Harness navigation and catalog adoption.
components: [apps/shell, apps/harness, apps/marketplace, apps/plans, apps/telemetry, apps/telemetry-ui, apps/whisper, apps/demo-app, shared/web]
---

# Design System

## Shared Foundations

Shell, Harness and Marketplace import `shared/web/hosty-theme.css`. It supplies the light and dark
ink palette, lime interaction and selection colors, status and chart tokens, and locally bundled
IBM Plex Sans and JetBrains Mono with Latin, extended Latin and Cyrillic coverage. Font license
notices ship beside the WOFF2 files; loading these faces does not contact a third-party font host.

Harness owns a local size/line-height scale without changing other apps' utility defaults:

| Harness utility | Size / line height (px) |
| --- | --- |
| `text-xs` | 13 / 20 |
| `text-sm` | 14 / 22 |
| `text-base` | 16 / 26 |
| `text-lg` | 17 / 24 |
| `text-xl` | 22 / 30 |
| `text-2xl` | 30 / 38 |

Its interface uses IBM Plex Sans, with body weight 400, heading weight 600 and button/badge weight
500. Technical text uses JetBrains Mono at 13 / 20; phone inputs retain 16 px text. The SDK's font
inheritance reset is limited to SDK-owned chrome controls. App-owned buttons and links inside the
workspace keep their font utilities, including their size, weight and line height.

The apps use their existing ReUI components and UI wrappers. Primary buttons are ink on light and
near-white on dark; primary and outline hover/press states use lime. Standard fields, checkboxes,
switches and tabs use the shared interaction tokens. App controls use one thin 2 px lime
(`#A3E635`) focus outline or ring in both themes, with red invalid/error treatment and no additional
halo or ink edge. Shell's native selects, source disclosures and dialog/resizer controls follow
that rule. The shared theme bridge keeps app-owned Harness and Marketplace controls lime inside
the SDK host. Grouped inputs suppress the child's outline and use only the parent lime outline,
or red when invalid; invalid borders remain red. SDK-owned rail and chooser controls retain their
existing SDK styling.
Document and input selection use lime with ink text. The brand-soft alias uses the existing accent
wash in both themes, including selected phone tabs, review files and environment stages.
Harness and Marketplace override the first chart series with their own identity accents.

Runtime app icons come from manifest/catalog metadata, without app-ID substitutions in Shell,
Marketplace or Harness. Shell, Plans, Telemetry, Harness, Whisper, Marketplace and Demo App declare
`assets/icon.svg` through `catalogMetadata.icon`; those SVGs contain each app's cell mark on an ink
tile with its own accent. Whisper includes the same optional display declaration as the other apps.
All seven retain `schemaVersion: app.0.1`.
Consumers use the supplied asset URL and retain image-error, named-icon or generic fallbacks.
Harness uses already available app metadata, with a generic icon where that metadata is absent.
The Core brand mark and each app's own empty-state artwork remain inline illustrations.

## Dashboard Adoption

Core and app rows share identity, status, resources and actions columns. Runtime app icons have 4 px of extra space on each side; wrapped status and resource rows align with the app text.
Core and app rows use the same 4 px gap between the title and the second metadata line.
Resource and action columns align across Core, app rows and the aggregate toolbar. Resource
labels, bounded numeric values and sparklines occupy separate space without overlapping. Compact
CPU and RAM sparklines are 56 px wide; full values remain available through accessible labels and
resource popovers. The action column has
room for Update all and its menu without truncating the Update all label. Compact layouts reflow
before the shared columns overflow, and narrow toolbars place actions on their own row rather
than over the resource readout.
Below the name, package
releases show their version; active source shows only the workspace display name or observed
branch name. The whole second metadata line — version/source name and runtime — uses the
monospaced face. Dashboard rows omit the Manual start marker; autostart remains configurable
in More and Manage > Launch. Core's source label uses the same muted `text-xs` styling as
app labels. The source name has a dotted underline, preceded by a decorative hammer for a registered
workspace or Git branch icon for source, without a type prefix, background highlight or extra padding.
Development rows omit pseudo-runtime words and their separator. Package versions retain concrete
production runtime/profile names; internal development recipe names are not shown.

Runtime choices are in each row's More > Runtime / workspace submenu. All supported lifecycle, logs, configuration,
update, backup, autostart, assistant and removal actions retain their existing authorization and
handlers. For administrators, clicking noninteractive app-row space opens standalone App Details
at `/apps/<app-id>`, outside Settings, with a `Dashboard / <app name>` breadcrumb linking to
`/dashboard`. Legacy settings Manage links migrate with their section preserved. The app name is a native
Manage link for keyboard access and opening another tab; the row gains no extra tab stop. App rows
have no service expander or inline service/network panel, and More no longer duplicates Manage application. Embedded actions, menus, version/source
disclosures and resource popovers retain their independent behavior; modified/nonprimary clicks
and text selection do not activate the row. Service facts and controls remain in Manage. Core has
no expander or expanded Dashboard panel; Settings > Host > Updates contains its read-only Core
information: listen address, public origin, data root, runtime host and ingress mode, with address
copy buttons. These facts reuse the existing Shell status and preserve configuration drafts. One contextual app shortcut is visible beside More. Pending, Configure, Update and
Start keep their existing priority. For a running app, administrators see Logs only for observed
degraded or unhealthy service health when logs are supported; otherwise they see Stop. Update,
manifest, permission and previous-operation alerts retain their diagnostics without changing this
shortcut. Missing, unknown or startup health is not a failure. Active update stages appear beneath
the current runtime/health status in Status, including on source/workspace rows; they do not
interrupt version/runtime metadata. Primary lifecycle comes from Core's runtime state, composed
with applicable health, rather than an update-stage label. Missing runtime observations show Unknown.
Update phases `stopping` and `starting` show only Updating below the primary status, without a
service suffix; other supported update phases keep their specific label and reported service.
Terminal outcomes add no row message or timer. Existing completion/error/readiness
toasts and diagnostic icons/Manage remain.
Non-administrators retain their existing Logs shortcut and never gain Stop. More retains supported
operational actions, and Core's Logs shortcut is unchanged. Workspace/source details, including
installed package version, commit and available file/line counts, open on hover or keyboard focus;
pressing the same label opens a persistent popover for touch and click access. Errors and unavailable
line totals are reported rather than replaced with zero. Both Core and source/workspace apps show
`SourceChangeSummary` after the workspace or branch name on the same second metadata line, separated
by a dot: observed additions, deletions and the count labelled `files`, with a `+` suffix for
truncation. Narrow widths wrap naturally without a forced third line. Missing line totals are omitted;
unavailable or failed inspection never supplies fabricated counts. The full disclosure remains available alongside this
visible summary. App-version hover contains revision/build information only. Update-check failures
retain their full diagnostic tooltip on the problem icon after the app name and their diagnostics
in Manage; the version wrapper does not repeat that error through a native title.

The main status carries Starting, Stopping and Restarting while lifecycle work is pending; these
verbs are not repeated beneath the app name. Independent configuration warnings and Restart
required information remain visible. State labels accompany their colors and shapes. CPU and RAM
each have a compact sparkline using the existing five-minute history, with a detailed popover and missing-data behavior. The Apps heading
contains text filters and Install; the table toolbar contains search, count, aggregate resources,
Update all when applicable, and the fleet actions menu. The responsive row composition uses the
Dashboard container width. The complete behavior is described in
[Shell navigation](../shell-navigation/feature.md) and [Core App Shell](../core-app-shell/feature.md).

Core's Runtime / workspace submenu offers Release and eligible existing named workspaces, without
a generic Source/main target. Workspace selection reviews and switches Core only, explicitly excluding
all application participants through the existing activation API. Source settings remains separate;
current source/workspace labels and IDE/external state continue to describe the factual launch.

An active Core workspace switches directly to another reviewed workspace without an intermediate
Return. Candidate preparation precedes stopping Core, and ordinary same-target restarts preserve
verified activation ownership. The captured original executable remains the Return target across
successful direct switches. Release retains its explicit current-data compatibility review and is
complete only after the factual launch is confirmed.

The selector reads one lightweight authorized catalog rather than planning every candidate. It
reloads on every menu opening. Ordinary menus contain only Release and workspace targets; unfinished,
failed or conflicting switches expose contextual progress/recovery. Choosing a target opens the
current-to-selected confirmation with animated preparation/reconnect/readiness progress, without
request UUIDs or raw phases. The persistent dialog and user/Core-scoped recovery retain original
requests across menu closure, reconnect and remount; unknown status never triggers a new operation.
These behaviors are owned by [workspace activation](../workspace-live-activation/feature.md) and
[Core development mode](../core-dev-target/feature.md).

## Apps And Removal

The Apps overview retains Open and Standalone and offers Uninstall only to administrators. Its
Uninstall and existing Dashboard/Manage removal entries prepare and open the same isolated Core
approval directly, without a preliminary Shell dialog. Core owns cleanup choices, impact, runtime
state and Shell-availability warnings, source-safety review and final confirmation.

Shell reserves the confirmation popup in the initiating gesture and keeps the blocked-popup link,
original-request submit/status recovery and visible errors. Denial leaves the app and selection
intact; opening or closing review never counts as successful removal. Success requires Core's
confirmed execution. The [installation contract](../app-installation-sdk/feature.md#trusted-confirmation)
retains the exact cleanup defaults, compatibility and authorization boundaries.

## Settings, Tools And App Layouts

Shell keeps one Settings destination in its sidebar. Settings owns grouped navigation whose Apps
group lists individual apps only when they declare an app-owned `ui.settings` surface. There is no
duplicate installed-app settings catalog; former `tab=apps` canonicalizes to the role-authorized
Dashboard/default. App-owned settings retain full-height embedding, normal Hosty identity,
authorization and internal tabs. Host-managed App Details is separate at `/apps/<app-id>`, with
section query links and legacy Manage-bookmark migration. It separates Launch from typed Parameters
and keeps independent unsaved drafts when another section is saved. The header exposes existing Open, lifecycle and More
actions; configuration Save does not restart an app. Logs follows Launch when the app declares
logs. Dashboard Logs, More > Console logs, readiness and update-notification actions select the
same addressable Logs section rather than a popup. Its existing 200-line console tail, Refresh,
service selection, aggregate fallback and empty/error states remain; reads run only while selected
and abort on exit or app/user/Core scope changes. Other forms stay mounted across Logs visits.
The ordinary-user logs-only entry keeps Apps as its accessible breadcrumb parent and adds no
management controls or Core grants. Core's administrator-only log API still authorizes the read. Core logs retain their existing dialog.
Updates and Permissions compose the existing
Core plan, feed/source/account controls and read-only permission review. No size, automatic-update
policy or local permission grant is added.

Assistant and Tools live in the top strip. The Tools menu lists the authorized catalog and opens
the existing picker through All tools. Tool headers provide Open separately, Hide and a menu for
ending that view. Hide retains the iframe and its draft; selecting and resizing use the existing
SDK host. There is no permanently occupied right icon rail. Navigation folds before a tool becomes
an overlay: Dashboard reserves 440 px, Settings/embedded apps 560 px, and the tool 320 px. Below
600 px, Dashboard, Apps, Tools and Settings use bottom tabs; Tools hides/reopens the last mounted
presentation. Its sheet keeps All tools visible and uses the visual viewport above the keyboard.

Harness uses 264 px session and 344 px workspace columns around the conversation at desktop widths.
Sessions retain combined workspace/title/app search, activity-state chips and their activity
ordering in one flat list, without a separate application selector. Icon-only Create app, Continue building and New session
buttons sit to the right of the Sessions heading and count, in that order, with accessible names
and tooltips. Each session uses one line; workspace-bound rows show a hammer and workspace name,
while other rows show the conversation title. Running work has a circular indicator on the right,
with distinct waiting and failure icons. Continue building retains its existing chooser. External workspaces is accessible
from the session column footer. Its 264 px navigation column matches the compact session rows,
with a hammer, one truncated workspace name and accent selection, without the external task ID.
The conversation pins
pending decisions with a Review action and active work with Stop, caps transcript/composer width,
and can hide the workspace without destroying it. Repository cards and all existing Git, preview,
consumer and workflow controls remain available. On narrow widths, the sessions list fills the page
and Workspace opens a sheet with keyboard focus handling and an inert conversation behind it.
Session changes opens a standalone review page across the available application width, with
file selection, Viewed, previous/next, Unified/Split and wrapping. Conversation, session navigation
and workspace details stay hidden while their state is retained; Back restores the originating view.
Phone review separates the file list and file page. Selected-line Ask Harness returns to an admitted owning
conversation, adds both endpoint sides and the comparison reference to the draft, and focuses the
composer without sending it. Core-fenced workspace conversations hide the composer until a verified
Resume; history and changes remain readable, and the draft is retained. Initial workspace loading
does not flash the composer, and a failed background read cannot reopen known fenced source.
The picker distinguishes workspace, uncommitted, target-branch and immutable published PR comparisons.
PR threads retain authors, state and side-specific coordinates; unavailable/outdated comments remain
visible. Reply, Resolve and selected-line comments are explicit Core-authorized actions with pending
request recovery. Working scopes compare an explicitly selected PR head and stripe unpublished
RIGHT-side lines. Transcript edit entries retain their recorded worktree binding and previous PR
choice; ambiguous legacy entries do not guess. Comment forms retain the original range/head and
optional Ask-to-draft intent, and late results cannot affect another session.
Consecutive transcript tool calls collapse into one **1 tool call** or **N tool calls** section.
The header appends a destructive-colored failed-call count only when nonzero, both collapsed and
expanded, counting each visible call once. Bash/Command counts use their authoritative command
outcome; MCP/other tools use their tool result. A failure must be recorded and non-conflicting;
command output status does not replace missing, unknown or conflicting command metadata. Cancelled,
unknown, missing and conflicting outcomes are excluded. The section mixes commands, MCP tools, reads and edits in their original order. Expansion reveals flat
individual rows with each call's input/output and recorded command outcomes, without nested tool-type
groups. The section retains its first-call identity as its count grows. Prose, approvals, questions
and turns separate sections; approval cards remain immediately visible outside them. Each activity
block with edits has an independent collapsible Changes sibling whose header stays visible while
Tool calls is collapsed. It shows source-bound file counts and confirmed aggregate additions/deletions
for recorded edit operations, with unknown/overflow totals unavailable. Expansion retains exact-source
file summaries and Review bindings, aggregated only within the same session/workspace/worktree/
repository/path; unbound legacy entries remain separate. These counts do not describe the current
workspace or net diff. The file summary appears in Changes, outside Tool calls. Repository headings do not repeat the
workspace branch beneath each file or show the recorded-edits explanatory caption. Sidebar branches
use a single truncated line with the complete value available in the disclosure; generated Git
branch identifiers are unchanged. Command rows have no outer frame.
Their headers stay on one line, with outcome, exit code and duration on the right immediately before
the far-right disclosure chevron, matching MCP tool rows; those facts stay in the header when
expanded. Input/output code blocks retain their borders. Bounded provider result metadata survives replay; missing outcomes, exit codes and duration remain
unavailable rather than inferred.
Generated numeric test summaries and legacy missing-identity explanations appear only in expanded
command details. Expanded per-call details separately show provider-reported Tool output with the
retained input disclosure, using the
existing code block's copy and wrapping controls. The separate result contract retains at most
32,768 characters of text or serialized JSON, omits binary payloads and recursive `_meta`, and
excludes routing, question and environment-setup outputs. Worker, coordinator and browser replay
boundaries revalidate it. Results attach only to a unique preceding call in the same user turn;
conflicts, missing history, empty output, failure, cancellation and truncation remain explicit.
Expanded command output has no additional outcome-status line; unknown and conflicting command
outcomes remain in the header. Non-command and MCP output retains its outcome indicator. Unmatched
payloads are not shown, and output does not appear in collapsed rows. Provider gaps do not produce
invented results or new Core endpoints.
PR cards collapse to two lines and expand to review chips, segmented CI, observation/merge time
and exact review actions. Current open PR icons carry CI color, running checks use Info blue,
merged is violet and drafts/closed/stale evidence are neutral. Historical summaries stay labelled
as cached. CI checks expand in place on phones. Approval cards retain one-time allow and supported
optional denial reasons; the autonomy menu explains each mode without adding grants or repeating
its description below the composer. The right side of the conversation header places the current
session activity badge immediately before the read-only Local or Docker execution badge. Local
carries a host-access warning based
on the native Harness process permissions; Docker describes the worker's container limits without
claiming that enabled MCP tools are confined to that container. The full-page and embedded composers
show the latest provider context observation as a compact circular indicator after the provider
selector, with used/maximum tokens, percentage and observation details in a keyboard-accessible
shared tooltip. Missing measurements remain explicit and replay uses the existing session stream,
as [Harness Context Usage](../harness-context-usage/feature.md) defines.
Reasoning-effort-only and unchanged preference updates preserve the last usage observation,
its timestamp and native conversation identity; an actual model change invalidates that observation.

Compact bound-application rows place lifecycle status immediately after the app name and use a
second line for package/runtime, hammer/workspace or Git/source identity. Per-app switching targets
the exact bound worktree. Group actions show Use workspace, Return to packages or both according
to factual selections; successful background refresh retains the last observation without flashing
actions. Consumer and lease details stay under Activity diagnostics.

Workspace lifecycle failures distinguish an in-flight action from an uncertain retained request;
a definite unadmitted refusal does not leave a misleading Retry action. Ordinary Delete physically
removes eligible source worktrees, branches and metadata. Discard and remove separately reviews
unfinished work and temporary resources before physical removal. Its dialog uses an explicit red
confirmation without a name-entry field, separates Keep/Refresh from removal, and animates review
loading and removal while preventing duplicate submission. Stale external leases have explicit
pause/stopped-work/recovery controls without requiring the original agent. Current guards and
verification limits are documented in [workspace lifecycle controls](../workspace-lifecycle-controls/feature.md).

Marketplace presents Discover and Installed views, category chips and cards. Its standalone
storefront and settings page hide the redundant SDK navigation rail, with matching bootstrap
metadata. The storefront omits its repeated title and description and places Settings beside the
catalog source, including during loading or failure. It has explicit catalog/installed failure
retries and retains detail Refresh, without a global Refresh button or replacement polling. Search
includes publisher and category. Installed uses Core's app/user-authorized app list, includes apps absent
from the catalog, and shows installed version, recorded source/feed, runtime and last update verdict.
It exposes Open for running UI apps and Manage through the installed Shell; stopped apps keep a
disabled Open with the explicit start path in Manage. API failures show a retryable error. Details
use an in-page pane beside the catalog on desktop and a Back-to-catalog page on narrow screens,
retaining signer, screenshots, description, channel choice and the Core-confirmed installer.
Superseded/closed reads cannot replace selection; authorization failures clear protected content.
Refresh errors preserve readable content with install actions disabled until recovery.

The shared loading mark lights the H cells down the left host, through Core and up the right host.
Lit cells use lime with the strong edge on light surfaces. Reduced motion keeps a static H and Core
cell. Shell empty artwork uses dashed slots around the lime Core; app empty artwork uses its own
cell mark. Initial Core/app inventory, settings metadata and address/port reads use the grid loader
without changing their loading/error predicates. Existing status labels and working dots retain
their separate Info-blue semantics. Error/warning text and surfaces use semantic foreground/soft
tokens. Notification severity has both a shape and an accessible label.

The shared theme supplies the SDK workspace frame's public background, foreground, muted and
border overrides, so standalone Harness and Marketplace frames follow the app palette. Touch
fields keep a 16 px minimum text size even when a component uses smaller desktop text utilities.
Shell's tool picker groups entries by app and distinguishes loading, unavailable catalog, empty
catalog and filtered no-results states. Phone sheets and dialog bounds use the Shell's visible
viewport height; resized layouts retain mounted tool frames and their drafts.

Harness text-bearing status surfaces use semantic soft colors while CI segments and dots retain
filled colors. Long transcript, model, menu and review values wrap within narrow panes. The review
thread location occupies a separate row from its state badges. Model-catalog results and errors
are keyed by session, connection and connection revision; a failed read offers Retry models, and
changing that binding never displays a previous connection's choices or failure. Nested review
pickers handle Escape before the review's Back action.

Marketplace initial loading has visible labels. Empty and failed catalog, detail and installed
states retain distinct recovery actions. A transient installed-list refresh failure preserves
Open and Manage for the last successfully read roster and labels that evidence; authorization
failure still clears protected content. Closing details restores the opener or search focus.
Catalog settings loads with explicit retry, saves against its observed source and retains the
unsaved source on rejection. These presentation changes add no install or permission authority.

## Testing Expectations

- Verify Harness's computed type sizes, line heights and weights in standalone and SDK-hosted
  desktop/narrow views, including headings, buttons/badges, technical text and 16 px phone inputs.
  SDK chrome font resets must not override app-owned control utilities.
- Build Shell, Harness web and Marketplace after shared CSS/font changes; verify local font assets
  are included in each result. Shell and Marketplace accept `NEXT_DIST_DIR` for verification builds
  separate from a running development server.
- Verify each manifest-relative icon resolves to a contained, bounded SVG with the specified cell
  map and accent, without scripts or external resources; render the actual SVGs. Keep app versions,
  image tags, package/lockfile copies and baked version constants consistent. Icon metadata changes
  do not change runtime declarations or the manifest schema.
- Verify Core/app/toolbar resource and action alignment at desktop, compact and narrow widths.
  Long resource values and sparklines never overlap, full values remain accessible, and Update all
  plus the menu stays reachable without clipping or covering the narrow resource row.
- Run Shell component/action tests for runtime choices, Return, pending/rejected operations, source
  provenance and hover/keyboard/click/touch disclosure. Verify the complete monospaced metadata
  line, dotted source names with decorative hammer/Git icons, matching Core/app muted text size,
  factual dot-separated source counts on that same line with natural narrow wrapping, the `files`
  label and `+` truncation suffix, no development pseudo-runtime words or orphan separators,
  unchanged production runtime names, one lifecycle status and independent configuration/restart
  information. Cover contextual app actions for healthy, problematic and unobserved health,
  unsupported logs, administrator versus ordinary-user access, and unchanged pending/configuration/
  update/start priority; Core's Logs shortcut remains unchanged. Run affected Harness and Marketplace
  tests for shared changes. Check revision-only app-version hover and full update-error diagnostics
  on the problem icon. Apps Uninstall remains administrator-only and uses direct Core review with
  all cleanup choices, blocked-popup fallback, denial and same-request recovery intact. Verify app
  row clicks and the app-name link open Manage without a service expander or duplicate More entry,
  while embedded controls retain their own actions. Core has no expander; its five host facts and
  address copy controls remain in Settings > Host > Updates, with unavailable values explicit and
  unsaved forms retained. All former app service/network facts remain reachable in Manage. Verify Core Release/named workspace selection,
  Core-only participants, compatibility-bound Return, fresh review, factual Release completion and
  original-request recovery; app menus retain their source/branch choices under the shared name.
- Verify standalone App Details at `/apps/<app-id>`, administrator Dashboard breadcrumbs and legacy
  Manage migration with section queries preserved. Settings Apps contains only declared `ui.settings`
  surfaces, with no installed-app catalog and retained iframe height, identity/access and drafts.
- Verify expanded tool details retain input and show bounded provider-reported text/JSON output
  with copy/wrap, error, empty, unavailable, unrecorded and truncation states. Cover call/turn
  identity, hidden unmatched/conflicting results, legacy history, binary/metadata omission and
  worker/coordinator/replay validation. Verify mixed **1 tool call** / **N tool calls** sections with
  nonzero-only destructive failed-call counts in both header states, canonical command-outcome
  precedence without an output-status fallback, per-call deduplication and exclusion of cancelled/
  unknown/missing/conflicting outcomes. Verify flat call order, retained disclosure/focus as calls arrive, prose/decision/turn boundaries and
  immediately visible approvals and every command's result/input/output. Verify independent Changes
  disclosure outside Tool calls, visible headers while tools are collapsed, per-activity exact-source
  file counts/confirmed totals, unknown/overflow and legacy states, and retained Review bindings. Borderless command rows keep single-line headers with
  right-aligned status/exit/duration before the far-right chevron, retained input/output code-block
  borders and no duplicate expanded outcome lines; MCP/non-command output retains its error indicator.
- Verify the circular context indicator after the provider selector in full-page and embedded
  Harness composers at desktop and narrow widths. Keep token counts, percentages, unavailable and
  missing-limit states accessible in its tooltip; verify keyboard access, session isolation,
  replay and existing composer actions. Verify the header's factual Local/Docker badge and its
  permissions explanation, with autonomy details retained in the mode menu and no duplicate footer.
- Verify runtime-app Logs deep links and both Dashboard entries, readiness and update-notification
  actions select the capability-gated tab without a modal. Cover retained drafts, selected-only
  reads/Refresh, per-service and aggregate output, empty/errors, scope/exit aborts and logs-only
  ordinary-user entry without management authority. Core log-dialog behavior is unchanged.
- Inspect the apps through Core-authorized Shell embedding. Check keyboard menus, source details,
  resource history, search/filters, narrow layouts and both themes during visual acceptance. Focus
  has one visible 2 px lime (`#A3E635`) indicator without a second ring, halo or ink edge on
  app-owned controls, including inside the SDK host. Check retained red invalid/error treatment
  and parent-only grouped-input focus separately from SDK-owned rail and chooser controls.
- Keep each remaining adoption and its functional-parity acceptance in the [plan](plan.md); shared
  styling alone does not establish acceptance of a whole app layout.

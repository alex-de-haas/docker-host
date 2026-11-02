---
created: 2026-11-02
updated: 2026-11-02
summary: Shell displays multiple retained app tools and Feedback with common chrome, independent visibility, resizing and compact tabs.
components: [packages/app-sdk, apps/shell]
---

# Concurrent Tool Panels

Shell opens tools beside its current document. Opening another tool adds a panel; reopening one
focuses its retained instance. Each panel has common header, border, spacing and resize controls.
Hide affects only that panel and keeps its iframe mounted. End this tool view releases its instance.
Assistant handoff messages still name their verified presentation and never retarget a sibling draft.

## SDK State And Layout

Workspace registration opts into concurrent visibility with `multiple: true`. Its `visibleIds` list
is independent of `selectedId` (focus), and `expanded` controls the workspace as a whole.
`focusPresentation` exposes and focuses one instance; `hidePresentation` removes just that instance
from visibility. Close removes the presentation. The next remaining visible panel receives focus.
Collapsing retains the visible list, while account/installation invalidation clears affected instances.
The default registration remains single-panel for Desktop, standalone and existing SDK consumers.
This state belongs to the authenticated host; it grants no new iframe or provider authority.

Columns reserve the document minimum and contract to 280 px per panel before switching to tabs.
Compact tabs retain all instances, with ArrowLeft/ArrowRight/Home/End keyboard support. Phone
workspaces stack the document and selected tool. Resizing and layout changes preserve iframe nodes,
routes, browser drafts and unsent messages. Width preferences are described in
[Shell panel resizing](../shell-panel-resize/feature.md).

## Feedback

Feedback is an [app-provided composer tool](../feedback-composer-tools/feature.md), with an ordinary
iframe and the same chrome, pinning, resizing and retention as any other tool. It stays open during
selection and comment editing. Selecting the form itself belongs to its provider app; selecting
Shell chrome belongs to Shell. Cancel selection is excluded, and native input values never enter
evidence. Desktop and standalone use their ordinary single-tool workspaces.

Each report belongs to one source app/installation/account. The source SDK selects elements and
submits through its own authenticated adapter; the composer application owns drafts and forms.
Sources becoming visible after compact/wide layout changes are refreshed without remounting them.

## Verified Acceptance

On 2026-11-02, macOS Chrome acceptance in a parent-managed child Core passed three concurrent
panels, Feedback self-annotation, cross-frame hover handoff, cancellation, independent resizing and
hiding, compact tabs and main-page navigation with the same iframe nodes and unsent assistant draft.
Normal password login, scoped app identity and separate test data were used. Desktop window/host
capture also passed after retrying its cold development-route connection failure in the same child.

The final run measured a 25.195-second cold Harness start, 2.087-second warm restart and
26.105-second missing-output recovery. Parent Finish confirmed removal of child resources; the
fixture then removed its processes, credentials, builds and snapshots. This was the browser-only
feedback variant, without agent dispatch. Other operating systems and native webviews were not tested.

The app-provided [Feedback composer](../feedback-composer-tools/feature.md) extends this acceptance
with an ordinary pinned provider iframe, provider-owned draft persistence and retry, screenshots,
source attribution and Desktop window/root isolation. Its manifest declaration is preserved by Core.

## Testing Expectations

- SDK tests cover default single-panel compatibility, concurrent visibility, focus, hide, close,
  activity loss, stale operations and account replacement.
- Shell tests cover independent panels, same-tool instances, retained document/iframe identity,
  focus restoration, compact tabs and document width bounds.
- Managed browser checks cover document + Pull requests + Assistant + Feedback, self-annotation,
  persistent draft scope, one hover highlight, cancellation, independent resize/hide and responsive
  layout with an unsent assistant message. No model message is submitted by this acceptance.
- Run SDK/Shell tests and builds, affected consumer builds, lint, documentation and version checks.

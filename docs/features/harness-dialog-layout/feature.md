---
created: 2026-10-30
updated: 2026-10-30
summary: Harness modal forms and choosers keep their headers and actions visible while only their central content scrolls.
components: [apps/harness]
---

# Harness Dialog Layout

Harness dialogs use a bounded vertical layout: a non-scrolling title and explanation, a scrolling
body, and non-scrolling primary actions. The close control stays visible beside the header. The
layout uses the current app viewport, including when Harness is embedded in Shell. Dialogs reduce
padding and gaps below 480 px of available height; footer actions share a row when they fit and
wrap when necessary.

`DialogContent`, `DialogHeader`, `DialogBody` and `DialogFooter` in the local UI layer compose this
layout. Nested forms retain their submit handler and footer inside the same form. The body has a
zero minimum height and an independent vertical scroll region; its inner column retains the
natural size of fields and sections. Validation, cancellation, busy guards, request recovery and
focus restoration keep their existing behavior. Actions for individual rows remain beside those
rows rather than becoming ambiguous dialog-wide actions.

## Covered Surfaces

The shared layout covers profile creation, editing and deletion; agent and translation provider
configuration; provider sign-in; application creation and continued building; app development
mode, local repository actions and local app handoff; session attachment and chat deletion; and
workspace resource, lease recovery and deletion dialogs. The Skills chooser retains its existing
bounded body and fixed header/footer using the shared primitives.

On narrow screens the retained workspace sheet has a fixed Workspace header and a fixed Back to
conversation footer. Its details scroll between them. The same retained component tree preserves
local form state across responsive layout changes; keyboard focus remains contained while the
sheet is open and returns to the opener when it closes.

Anchored menus, tooltips and informational popovers keep their own interaction patterns. The
full workspace review view keeps its page layout and navigation. This layout belongs to Harness,
within the shared [design system](../design-system/feature.md); it does not change Shell or SDK
modal contracts. Related behavior is documented in [agent profiles](../agent-profiles/feature.md)
and [workspace sessions](../workspace-sessions/feature.md).

## Testing Expectations

- Run Harness web component tests, lint/type checks and the production build after layout changes.
- Exercise representative long forms and short confirmations through normal Core password login
  and Shell embedding in a managed sandbox. Check light/dark themes and desktop, narrow and short
  viewports; measure that header/footer positions do not move when the body scrolls.
- Verify native form submission, validation, cancellation, retained drafts and keyboard focus.
  Workspace-sheet tests cover focus wrapping, Escape, restoration and retained fields.
- Keep provider credentials and application creation/publication out of layout-only browser checks.
  The managed sessions integration suite verifies workspace actions independently. Finish the
  owned test sandbox and confirm resource removal after browser checks.
- Browser viewport emulation is distinct from physical-device testing with a software keyboard;
  record that limitation when no such device check is available.

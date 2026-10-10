---
created: 2026-09-22
updated: 2026-10-10
summary: Shared SDK dock and drawer resizing with Shell width/open preferences and retained app frames.
components: [apps/shell, packages/app-sdk]
---

# Resizable Shell Panel

Shell uses the [shared SDK panel workspace](../sdk-panel-system/feature.md) inside its own navigation.
A 12 px separator supports pointer dragging and keyboard ArrowLeft/ArrowRight resizing in 16 px
steps. Double-click or Home resets the preferred body width to 360 px, beside the 48 px tool rail.
The body clamps to 280–800 px and reserves at least 480 px for the document. Automatic viewport
constraints do not overwrite the preferred width. Below 900 px of workspace width the same frame
moves by CSS into a drawer up to 440 px wide; it is not remounted.

## Persistence And Embedding

Shell retains `hosty.shell.right-panel-width` and `hosty.shell.right-panel-open` preferences.
Changing preferred width/open state persists through the existing chrome callbacks. Reload uses
those layout preferences; tool selection and opened frames belong to this browser window only.
Standalone apps use the same SDK controls without depending on Shell cookies.

Collapse leaves opened frames mounted, hidden and inert. Switching tools also retains their frames
and unsent input. A target/route change replaces only that tool's frame. Removed access or changed
frame policy invalidates it. On narrow screens document/rail content becomes inert while the drawer
is open; Escape, backdrop and Return to document close it and restore focus.

## Testing Expectations

- SDK workspace tests verify retained document selection and frame nodes through collapse,
  switching, same-target replay and the dock/drawer breakpoint; one slot is enforced.
- Run affected Shell/SDK tests, lint and production builds.
- Browser acceptance verifies pointer/keyboard resizing, reset, remembered width/open state,
  assistant draft retention, Shell navigation, drawer focus/inert state, and no model submission.

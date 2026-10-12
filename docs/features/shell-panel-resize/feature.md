---
created: 2026-09-22
updated: 2026-10-12
summary: Shell-owned ReUI document and panel containers with persistent resizing, responsive drawers and retained SDK app frames.
components: [apps/shell, packages/app-sdk]
---

# Resizable Shell Panel

Shell owns its ReUI document container, tool rail, picker and panel header. Both document and
right-hand tools have rounded borders, background tokens and subtle shadows. The SDK owns the
host contract and frame transport, with one retained iframe per presentation. The standard SDK
workspace remains available to standalone applications and other hosts.

`ShellWorkspaceSplit` uses the ReUI resizable primitives. Its 12 px separator supports pointer
and keyboard resizing. Double-click resets the preferred body width to 360 px, beside the 48 px
rail. The existing bounds reserve document space and clamp the panel to available width, up to
800 px for its body. Automatic viewport constraints do not overwrite the preferred width. Below
900 px of workspace width, the same frame tree uses a drawer up to 440 px wide; it is not remounted.
Docked headers expose only Open separately; the selected rail icon collapses the panel. Drawers
provide Return to document. SDK close operations remain available to other host layouts.

## Persistence And Embedding

Shell retains `hosty.shell.right-panel-width` and `hosty.shell.right-panel-open` preferences.
Changing preferred width/open state persists through the existing chrome callbacks. Reload uses
those layout preferences; tool selection and opened frames belong to this browser window only.
Standalone apps retain the SDK renderer without depending on Shell cookies.

Collapse leaves opened frames mounted, hidden and inert. Switching tools also retains their frames
and unsent input. A target/route change replaces only that tool's frame. Removed access or changed
frame policy invalidates it. On narrow screens document/rail content becomes inert while the drawer
is open; Escape, backdrop and Return to document close it and restore focus.

## Testing Expectations

- Shell renderer tests against the real SDK host verify retained document selection and frame nodes through collapse,
  switching, same-target replay and the dock/drawer breakpoint; one slot is enforced.
- Run affected Shell/SDK tests, lint and production builds.
- Browser acceptance verifies pointer/keyboard resizing, reset, remembered width/open state,
  assistant draft retention, Shell navigation, drawer focus/inert state, and no model submission.

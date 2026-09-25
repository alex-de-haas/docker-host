# Resizable Shell Panel

Created: 2026-09-22
Updated: 2026-09-24

Shell's [right panel](../app-ui-surfaces/feature.md#shells-chrome) shares a horizontal
shadcn Resizable group with the workspace. The navigation rail remains outside this
group. A 12 px gap between the rounded surfaces supports pointer dragging and keyboard resizing; double-clicking
it resets the preferred body width to 360 px (408 px including the icon rail).
The Resizable wrapper uses Shell's existing `cn` helper for Tailwind class merging.

The gap has no grip icon or collapse button; its resize cursor indicates the interaction.
A short indicator appears on hover, keyboard focus, or pointer press.
The top-strip toggle opens and closes the body while keeping its 48 px icon rail visible.
The gap remains as spacing when collapsed, but cannot be dragged or keyboard-focused.
The collapsed 48 px surface includes its outer border; the icon rail fits the remaining
inner width, avoiding horizontal overflow. Only the rail scrolls vertically when tools
exceed its height; the outer surface clips its contents.

The body normally has a 280 px minimum and an 800 px maximum, plus a 48 px icon rail. Its maximum also reserves
workspace space: 240 px or 30% of the space remaining after the rail and gap, whichever is smaller.
On narrow viewports the panel minimum relaxes to 65% of the space remaining after the rail and gap, so the two
panels and their 12 px separator fit without forcing the Shell wider than its viewport.
Width calculations exclude this gap, the icon rail and the group's outer padding when saving preferences.

## Persistence and Embedding

Completed user resizes save a rounded body width in the
`hosty.shell.right-panel-width` preference cookie for one year. The server reads and
validates it alongside the other chrome preferences. Closing/reopening the panel and
reloading Shell restore the preferred width; automatic viewport constraints do not
overwrite it. Pixel width stays stable when navigation expands or collapses, subject
to the available space.

Collapsing also leaves the selected body mounted but hidden and inert. Only layout changes during resizing. The mounted workspace and right-panel iframe stay
in place, retaining their active session and draft. The icon rail selects tools without eagerly launching unopened frames; app permissions
and launch-code authentication are unchanged. No panel means no divider;
the workspace occupies all the space beside navigation.

## Testing Expectations

- Run `npm run test --workspace @haas/hosty-shell`, including invalid preference values,
  desktop bounds, and non-conflicting constraints for narrow/unmeasured groups.
- Run Shell lint and production build. Check TypeScript through the build.
- In the authenticated Core-managed Shell, verify pointer and keyboard resizing, retention
  of a chat draft, double-click reset, close/reopen, reload persistence, navigation toggling,
  and narrow viewport constraints. Do not send a test message to the live agent.
- Confirm the divider has no extra icon and still supports pointer and keyboard resizing.

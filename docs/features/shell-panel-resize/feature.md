# Resizable Shell Panel

Created: 2026-09-22
Updated: 2026-09-22

Shell's [right panel](../app-ui-surfaces/feature.md#shells-chrome) shares a horizontal
shadcn Resizable group with the workspace. The navigation rail remains outside this
group. A visible divider supports pointer dragging and keyboard resizing; double-clicking
it resets the preferred right-panel width to 360 px.

The panel normally has a 280 px minimum and an 800 px maximum. Its maximum also reserves
workspace space: 240 px or 30% of the available group width, whichever is smaller.
On narrow viewports the panel minimum relaxes to 65% of available space, so the two
panels and their one-pixel separator fit without forcing the Shell wider than its viewport.

## Persistence and Embedding

Completed user resizes save a rounded pixel width in the
`hosty.shell.right-panel-width` preference cookie for one year. The server reads and
validates it alongside the other chrome preferences. Closing/reopening the panel and
reloading Shell restore the preferred width; automatic viewport constraints do not
overwrite it. Pixel width stays stable when navigation expands or collapses, subject
to the available space.

Only layout changes during resizing. The mounted workspace and right-panel iframe stay
in place, retaining their active session and draft. Existing panel tabs, permissions,
open/close controls, and launch-code behavior are unchanged. No panel means no divider;
the workspace occupies all the space beside navigation.

## Testing Expectations

- Run `npm run test --workspace @haas/hosty-shell`, including invalid preference values,
  desktop bounds, and non-conflicting constraints for narrow/unmeasured groups.
- Run Shell lint and production build. Check TypeScript through the build.
- In the authenticated Core-managed Shell, verify pointer and keyboard resizing, retention
  of a chat draft, double-click reset, close/reopen, reload persistence, navigation toggling,
  and narrow viewport constraints. Do not send a test message to the live agent.

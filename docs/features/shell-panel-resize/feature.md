---
created: 2026-09-22
updated: 2026-11-02
summary: Shell tool columns with independent persistent resizing, compact tabs, and retained SDK app frames.
components: [apps/shell, packages/app-sdk]
---

# Resizable Shell Panels

Shell supplies a common rounded border, background, shadow and header for app tools and Feedback.
Each panel has All tools and Hide controls; app panels also offer Open separately and End this tool
view. The SDK owns authority, frame identity and transport. Desktop and standalone retain their
existing SDK layouts.

`ShellConcurrentPanels` places the document and open tools in adjacent columns. Each 12 px separator
supports pointer resizing, ArrowLeft/ArrowRight in 20 px steps, and double-click reset to 360 px.
Preferred panel widths range from 280 to 800 px. Available document space is reserved first; panel
widths contract proportionally without overwriting their preferences. When even the minimum widths
do not fit, a keyboard-accessible tab switcher presents one of the retained panels. On phone-sized
workspaces the document and selected panel stack vertically, without a modal or inert document.

## Persistence And Embedding

Shell retains the existing `hosty.shell.right-panel-width` fallback and `hosty.shell.right-panel-open`
preference. Individual tool widths use versioned browser storage scoped to Core and account, keyed
by tool identity. Each mounted instance can resize independently.
Automatic viewport constraints do not rewrite saved widths. Tool selection and open frames are
window-local; reopening a hidden tool restores its existing frame and draft.

Each iframe remains under the same keyed parent through resizing, hiding, focus changes and compact
layout. Hide retains that instance; End this tool view releases only it. Removing access or changing
installation, origin or frame policy still invalidates the affected frame. The shared
[concurrent tool panel contract](../concurrent-tool-panels/feature.md) describes SDK visibility and focus.

## Testing Expectations

- Shell tests against the real SDK cover independent open/hide/end, same-tool instances, focus,
  keyboard tabs, document state and iframe retention across width changes.
- Layout tests reserve document space, clamp panel widths and restore preferences on wider screens.
- Managed browser acceptance covers multiple tools plus Feedback, pointer/keyboard resizing,
  source-scoped feedback, compact layout and unsent assistant draft retention.
- Run Shell/SDK suites, affected consumer builds and lint; report unchanged existing warnings.

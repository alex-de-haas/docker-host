---
status: Draft
created: 2026-10-12
updated: 2026-10-15
summary: Hosty's visual language — ink acts, lime answers — with its color, type, mark and ReUI token rules, and the Shell layouts built from it, including tools at narrow widths and on phones.
components: [apps/shell, apps/shell-swift, packages/app-sdk, apps/core, apps/harness, assets/hosty-brand, apps/plans, apps/workspaces, apps/telemetry, apps/telemetry-ui, apps/demo-app, apps/marketplace, apps/whisper]
---

# Design System

## Goal

Give Hosty one visual language that reads as calm and corporate without being grey and gloomy,
and apply it to Shell. Chrome stays ink and white; color is spent on what is alive on a host — app
tiles, status and data. The same rules must hold from a wide desktop to a Shell window squeezed
beside an agent and to a phone.

## Source

The design lives on a Design canvas: <https://claude.ai/artifact/4LypxfZnHz2E7fxhXti4th>. The canvas
is the single source for the visuals and keeps its own version history; it is private to the owner
until shared from its page. This document carries every value and rule needed to implement it.

| Artboard | Covers |
| --- | --- |
| `Main` | Cover and the four principles |
| `Color`, `Accent` | Palette, ink scale, status, app accents; ink acts, lime answers |
| `Type`, `TypePairings` | Type scale and voice; the face comparison behind IBM Plex Sans + JetBrains Mono |
| `Iconography`, `Roles`, `AppMarks` | Mark, app icons, interface icons; provider role icons; the app mark family |
| `Components`, `Tokens` | ReUI components in light and dark; CSS variables |
| `Motif` | Cell motif, loader, empty state, motion |
| `Shell`, `AppDetail`, `DataGrid` | Dashboard with tools, dark app detail, table page |
| `PanelOptions`, `ShellNarrow` | The fit rule for tools, Shell in a 900 px window |
| `PhonePeek`, `PhoneSheet`, `PhoneTools`, `PhoneKeyboard`, `PhoneManyTools` | Phone: tab bar, open tool, tool list, keyboard and long dialog, many tools |

## Principles

1. **Calm chrome, lively content.** Navigation, panels and text stay ink and white. Color belongs to
   app marks, status and charts.
2. **Ink acts, lime answers.** Primary buttons are ink. Lime appears in answer to the person —
   hover, press, focus and selection — and, by owner decision, in two fixed places: progress bar
   fills, whoever started the work, and the Core cell of the mark. One primary button per view; the
   rest are outline or ghost.
3. **Work moves in blue.** An app starting or a tool at work shows a pulse or a turning ring in Info
   blue with a label, and its progress bar fills in lime; there is no separate live color.
4. **Cells.** The mark is seven square cells; the same cells build the motif, the loader, empty states
   and diagrams.

## Color

### Core

| Name | Hex | Use |
| --- | --- | --- |
| Ink | `#0F1B2D` | Text, dark surfaces, the mark, the primary action (17.4:1 on white) |
| Mist | `#F6F8FB` | Light canvas; cards sit on it in pure white |
| White | `#FFFFFF` | Cards, popovers and fields on the mist canvas |
| Lime | `#A3E635` | Brand: hover and press, focus ring, checked and selected fills, text selection, progress bar fills, the Core cell of the mark. The same in both themes; carries ink text (11.5:1); never text, icons or hairlines on light (1.5:1 on white) |
| Lime strong | `#5A9A0A` | Small lime marks on light: the active-navigation marker, the selected-tab underline, loader cell edges (3.5:1 on white, 3.2:1 on mist and lime soft) |
| Lime soft | `#ECFCCB` | Highlight under ink text: menu items, ghost hover, active navigation (dark: `#273B2E`) |

Approximate share of a typical screen: ~70% white and mist, ~20% ink, ~5% lime and only on
interaction, and ~2% app and status color.

Owner decision, 2026-10-13: ink is the action color and lime the interaction color, in both themes.
Hosty Blue `#1C68FF` remains only as Info, for links (`#1449C2` on light, `#8DB4FF` on dark) and as the
first chart color, `--chart-1`, because charts are data, not brand; a sky
blue `#00BBFF` tried the same day was dropped, and so was the cyan signal color: work now shows in Info
blue with motion, so the brand is ink, white and lime. The per-user accent setting stays parked in
[Accent Presets](../accent-presets/plan.md).

### Ink scale (cool neutrals, hue 215°)

| Step | Hex | Use |
| --- | --- | --- |
| 50 | `#F6F8FB` | Canvas, sidebar |
| 100 | `#EEF2F7` | Muted, hover |
| 200 | `#DFE5EE` | Border |
| 300 | `#C3CDDB` | Input border |
| 400 | `#93A3BA` | Muted text on dark; disabled on light (2.9:1) |
| 500 | `#6E7F98` | Icons only (4.1:1 on white — not for text) |
| 600 | `#5A6A82` | Muted text on light — the lightest text allowed (5.4:1) |
| 700 | `#3A4B66` | Secondary body text |
| 800 | `#26364F` | Border on dark |
| 900 | `#17253B` | Card on dark |
| 950 | `#0F1B2D` | Text; dark canvas |

### Status

Four meanings, never mixed: **info** tells, **needs you** asks, **failed** reports an error, and
**working** shows activity. A waiting approval is "needs you", not info.

| State | Solid | Soft | Text | Meaning |
| --- | --- | --- | --- | --- |
| Running | `#16A34A` | `#E8F7EE` | `#0F6B33` | Healthy and serving |
| Working | `#1C68FF` (dark: `#4D8BFF`) | `#E8F0FF` | `#1449C2` | Starting, updating, a tool at work: Info blue with a pulse or ring and a label; its progress bar fills lime |
| Stopped | `#93A3BA` | `#EEF2F7` | `#5A6A82` | Intentionally off, not an error |
| Info | `#1C68FF` | `#E8F0FF` | `#1449C2` | An update or a result; never requires action |
| Needs you | `#F59E0B` | `#FEF3DC` | `#8A5300` | A decision or a fix: approval, degraded app, missing configuration |
| Failed | `#D93036` | `#FDECEC` | `#B4232A` | Error: crashed, unreachable, refused |

Color never carries a state alone. The normal state — running and healthy — is the only one shown as
a bare dot, with its name in the tooltip and accessible label. Every other state carries a text
label, and where there is no room for one, its own shape: a diamond for "needs you", an alert icon
for "failed", a hollow ring for "no connection", and for "working" a pulse that becomes a static outer
ring when motion is reduced. No two states differ by color alone: working shares Info's blue and is
told apart by its motion and label.

### App accents

Each first-party app has one accent. It is identity only: the lit cell of the app's mark, a 3 px
strip on the app's own frame, the first series of the app's own charts (the app sets `--chart-1` to
its strong shade on light and to the accent itself on dark, where the strong shades drop below 3:1) and its mark, with that one cell lit, in its empty-state art. It never fills behind content, never marks focus or selection, and never
stands for a state, so it may sit near a status hue without meaning one. Lime stays Hosty's, and
interaction stays lime inside every app. Accents sit at least 20° apart — the closest pair, Harness and Marketplace, is 21° — and a new
first-party app takes a free hue and a free mark. Third-party apps keep their own icons.

| App | Accent | Strong (chart lines and small UI marks on light) | Mark | Cells, top to bottom |
| --- | --- | --- | --- | --- |
| Hosty (reference) | `#A3E635` | `#5A9A0A` | H | `X.X` `X*X` `X.X` |
| Shell | `#22D3EE` | `#0891B2` | S | `XX.` `X*X` `.XX` |
| Plans | `#60A5FA` | `#2563EB` | P | `XXX` `X*X` `X..` |
| Telemetry | `#A78BFA` | `#7C3AED` | T | `X*X` `.X.` `.X.` |
| Harness | `#FB923C` | `#C2410C` | A (agent) | `.X.` `X*X` `X.X` |
| Whisper | `#F472B6` | `#DB2777` | V (voice) | `X.X` `X.X` `.*.` |
| Marketplace | `#FACC15` | `#A16207` | M | `XXX` `X*X` `X.X` |
| Workspaces | `#34D399` | `#059669` | W | `X.X` `X*X` `XXX` |
| Demo App | `#E879F9` | `#C026D3` | D | `XX.` `X*X` `XX.` |

`X` is an ink (or white) cell, `*` the lit cell in the accent, `.` an empty cell; each row reads left to
right on the 3 × 3 grid. The lit cell uses the base accent on every surface, like the Hosty Core cell:
a logo is exempt from contrast minimums, and the strong shade is for chart lines and small interface
marks. The catalog icon — which Shell also shows in its rows and navigation — and the empty-state art both
use this map; there is no separate in-app copy of the mark.

## Typography

IBM Plex Sans for the interface, JetBrains Mono for anything a machine wrote — IDs, ports, versions,
paths, logs. Owner decision, 2026-10-15, after the `TypePairings` comparison: Plex's squared details
echo the cell mark, JetBrains Mono reads better in code and logs than Plex Mono, and both cover
Cyrillic and ship under the OFL. Core pages self-host both files, allowed by `font-src 'self'` in their otherwise strict CSP.
Weights 400 and 600 do most of the work; 500 is for buttons and badges.

| Token | Size / line | Weight | Tracking |
| --- | --- | --- | --- |
| display | 48 / 52 | 600 | −3.5% |
| h1 | 30 / 38 | 600 | −2% |
| h2 | 22 / 30 | 600 | −1.5% |
| h3 | 17 / 24 | 600 | −1% |
| body-lg | 16 / 26 | 400 | 0 |
| body (default) | 14 / 22 | 400 | 0 |
| small | 13 / 20 | 400 | 0, muted |
| overline | 11 / 16 | 600 | +8%, uppercase |
| mono | 13 / 20 | JetBrains Mono 400 | 0 |

Sentence case everywhere; uppercase only for the overline. Numbers that change use `tabular-nums`.
Body lines stop at about 72 characters. Phone inputs use 16 px so mobile browsers do not zoom.

### Voice

Friendly, not cute. Say what happened, then what to do; name the app, the port or the path. Examples
in designs set the standard too: an assistant proposes an action only for a problem that is still
happening.

| Do | Don't |
| --- | --- |
| Core restarted. 9 apps reconnected. | Woohoo! Everything is back online!! |
| Telemetry can't reach port 4318. Check that the collector is running. | Oops, something went wrong. |
| Remove Marketplace? Its data stays in `~/.hosty/apps`. | Are you sure? |

## Logo and icons

- **Mark.** Seven square cells on a 3 × 3 grid spell an H: two hosts and the Core between them. On
  the 100-unit grid the cells are 22 units with 7-unit gaps, starting at 10, with sharp corners. Six
  cells are ink on light and white on dark; the Core cell is lime `#A3E635` on every surface (owner
  decision, 2026-10-14; a logo is exempt from contrast minimums). The mark never sits on a colored tile. It replaces the H-graph in
  [`assets/hosty-brand`](../../../assets/hosty-brand/README.md). Clear space is one cell. Below 20 px
  use the favicon cut, scaled ×1.16 with the gaps kept open. No gradients, no app accents, no
  rounded or merged cells, no rotation.
- **App icon.** Where a container is required — app icon, favicon, store — the mark sits on an ink
  tile with radius 22: white cells 16 units with 5.5-unit gaps from 20.5, and the lime Core. Where Shell
  draws it on a dark surface the tile steps one tone lighter (`#22324B`) instead of taking a grey
  frame; a baked icon elsewhere keeps the ink tile and sits on a card surface in dark mode.
- **Wordmark.** IBM Plex Sans 600, shipped as outlined paths; the current lockups ask the system for Inter.
- **App marks.** Every first-party app is drawn like the Hosty mark: square cells on the same 3 × 3
  grid spell the app's initial, with exactly one lit cell in the app's accent (see App accents). Ink
  cells on light, white on dark; where a container is required, the same ink tile as the Hosty icon
  (`#22324B` where Shell draws it on a dark surface), never a colored tile. A pattern belongs to one app. They replace the
  colored tiles with stroke glyphs.
- **Interface icons.** Lucide at 16, 20 or 24 px, stroke 2, never filled, inheriting text color —
  muted at rest, ink when active. App navigation icons ship in `currentColor`; Shell tints them.
- **Tool icons.** A tool shows its manifest Lucide icon on a neutral tile, with the owning app's
  accent as a small corner badge.

### Provider roles

Hosty does not divide apps into system and ordinary, and no design shows a "System" label. An app is
described by the roles it provides; each role has one icon, used wherever the app appears.

| Role | Icon (Lucide) | Provided today by |
| --- | --- | --- |
| `ui-client` | `app-window` | Shell, once [replaceable UI clients](../replaceable-ui-clients/plan.md) ships the role |
| `assistant` | `bot` | Harness |
| `speech-to-text` | `audio-lines` | Whisper |
| `otlp-collector` | `radar` | Telemetry |
| language model (planned) | `cpu` | reserved |
| `text-to-speech` (planned) | `volume-2` | reserved |

- Roles come from Core's confirmed roles, not from what a manifest requests.
- Role icons are ink on mist in a 20 px chip; the app's accent stays on its mark.
- Rows show icons only, with "Provides: …" as tooltip and accessible label; app details show icon
  and name. At most three icons, then `+N`; an app without roles shows none.
- Lifecycle warnings speak in roles: "Stopping Harness leaves the host without an assistant."

## Components

ReUI components unchanged, dressed by tokens. Controls are 36 px tall (32 small, 40 large; 44 px
touch targets on phones) with an 8 px radius; popovers use 10 px and cards 14 px. Borders separate;
shadows only lift what floats. Disabled is 45% opacity. Dark mode lifts surfaces with a lighter fill
rather than a shadow.

- **Buttons.** The primary button is ink with white text, near-white with ink text in dark. Default
  and outline buttons turn lime with ink text on hover and press; on touch, press stands in for
  hover. Danger stays red and darkens on hover.
- **Focus.** A 3 px lime ring that always sits against an ink edge, so the indicator keeps 3:1 even
  though lime on white is only 1.5:1: inputs take an ink border on focus (lime in dark), the ink
  primary button carries the ring directly on its edge, and on light surfaces every other focus
  indicator without an ink edge — outline and ghost buttons, sidebar and top-strip items, dialog
  controls, resize handles — first takes a 2 px ink ring with the lime halo outside it.
- **Selection.** Checked checkboxes and switches are lime with an ink check or knob; text selection is
  lime with ink text. Menu items, ghost hover and active navigation highlight in lime soft with ink
  text; a selected table row takes a lime wash, and a selected tab a 3 px underline in lime strong on
  light (3.2:1 on Mist) and lime on dark.
- **Progress.** Progress bars fill with lime on a neutral track (`#EEF2F7`, dark `#26364F`) in both
  themes; the label next to the bar carries the value.
- **Links.** Info blue, underlined.

## Tokens

ReUI reads the standard shadcn CSS variables, so the theme is a values swap in `globals.css`. Note that
shadcn's `--accent` is the hover and highlight background — here lime soft — and `--primary` is the
ink action color; lime itself is the Hosty addition `--brand`.

| Variable | Light (`:root`) | Dark (`.dark`) |
| --- | --- | --- |
| `--background` | `#F6F8FB` | `#0F1B2D` |
| `--foreground` | `#0F1B2D` | `#F1F5FA` |
| `--card` | `#FFFFFF` | `#17253B` |
| `--card-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--popover` | `#FFFFFF` | `#1C2B44` |
| `--popover-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--primary` | `#0F1B2D` | `#F1F5FA` |
| `--primary-foreground` | `#FFFFFF` | `#0F1B2D` |
| `--secondary` | `#EEF2F7` | `#26364F` |
| `--secondary-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--muted` | `#EEF2F7` | `#1C2B44` |
| `--muted-foreground` | `#5A6A82` | `#93A3BA` |
| `--accent` | `#ECFCCB` | `#273B2E` |
| `--accent-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--destructive` | `#D93036` | `#D93036` |
| `--border` | `#DFE5EE` | `#26364F` |
| `--input` | `#C3CDDB` | `#2E3F5C` |
| `--ring` | `#A3E635` | `#A3E635` |
| `--sidebar` | `#F6F8FB` | `#0B1524` |
| `--sidebar-foreground` | `#3A4B66` | `#B8C4D6` |
| `--sidebar-accent` | `#ECFCCB` | `#273B2E` |
| `--sidebar-accent-foreground` | `#0F1B2D` | `#F1F5FA` |
| `--sidebar-border` | `#DFE5EE` | `#1A2A42` |
| `--chart-1` … `--chart-5` | `#1C68FF` `#7C3AED` `#C026D3` `#F59E0B` `#64748B` | `#4D8BFF` `#A78BFA` `#E879F9` `#FBBF24` `#94A3B8` |

Charts never use lime; it belongs to interaction. `--chart-1` is Hosty Blue in Shell's own charts; a
first-party app overrides it inside its own frame — strong shade on light, accent on dark — so there is one
first-series token, not two. A later colored chart token (`--chart-2` to `--chart-4`; the slate
`--chart-5` is neutral and never swaps) that sits within 20° of the app's accent takes the displaced
Hosty Blue instead, so no two series match: Telemetry swaps with `--chart-2`, Demo App with
`--chart-3`, Harness and Marketplace with `--chart-4`. Plans' accent is itself blue, so it simply
replaces Hosty Blue and nothing is displaced.

Hosty additions:

| Variable | Light | Dark |
| --- | --- | --- |
| `--brand` / `--brand-foreground` | `#A3E635` / `#0F1B2D` | `#A3E635` / `#0F1B2D` |
| `--brand-strong` | `#5A9A0A` | `#A3E635` |
| `--success` / `--success-soft` / `--success-text` | `#16A34A` / `#E8F7EE` / `#0F6B33` | `#22C55E` / success at 16% / `#4ADE80` |
| `--warning` / `--warning-text` | `#F59E0B` / `#8A5300` | `#F59E0B` / `#FBBF24` |
| `--info` / `--info-text` | `#1C68FF` / `#1449C2` | `#4D8BFF` / `#8DB4FF` |
| `--destructive-soft` / `--destructive-text` | `#FDECEC` / `#B4232A` | red at 18% / `#FF8A8E` |

```css
@theme inline {
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --color-brand: var(--brand);
  --color-brand-foreground: var(--brand-foreground);
  --color-brand-strong: var(--brand-strong);
  --color-success-soft: var(--success-soft);
  --color-success-text: var(--success-text);
  /* warning, info and destructive the same way */
}
```

Default and outline buttons use `hover:bg-brand hover:text-brand-foreground` instead of
`hover:bg-primary/90`. Anything that uses `primary` as a foreground — `text-primary`,
`border-primary`, a small `bg-primary` dot — moves to `--brand-strong` or Info blue, because ink there
would read as body text and lime fails on light. In Shell today that is the Button `link` variant,
`field.tsx` (checked choice border and link hover), the Cloudflare connection card link, and two
indicator dots.

Radius: `--radius: 0.625rem` (sm 6, md 8, lg 10, xl 14). Spacing on a 4 px base: 4, 8, 12, 16, 20,
24, 32, 40, 48. Elevation: card `0 1px 2px` at 6% ink, dropdown `0 4px 14px -4px` at 16%, dialog
`0 14px 34px -8px` at 24%.

## Motif and motion

- **Cell field.** A 70 px grid of 22 px square cells, no wires, at most four colored cells — app
  colors, lime for the platform, Info blue for what works; backdrop for headers, onboarding and empty
  states.
- **Loader.** Lime travels the H cell by cell: down the left column, through the Core, up the right.
  The loader is the mark in motion, so its cells light in the mark's lime; on light surfaces each lit
  cell keeps a lime-strong `#5A9A0A` edge so the shape holds 3:1, and on dark it is plain lime.
  Status dots, labels and rings for the working state stay Info blue.
- **Empty state.** In Shell, dashed cells are slots waiting to be filled and the lime cell in the Core
  spot is the action. Inside an app, the empty state shows the app's own mark with its accent cell
  lit, as identity, and keeps the action as an ordinary button. One sentence of help, one primary
  button.
- **Motion.** Hover and press 120 ms ease-out, color only. Menus 150 ms fade plus 4 px. Panels and
  sheets 220 ms `cubic-bezier(.2,.8,.2,1)`. Toasts 240 ms in, 160 ms out. The working pulse loops
  at 1.6 s, in Info blue, and only on working states. `prefers-reduced-motion` keeps fades and stops movement and loops;
  the working dot then keeps a static outer ring so it still differs from a plain dot.
- **Avoid.** Gradient washes and glows, frosted glass, 3D or stock illustration, emoji as icons.

## Shell layout

### Dashboard

- No visible column-header row. Each row: tile, name followed by its provider role icons, and
  version · runtime on a second line; status; resources as one line (`7.8% · 412 MB`); actions.
- An available update shows in the version, not as an icon: `0.6.1 → 0.7.0` with the new version in
  Info blue. The Update action stays with the row's actions on the right.
- Status shows only a dot while running; a label appears only off-normal (Updating 64%, Degraded,
  Stopped), plus the hand icon for manual start.
- Actions: More (⋯) always; one contextual action when needed (Start, Update, Logs, Configure);
  Restart and Logs appear on hover or focus.
- Core is the first row with the platform's ink tile; listen address, public origin, ingress, data root
  and runtime host expand under it. App rows expand into per-service status, endpoint and resources.
- Header: filters as text toggles with counts (All, Running, In progress, Attention, Updates), the
  aggregate resources with a sparkline, search, Check updates and the single primary Install app.
- Compact layout, selected by the page's own width: list rows, filters in a menu, icon-only Install,
  resources hidden until a row expands.

### Data-grid pages

Table pages share one pattern, built on ReUI Data Grid (TanStack Table): a toolbar with search,
status filters with counts, dashed facet filters, a density toggle (48 / 36 px rows), a column chooser
and one primary action; sortable headers with an arrow on the active column; checkbox selection with a
select-all mixed state and a floating ink bulk-action bar at the bottom; mono for IDs and dates; status
as dot and text; inactive rows in muted text, never lighter than `#5A6A82`; row actions on hover; a
footer with count, rows per page and pagination.

### Tools at every width

There is no permanent right rail. The assistant has a top-strip button with a status dot; every other
`ui.panels` tool is listed in one Tools menu.

**Hide is not close.** The panel header carries Open separately and Hide. Hide, the top-strip button
and switching tools keep every opened tool mounted with its frame, unsent draft, scroll position and
selected conversation, as Shell does today on collapse. Ending a tool instance is a separate action in
the tool's own menu. The same state survives every layout change: dock to sheet, sheet to phone,
rotation and back.

**The fit rule.** Layout follows what still fits in Shell's own width, so a window beside an agent
behaves like a tablet. Each page has a minimum width — Dashboard 440 px in its compact layout,
Settings and embedded apps 560 px — and the tool panel needs at least 320 px (360 px by default).

| When this fits | Navigation | Page | Tool |
| --- | --- | --- | --- |
| Full navigation + page minimum + tool | Full | Full | Docked, resizable |
| Icon rail + page minimum + tool minimum | Icon rail while a tool is open | Compact layout | Docked |
| Not even that | Icon rail or menu button | Keeps its layout | Sheet over the page, ≥ 320 px |
| Shell narrower than 600 px | Bottom tab bar | Full width | Bottom sheet |

So a 900 px window docks the assistant beside the Dashboard (56 + 440 + 320 px fit) but slides it over
Settings (56 + 560 + 320 px do not).

**Activity.** Each tool reports one state — idle, working, needs you or failed — with an optional
count and label. Reports travel through Core, never only through the tool's frame, so a tool that was
never opened on this device, and a phone, still see them:

- **Identity.** One report per user and tool: the Core user id plus the panel reference the SDK
  already uses (app id, installation id, panel id). A reinstall starts empty; an app may report only
  for users assigned to it, as with notifications.
- **Producer.** The app posts with its service credential to a Core internal endpoint for its own
  panels; the SDK wraps it in a server helper.
- **Freshness.** Working is presence: it expires after the report's time-to-live (60 s by default,
  at most 300 s) unless renewed, and then reads as idle. Needs you and failed stay until the app
  replaces or clears them, or the installation goes away. Core keeps reports in memory; after a Core
  restart apps re-report on reconnect, and the SDK helper resends the current state.
- **Delivery.** Core publishes a `tool.activity.changed` hint on the existing event bus; Shell
  re-reads the user's activity list, following the bus's hint-not-fact contract.
- **No connection.** When Core's readiness reports the providing service as stopped or unreachable,
  the tool shows "no connection" with the time of its last report instead of its last known state.
- **Aggregation.** Shell sums the states by priority: failed, then needs you, then working, so a
  decision is never hidden behind another tool's background work.
- **First provider.** Harness: needs you with a count while approvals are pending, working while a
  run executes, failed when a run fails.

### Phone

- A bottom tab bar holds Dashboard, Apps, Tools and Settings; notifications stay in the top bar.
- App rows keep the runtime status first and append an update after it — "● Running · 0.6.1 →
  0.7.0" — so an available update never hides whether the app is running.
- Tools opens the last-used tool as a sheet above the tab bar; tapping Tools again hides it.
- The sheet header always shows the tool's name, an **All tools** button and Hide.
- All tools groups tools as Needs you, Working, No connection, then a four-column grid of every tool
  with search and Edit (pin and reorder).
- The Tools tab carries a count of tools that need the user, colored by the most severe (red for a
  failure, amber for a decision); with nothing to decide the tab carries no badge, and working tools
  show their pulse in the list.
- With the keyboard open the tab bar gives way and Shell sizes the sheet and the tool frame to the
  visible viewport above the keyboard.
- Everything inside the frame belongs to the tool. For the assistant, Harness owns the approval
  content, pins a pending decision under its own header with a Review action however long the
  conversation, and keeps its composer at the bottom of the frame. Shell owns only the sheet, its
  header, its heights and Hide.

## Interactions With Existing Features

Implementing this plan changes documented behavior; each owning `feature.md` follows in the same PR as
the deliverable that changes it.

- [Resizable Shell Panel](../shell-panel-resize/feature.md) and
  [App UI Surfaces](../app-ui-surfaces/feature.md) describe a 48 px right rail whose selected icon
  collapses the panel, headers with only Open separately, and a drawer below 900 px of workspace
  width. D11 and D12 replace the rail with the top-strip launcher, add Hide, and replace the fixed
  breakpoint with the fit rule. Their retained-frame behavior is kept and extended to the phone.
- [SDK UI Composition](../sdk-ui-composition/feature.md) and
  [SDK Panel System](../sdk-panel-system/feature.md) let a child hide the tool launcher or disable
  tools; today that hides the rail and the top-strip toggle. The new Assistant button and Tools menu
  must honor the same negotiation. The SDK reports surface readiness and attention but has no shared
  "working" state; D15 adds the activity contract.
- [Shell Navigation](../shell-navigation/feature.md) switches to a 60 px rail below 768 px with a
  top-bar toggle and marks system apps with a badge in the sidebar. D12 and D13 replace the phone
  behavior with the tab bar, and the design removes the System badge everywhere, in line with the
  move away from a system/ordinary split.
- [Replaceable UI Clients](../replaceable-ui-clients/plan.md) D8 owns showing confirmed role badges
  from Core facts for all installed apps. This plan supplies only the role icon set and the chip
  (D18); D8 decides where role data comes from and when it appears.
- [Core App Shell](../core-app-shell/feature.md) documents the dashboard table and a sky-colored
  spinner for transitions; D6 and D7 change both.
- [Core Event Bus](../core-event-bus/feature.md) gains a `tool.activity.changed` event; its
  hint-not-fact contract is unchanged.
- [Notifications](../notifications/feature.md) remain the durable channel; a tool activity state is
  live presence, not a notification. [Shell Operation Feedback](../shell-operation-feedback/feature.md)
  keeps its placement.
- [Assistant Entry Points](../assistant-entry-points/feature.md) and
  [Assistant Approval Rules](../assistant-approval-rules/feature.md) stay owned by Harness; D17 adds
  the pinned pending decision inside Harness's own panel UI and makes Harness the first activity
  provider.

## Deliverables

### Phase 1 — Foundations

- [ ] D1. Replace Shell's neutral shadcn values in `apps/shell/src/app/globals.css` with the light and dark tokens above — the ink primary, the lime brand and lime soft accent, and the three-tone status tokens — and give buttons, inputs, checkboxes, switches, tabs (the line variant in `components/ui/tabs.tsx`), selected table rows (`components/ui/table.tsx`, today `bg-muted`), document-wide text selection (`::selection` in `globals.css`, not only in `input.tsx`) and progress bars the lime hover, focus, selection and progress states described under Components, with the ink-edge focus treatment applied to every `--ring` consumer in Shell (16 components today, including `shell-top-strip.tsx`, `shell-sidebar.tsx`, `ui/dialog.tsx` and `ui/resizable.tsx`).
- [ ] D2. Load IBM Plex Sans and JetBrains Mono in Shell for `--font-sans` and `--font-mono`, and self-host the same WOFF2 files for Core's own pages: embed them with Core's other browser assets and serve them from one same-origin route, declare `@font-face` on the login page, in the account stylesheet (`Browser/account.css`) and on the installation-approval pages, and add `font-src 'self'` to the page CSPs that start from `default-src 'none'` (`CoreAccountEndpoints.cs`, `InstallationApprovalEndpoints.cs`), which otherwise reject the files — with the Shell and platform version bumps.
- [ ] D3. Replace the H-graph with the grid mark in `assets/hosty-brand` — light, dark, the ink-tile app icon and the favicon cut — outline the wordmark in IBM Plex Sans 600, regenerate the lockups and app icons with `build-assets.mjs` — which also rewrites Shell's public icons and the `apps/shell-swift` AppIcon set, so both ship with version bumps (`MARKETING_VERSION` for the Swift client) — redraw the hand-coded copies of the mark in Shell's `chrome/brand-mark.tsx` and the SDK's `overlay-react.tsx` (with an `@hosty-sdk/app` version bump), and record the ink scale, lime brand and status colors in `brand-tokens.json` and the brand README.
- [ ] D4. Redraw every first-party app icon as its cell mark on the ink tile — Shell S, Plans P, Telemetry T, Harness A, Whisper V, Marketplace M, Workspaces W, Demo App D (whose `icon.svg` still draws the retired H-graph) — replacing each `apps/<app>/assets/icon.svg` and `apps/workspaces/public/icon.svg`, adding one for Whisper and pointing its manifest's `catalogMetadata.icon` at it (Core builds `iconUrl` only from that field), with each app's version bump; then apply the accents as described under App accents: Shell draws each app's 3 px frame strip and tool badges from its accent, sourced as the open question settles, and each embedded first-party app other than Shell, whose own charts keep Hosty Blue, sets `--chart-1` to its accent's strong shade on light and its accent on dark for its own charts, swapping the displaced Hosty Blue into the later series it collides with as the Tokens section lists (Telemetry `--chart-2`, Demo App `--chart-3`, Harness and Marketplace `--chart-4`), and shows its mark, accent cell lit, in its own empty states. Because Shell's `AppIcon` shows `iconUrl` as an `<img>`, which cannot follow Shell's own theme class, Shell draws first-party marks inline from the cell map instead, painting the tile `#0F1B2D` in light and `#22324B` in dark; every other consumer — Marketplace's storefront, Harness's context icons, the OS — keeps the baked ink-tile `icon.svg` in both themes and, in dark mode, sets it on a card surface (`#17253B` or lighter) so the tile still separates by a tone.
- [ ] D5. Ship the Telemetry and Demo App navigation icons in `currentColor` instead of hard-coded colors.
- [ ] D6. Use the four status meanings across Shell — info blue, needs you amber (including pending approvals), failed red, working as an Info-blue pulse or ring with a label and a lime progress bar (replacing the sky spinner) — and keep lime out of charts.
- [ ] D16. Contrast pass on Shell: no text lighter than `#5A6A82` on light surfaces, `#6E7F98` and `#93A3BA` only for icons and disabled states, no `primary`-colored text, borders or dots (they move to `--brand-strong` or Info blue), and every state except the normal running dot carrying a label or its own shape, including the static ring for working under reduced motion.
- [ ] D19. Carry the tokens into every embedded first-party app with a web UI — Plans, Workspaces, Telemetry UI, Demo App, Marketplace and the Harness web UI (Whisper has none): replace the neutral shadcn values in each app's `src/app/globals.css` (`apps/harness/web/src/app/globals.css` for Harness; Plans still ships neutral hover and selection colors) with the light and dark tokens above, keeping the app's `--chart-1` override from D4; give the app's buttons, inputs, checkboxes, switches, tabs, selected rows, `::selection` and progress bars the same lime hover, focus, selection and progress states as D1, with the ink-edge focus treatment on every `--ring` consumer; and load IBM Plex Sans and JetBrains Mono for its `--font-sans` and `--font-mono` — with each app's version bump.

### Phase 2 — Shell pages

- [ ] D7. Rework the Dashboard rows as described under Dashboard: no header row, role icons instead of the System badge, version and runtime under the name with an available update as `current → new`, status label only off-normal, single-line resources, hover actions plus one contextual action.
- [ ] D8. Add the Dashboard compact layout, selected by container width.
- [ ] D9. Build the data-grid page pattern on ReUI Data Grid and apply it first to Settings › Security › Access tokens.
- [ ] D10. Replace generic loaders and empty states with the grid-mark loader and cell empty states.
- [ ] D18. Add the provider role icon set and its chip (icon-only in rows, icon and name in app details) for `ui-client`, `assistant`, `speech-to-text` and `otlp-collector`, with the reserved icons for planned roles, and remove every "System" label from Shell.

### Phase 3 — Tools and small screens

- [ ] D11. Replace the permanent right tool rail with the top-strip Assistant button and Tools menu; panel headers get Open separately and Hide, which keeps frames, drafts, scroll and the selected conversation, while ending a tool instance moves to the tool's menu.
- [ ] D12. Apply the fit rule with page minimums (Dashboard 440 px, Settings and embedded apps 560 px) and a 320 px tool minimum: navigation folds to its rail first, then the tool becomes a sheet over the page; drafts, scroll and the selected conversation survive every dock, sheet and phone transition.
- [ ] D13. Add the phone layout below 600 px: bottom tab bar, last-tool sheet that a second tap hides, an always-visible All tools button, the grouped tool list with search, the Tools badge, and a sheet and frame sized to the visible viewport while the keyboard is open.
- [ ] D14. Show tools everywhere with their Lucide icon and the owning app's color badge.
- [ ] D15. Build the tool activity contract through Core as described under Activity: per-user reports keyed by the panel reference, an app-authenticated internal endpoint with an SDK server helper, time-to-live for working, re-reporting after a Core restart, a `tool.activity.changed` bus hint, "no connection" from Core readiness, and Shell's priority aggregation.
- [ ] D17. In Harness, pin a pending approval under its panel header with a Review action, keep its composer at the bottom of its frame on phones, and report its activity through D15 as the first provider.

## Open Questions

- The page minimums: are Dashboard 440 px and Settings 560 px right, and may an embedded app declare
  its own minimum in its manifest instead of the 560 px default?
- Is ⌘J the assistant shortcut?
- May a user pin one tool as a fifth phone tab?
- Where does Shell read an app's accent for the frame strip and tool badges — a manifest field
  limited to the fixed palette, or a table Shell keeps for first-party apps?

## Verification

- `node scripts/docs-index.mjs --check` passes.
- Per deliverable: Shell lint, type-check build and tests; affected app and SDK builds; version bumps
  per AGENTS.md for every shipped artifact.
- Lime never appears as text, an icon or a hairline on a light surface; every lime fill there carries
  ink or a lime-strong edge (progress bars excepted, whose label carries the value, and the lit cells of
  the Hosty and app marks, which as logos are exempt from contrast minimums).
- Contrast checks for every text and status token pair in light and dark, and every state checked
  with `prefers-reduced-motion` and in grayscale to confirm it differs by more than color.
- Activity: a pending Harness approval reaches the Tools badge on a second device that never opened
  the assistant, survives another tool's background work, comes back after a Core restart, and turns
  into "no connection" when Harness stops.
- Browser checks through Core-managed Shell in light and dark at both sides of every layout switch:
  599/600 px, and the widths where each page's minimum plus the tool minimum stops fitting with the
  full sidebar and with the rail (for the Dashboard and Settings). No overlap between navigation, page
  and tool at any width.
- Phone checks on iOS Safari and Android Chrome: keyboard open with a long conversation, a pending
  decision while another tool works, 16 or more tools, rotation, and a hidden tool keeping its draft
  across dock, sheet and phone transitions.

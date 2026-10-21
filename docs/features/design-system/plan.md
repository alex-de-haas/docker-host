---
status: Draft
created: 2026-10-12
updated: 2026-10-21
summary: Hosty's visual language — ink acts, lime answers — with color, type, mark and ReUI token rules, the Shell pages built from it, and the Harness development and review pages.
components: [apps/shell, apps/shell-swift, packages/app-sdk, apps/core, apps/harness, assets/hosty-brand, apps/plans, apps/telemetry, apps/telemetry-ui, apps/demo-app, apps/marketplace, apps/whisper]
---

# Design System

## Goal

Give Hosty one visual language that reads as calm and corporate without being grey and gloomy,
and apply it to Shell. Chrome stays ink and white; color is spent on what is alive on a host — app
tiles, status and data. The same rules must hold from a wide desktop to a Shell window squeezed
beside an agent and to a phone.

## Incremental Adoption And Functional Parity (Owner Direction, 2026-10-13)

The owner is still refining the visual references. Apply finished foundations first: colors,
typography, logos/icons and common styling. Then adopt prepared Shell layouts and extend their
patterns to screens without a dedicated reference. This is a sequence proposal, not a one-session
implementation estimate or approval of unresolved interactions.

Mockups describe appearance and may omit existing actions or states. Inventory the current
functionality before replacing a screen; every supported action remains reachable, along with
permissions, navigation, forms, drafts, selection, panel state and failure/recovery behavior.
Absence from a mockup does not authorize removal. If placement is unspecified, retain the existing
control with compatible styling or propose its new location explicitly. Functional regression
blocks that screen's replacement even when the visual match is better.

The [November milestone](../hosty-delivery-readiness/plan.md) prioritizes the working development
journey. Foundation styling can proceed independently once approved; layout/activity changes need
their own full verification. Existing deliverables remain outstanding, and D20 tracks the parity inventory
and acceptance. Partial adoption does not mark the entire design plan complete.

## Core And Settings Coordination (Owner Direction, 2026-10-20)

The supplied Hosty Style Guide HTML adds Core authentication, installation, update,
permission and outcome artboards. The narrow approved adoption is tracked in
[Core confirmation design](../core-confirmation-design/feature.md); it does not approve
this whole Draft. That feature owns the local Core fonts, trusted form palette,
brand mark and responsive card styling. Shell foundations remain outstanding here; compact Core credential actions also use the shared forms.

[Settings experience](../settings-experience/feature.md) owns the implemented destination
inventory and protected settings workflow. The access-token grid in this design is
a visual example: current-user tokens belong to My profile; authorized support
actions for another user belong in that user's detail. Do not create a competing
global token destination or a Shell-wide Assistant access tab.

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
| `HarnessPage`, `HarnessReview` | Harness development page; its review page for session changes and open pull requests |
| `HarnessPhoneList`, `HarnessPhoneChat` | Harness on a phone: sessions, and the conversation with the workspace sheet |
| `EnvSetup` | Core first-run page: choose apps, install with retry, create the administrator, open Hosty |
| `Marketplace`, `Settings`, `AppManage` | Marketplace catalog and installed apps; Shell settings; managing one app |

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

Color never carries a state alone. Where a row has room, every state carries its name, running
included, as the Dashboard does. Where it does not — compact rows, navigation, tool badges — the
normal state, running and healthy, is a bare dot with its name in the tooltip and accessible label,
and every other state keeps a text label or, failing that, its own shape: a diamond for "needs you", an alert icon
for "failed", a hollow ring for "no connection", and for "working" a pulse that becomes a static outer
ring when motion is reduced. No two states differ by color alone: working shares Info's blue and is
told apart by its motion and label.

### App accents

Each first-party app has one accent. It is identity only: the lit cell of the app's mark, a 3 px
strip on the app's own frame and the corner badge on its tools — both in the strong shade on light
surfaces and the accent itself on dark, since no base accent reaches 3:1 on white or Mist — the first series of the app's own charts (the app sets `--chart-1` to
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
  accent as a small corner badge — its strong shade on light, the accent on dark.

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

Owner direction, 2026-10-21, from the `Shell` artboard. The installed-apps table in
[Core App Shell](../core-app-shell/feature.md) is the functional baseline (D20 applies).

- No visible column-header row. Core's row and every app row use the same fixed columns — identity
  (flexible), state (188 px), resources (144 px) and actions (136 px) — so values line up down the
  page.
- **Identity:** tile, name followed by its provider role icons, and version · runtime on a second
  line. An available update shows in the version, not as an icon: `0.6.1 → 0.7.0` with the new
  version in Info blue. An app that does not start with the host adds "Manual start" to that line,
  with a tooltip saying where to turn autostart back on; automatic start, the usual case, is not
  marked. This replaces the hand icon beside the status.
- **State:** the state's name always shows in its status color — Running, Updating, Degraded,
  Stopped — after its dot or shape. A second, muted line carries the detail when there is one —
  "Pulling image · 64%", "Gateway health check failing since 10:42", "Stopped by you · 09:12" —
  wrapping to at most two lines, with the full text in the tooltip. The detail composes lifecycle
  and health as the feature's tooltip does today.
- **Resources:** two lines, CPU and RAM, each with its value and a sparkline of the last 15 minutes,
  CPU in `--chart-1` and RAM in `--chart-2`; a stopped app shows a dash. One accessible label reads
  both values.
- **Actions:** at most one contextual action (Start, Update, Logs, Configure), at most 104 px wide and
  truncated with its full name in the tooltip, then More (⋯), which holds Restart, Logs and the rest.
  Nothing appears on hover, so a long label never shifts the columns.
- **All apps row:** the apps table starts with a row in the same columns. Search sits at its left
  and opens into a field in place of the title, filtering the rows together with the state filters;
  the count reads "8", or "3 of 8" while filtered; the aggregate CPU and RAM with their sparklines
  sit directly above the rows' resources. Its state column stays empty, since the filters already
  count the states.
- **Core** is the first row of its own table with the platform's ink tile, its state ("Running ·
  Healthy · up 3 days") and its resources in the same columns; listen address, public origin, ingress,
  data root and runtime host expand under it. App rows expand into per-service status, endpoint and
  resources.
- **Header:** the Apps title, filters as text toggles with counts (All, Running, In progress,
  Attention, Updates) and the single primary Install app. The artboard no longer shows Check updates
  or Update all; both stay reachable with the feature's behavior — Update all (N) as the All apps
  row's contextual action when routine updates are available, and Check updates in that row's More
  menu.
- **Compact layout,** selected by the page's own width: list rows, filters in a menu, icon-only
  Install, resources hidden until a row expands. It takes over before the fixed columns would need
  horizontal scrolling, so the table never scrolls sideways, as today.

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

## Harness development page

Owner direction, 2026-10-20, from the `HarnessPage` and `HarnessReview` artboards. The
[Harness development UI](../harness-development-ui/feature.md) is the functional baseline: its
actions, states, ordering, recovery and authorization stay, and this section only changes how they
are presented (D20 applies). Where an artboard shows less than the feature does, the feature wins.

### Layout

The page fills Shell's main area inside the app frame, with Harness's 3 px accent strip. It needs
more width than an ordinary embedded app, so Shell's navigation folds to its icon rail first under
the fit rule. Three columns sit side by side and wrap into one column on narrow widths: sessions
(about 264 px), the conversation (takes the remaining width, its transcript and composer capped at
760 px) and the workspace (about 344 px). A conversation without a Core workspace has no workspace
column; the header's workspace toggle hides and shows it.

### Sessions

- A header with the count, **New session** and a search field.
- Filter chips — All, Needs you, Working, Failed — each with its count and the state's shape. They
  only filter; rows keep the feature's order by most recent activity, and a waiting session is not
  pinned above newer work.
- App groups carry the app's cell mark; Unassigned chats follow them. A row shows the title and one
  line of state: the state word in its status color and weight (needs you amber, working Info blue,
  failed red, idle and completed muted) followed by context such as the PR number or time. The
  state's shape sits at the row's end: a diamond, a pulse, the alert icon, or a muted check for
  completed. The selected row uses the lime soft fill.
- **External workspaces** becomes one row at the foot of the column, with its count, and opens the
  existing external view; its separation from synchronized conversations is unchanged.

### Conversation

- The header holds the session title with Rename, the context apps as mark chips with Add app, the
  workspace toggle and the session menu.
- A pending decision is pinned under the header — "Needs you · Allow `git push` to update #612" —
  with a Review action that scrolls to the card, however long the conversation, as D17 does for the
  panel. While the agent works the same place shows an Info-blue bar with the current step, the
  elapsed time and Stop.
- The transcript groups tool activity: reads collapse into one expandable line ("Read 3 files and 2
  review threads · 6 s"), edits list each file with its additions and deletions and open the review
  page at that file, and commands show their result in place: exit status, duration and at most
  one summary line ("14 passed · 4 s"), never the raw output.
- The approval card has an amber header, the exact command on an ink block, its repository, branch
  and effect, then Allow once (the view's primary action) and Deny…, which reveals an optional
  reason that is sent with the denial. The canvas also shows Allow for this session; that would be a
  new standing grant beyond today's one-time allow or deny, so it stays out until the open question
  below is settled.
- The composer keeps attachments, app mentions and Whisper dictation; its bottom row holds the
  provider and model and the Normal / Autonomous switch with a one-line explanation of the mode.

### Workspace

One column without tabs, top to bottom:

- **Header:** "Workspace", a neutral state chip (In progress, Paused, Completed), the observation
  line ("1 repository · watching · observed 12 s ago"), Refresh, and the menu with Complete, Pause,
  Resume and Delete as the feature defines them.
- **Repository card:** name and bound apps, the branch against its base, Ahead / Behind / Not pushed
  counts, **Session changes** with its additions, deletions and file count, which opens the review
  page, and Commit…, Push branch and Update PR with the remaining Git actions in a menu.
- **Pull requests:** described below.
- **Preview card:** the sandbox, its running dot and start time, the sandbox address, and a line —
  environment reused, time to ready, its own test users and data — that expands into the launch steps
  with their times. Open preview and Open test Core stay visible; Restart app, Service logs, Run a
  reviewed check and Stop sandbox move to its menu. Per-service rows, restart requirements and
  failures from the feature remain.
- **Used by:** the apps that run from this workspace, with Use on this Core.

### Pull requests

- Every PR of the workspace is a card that collapses on its header. Collapsed, it takes two lines:
  the status icon, the title and the number; then the state word for a draft or merged PR, the CI
  result in its color, and the threads — "Draft · CI passed · not ready for review", "CI 4 of 5 · 1
  running · 2 unresolved threads". Expanded, it adds the state and review chips, a segmented CI bar
  with the passed / in progress / skipped summary, notes such as an unpushed head, and Review changes
  for a PR that is still open or draft.
- The icon's shape names the PR state and its color names CI: an open PR's icon is green when every
  check passed, Info blue while checks run and red when one failed; a draft keeps the muted draft
  icon whatever its CI, and a merged PR the violet merge icon. Closed, unknown and stale states keep
  the feature's icons and neutral color. Green and red describe CI only; review decisions stay in the
  chips. Every icon has its accessible label, and the summary line repeats the state in words.
- The CI bar opens the check list by click only, never on hover, as a popover beside the workspace
  column so it covers neither the cards nor the preview; it closes on a second click or its close
  button and refreshes with new observations.

### Review page

The diff dialog becomes a page of its own. Session changes, an edited file in the transcript and
Review changes on a PR open it; the header's breadcrumb and **Back to session** return to the page
with the conversation, its draft and its scroll intact. It has three columns:

- **The session's conversation, narrowed:** the pinned decision, the latest messages and the
  composer, so the operator can answer the agent without leaving the review.
- **What to review:** a picker for Session changes, Since main and each open or draft PR of the
  workspace, the PRs with their status icon and summary line; merged and closed PRs open on GitHub.
  A PR shows its chips and a GitHub link. Below the picker are the totals, the viewed count and the
  file list with additions, deletions, comment threads and a viewed check.
- **The diff:** the file path, its counts, Viewed, previous and next file. The feature's renderer,
  Unified / Split and wrapping stay. Lines that are not yet in the PR head carry a muted stripe.

Review actions:

- **Threads in place.** For a PR, its review threads appear under their lines — from agents such as
  Codex and from people — with the author, whether the author is an agent or a reviewer, the time and
  the replies, a state chip (Unresolved in amber, Addressed but not pushed in Info blue) and Reply,
  Resolve and Ask Harness.
- **Select lines.** A click on a line number selects it and a second click or Shift+click extends the
  selection; the numbers fill lime. The selection offers **Ask Harness**, which places a reference to
  those lines — file, line range, source and revision — in the narrow composer, and **Comment on
  #N**, which opens a comment box with "Also ask Harness to address it" and posts the comment to the
  PR on GitHub. Lines not in the PR head cannot take a GitHub comment; the bar says to push first or
  to ask Harness.

### Harness on a phone

- The sessions list fills the screen with the same filters and groups, above the bottom tab bar.
- A conversation keeps its pinned decision and its composer above the tab bar; Workspace opens the
  workspace as a bottom sheet over it. The sheet has no tabs: Session changes lists the files inside
  the sheet with a back button, each file opens as its own page, and the CI bar expands its check
  list in place on a tap.

## Environment, Marketplace, settings and app management

Owner direction, 2026-10-21, from the `EnvSetup`, `Marketplace`, `Settings` and `AppManage`
artboards. The owning features stay the functional baseline (D20 applies); the artboards show less
than those features do, and where they differ the feature wins unless a deliverable below changes it.

### Creating the environment

A Core page — Core's own stylesheet, no component library — for a brand-new data root, in four steps
shown as a progress strip:

1. **Choose apps.** The distribution catalog's entries, each with its mark, name and one-line
   description and a lime checkbox. Entries start checked as the catalog's `defaultEnabled` says;
   Shell carries "Recommended" because without a UI client the host is managed only from the CLI.
   Nothing checked is allowed: Core keeps working. The primary action names the count ("Install 4
   apps").
2. **Install.** A lime progress bar with "3 of 4 ready · 1 failed" and one row per app with its state
   and detail — Ready with its time, Starting with its step, Queued, Failed. A failed row shows the
   cause in the danger soft panel with Retry and Show log; Continue without it skips that app.
   The next step waits until every remaining app is ready. Leaving the page does not stop the
   installation.
3. **Administrator.** The existing first-administrator form: email, display name, password, confirm.
4. **Open.** The installed apps as chips, a note for any skipped app saying where to install it
   later, the host's address and Open Hosty.

The page is part of first setup: it uses the setup authority `/setup` uses today, it is unavailable
once an enabled administrator exists, and later changes go through Marketplace or `hosty setup`.

### Marketplace

Inside Shell's frame with Marketplace's accent strip:

- A header with the catalog source and a search field over names, publishers, summaries and
  categories; Discover and Installed tabs with counts.
- **Discover:** category chips (All, Productivity, Media, Monitoring, Home) and a grid of cards —
  the app's own icon, name, publisher, summary, category, and Installed or the available update.
- **App card:** beside the grid, the selected app's icon, name and signer, its category, version and
  footprint, Install (or Update and Manage when installed), screenshots, description, and the
  permissions it will ask for in plain words, ending with the note that Core confirms runtime,
  startup and permissions on its own page.
- **Install** opens the shared SDK install dialog: feed and manifest checked, defaults prepared,
  waiting for confirmation, and Continue in Core to the existing confirmation page.
- **Installed:** every app on the host, wherever it came from — version, source (catalog or Hosty
  distribution), an available update, Open and Manage.

### Settings

Settings keeps its own navigation inside the page, so Shell's sidebar holds a single Settings entry:

- **You:** My profile — Profile, Connections, Tokens & devices.
- **Host:** Host — Updates, Network, Shared folders, Core source; Users & security — Users, App
  permissions, Policies; Shell — preferences such as theme, the Assistant button and the start page.
- **Apps:** one **App settings** entry with the count of installed apps. It lists every app with
  Settings, for the app's own `ui.settings` page, and Manage. Individual apps no longer appear in the
  settings navigation, which kept growing with every install. The Dashboard row menu still opens an
  app's settings and Manage directly.

Each destination has a title, a one-line description and line tabs (lime strong underline). Rows
use the field pattern — label column, value with a muted note, one action — and lists use bordered
row groups. Protected changes keep the feature's Core confirmation and say so in place.

### Managing an app

Addressed from App settings, with a breadcrumb back to Settings and App settings. The header holds
the mark, name, version and runtime, the state name with its detail, and Open app, Restart, Stop and
More. Tabs:

- **Launch:** Start with host (the same setting as the Dashboard menu), the runtime with a link to
  the Dashboard where it is switched, what the app starts after, and its services with state and
  resources.
- **Parameters:** the manifest's typed parameters with units and notes, secrets as masked values
  with Replace, and Save with the note that saving restarts the services.
- **Folders:** the data folder with its size and backup inclusion, and the folders the app asks for —
  attached with path and access, or optional and unattached with Choose folder — noting that attached
  folders are never backed up or deleted.
- **Network:** each endpoint with its protocol, local address and public address, internal endpoints
  with Add public address, pinned ports with Reassign, and the app origin.
- **Permissions:** granted Core permissions in plain words, confirmed provider roles, and Review
  permissions, which opens Core's review page.
- **Updates:** an available update as an Info panel with its class, permission change and size, and
  Update; what changed; the installed version and feed with Check now; the update policy; and the
  source with Use a source checkout.
- **Backups:** what backups cover, Create backup, the list with Restore, Download and More, and the
  retention period.

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
  spinner for transitions; D6 and D7 change both. D7 also replaces its status-only indicator with the
  state name and detail, the hand icon for manual start with "Manual start" text, the hover row
  shortcuts with the More menu, and its header's Check updates and Update all with the All apps
  row. [Shell Navigation](../shell-navigation/feature.md) documents those header icon buttons, the
  actions column and their collapse below 1240 px; it follows D7.
- [Core Event Bus](../core-event-bus/feature.md) gains a `tool.activity.changed` event; its
  hint-not-fact contract is unchanged.
- [Notifications](../notifications/feature.md) remain the durable channel; a tool activity state is
  live presence, not a notification. [Shell Operation Feedback](../shell-operation-feedback/feature.md)
  keeps its placement.
- [Assistant Entry Points](../assistant-entry-points/feature.md) and
  [Assistant Approval Rules](../assistant-approval-rules/feature.md) stay owned by Harness; D17 adds
  the pinned pending decision inside Harness's own panel UI and makes Harness the first activity
  provider.
- [Harness Development UI](../harness-development-ui/feature.md) documents the page D21–D26 restyle.
  Three of its documented behaviors change: an open PR's CI shows as a colored dot on the icon with
  amber for pending checks, where D22 colors the icon itself and uses Info blue for checks in
  progress, since amber means needs you; diffs open in a dialog, which D23 replaces with the review
  page; and external workspaces have their own tab, which D21 turns into a row in the sessions
  column. Its session order by most recent activity, with waiting sessions not pinned, is kept.
- [Assistant PR Lifecycle](../assistant-pr-lifecycle/feature.md) already observes review threads
  with their IDs, paths, lines and bounded comment text, and owns thread resolution. D24 extends that
  observation with each comment's author, author kind and time and shows the threads in the review page; D25 adds a new Core operation for posting a review comment or reply
  through the PR's selected GitHub connection, which that feature documents when it ships.
- [Delivery Readiness](../hosty-delivery-readiness/plan.md) keeps its priorities: D21–D26 follow its
  incremental-redesign rule and are not demo gates unless the owner promotes them there.
- [Removable System Apps](../removable-system-apps/feature.md) seeds a brand-new host once from the
  catalog's `defaultEnabled` entries with no page, and retries owed entries silently on a later boot;
  [CLI Bootstrap](../cli-bootstrap/feature.md) offers the same choice as `hosty setup`. D27 adds the
  first-run page: the choice replaces automatic seeding for a host set up in the browser, and Retry
  makes the existing owed-entry retry visible. The seed marker and its `pending` list keep their
  meaning. [Local Password Login](../local-password-login/feature.md) supplies the setup authority.
- [Runtime App Marketplace](../runtime-app-marketplace/feature.md) shows installed badges from
  Core's installed-state API; D28 adds the Installed tab from the same API.
  [App Installation SDK](../app-installation-sdk/feature.md) keeps its dialog and Core confirmation.
- [Settings Experience](../settings-experience/feature.md) gives every installed application its own
  settings destination and groups Manage application into Launch (autostart and typed parameters),
  Permissions, Network, Folders, Source & updates and Backups. D29 collapses the applications into the
  single App settings entry; D30 splits Parameters out of Launch and folds the source into Updates.
  Its protected-change reviews, ownership and addressable `manage:<app-id>` route are unchanged.
- [External Mounts](../external-mounts/feature.md), [Automatic Runtime App Ports](../automatic-runtime-app-ports/feature.md),
  [App Permission Management](../app-permission-management/feature.md),
  [Runtime App Update](../runtime-app-update/feature.md) and
  [App Data Backup Retention](../app-data-backup-retention/feature.md) own the behavior behind
  D30's Folders, Network, Permissions, Updates and Backups tabs; D30 changes only their presentation.

## Deliverables

### Phase 1 — Foundations

- [ ] D1. Replace Shell's neutral shadcn values in `apps/shell/src/app/globals.css` with the light and dark tokens above — the ink primary, the lime brand and lime soft accent, and the three-tone status tokens — and give buttons, inputs, checkboxes, switches, tabs (the line variant in `components/ui/tabs.tsx`), selected table rows (`components/ui/table.tsx`, today `bg-muted`), document-wide text selection (`::selection` in `globals.css`, not only in `input.tsx`) and progress bars the lime hover, focus, selection and progress states described under Components, with the ink-edge focus treatment applied to every `--ring` consumer in Shell (16 components today, including `shell-top-strip.tsx`, `shell-sidebar.tsx`, `ui/dialog.tsx` and `ui/resizable.tsx`).
- [ ] D2. Load IBM Plex Sans and JetBrains Mono in Shell for `--font-sans` and `--font-mono`, with the appropriate Shell version bump. Core authentication, compact account actions, confirmation forms and local asset delivery are owned by the Core confirmation design feature.
- [ ] D3. Replace the H-graph with the grid mark in `assets/hosty-brand` — light, dark, the ink-tile app icon and the favicon cut — outline the wordmark in IBM Plex Sans 600, regenerate the lockups and app icons with `build-assets.mjs` — which also rewrites Shell's public icons and the `apps/shell-swift` AppIcon set, so both ship with version bumps (`MARKETING_VERSION` for the Swift client) — redraw the hand-coded copies of the mark in Shell's `chrome/brand-mark.tsx` and the SDK's `overlay-react.tsx` (with an `@hosty-sdk/app` version bump), and record the ink scale, lime brand and status colors in `brand-tokens.json` and the brand README.
- [ ] D4. Redraw every first-party app icon as its cell mark on the ink tile — Shell S, Plans P, Telemetry T, Harness A, Whisper V, Marketplace M, Demo App D (whose `icon.svg` still draws the retired H-graph) — replacing each `apps/<app>/assets/icon.svg`, adding one for Whisper and pointing its manifest's `catalogMetadata.icon` at it (Core builds `iconUrl` only from that field), with each app's version bump; then apply the accents as described under App accents: Shell draws each app's 3 px frame strip and tool badges in its accent's strong shade on light and its accent on dark, sourced as the open question settles, and each embedded first-party app other than Shell, whose own charts keep Hosty Blue, sets `--chart-1` to its accent's strong shade on light and its accent on dark for its own charts, swapping the displaced Hosty Blue into the later series it collides with as the Tokens section lists (Telemetry `--chart-2`, Demo App `--chart-3`, Harness and Marketplace `--chart-4`), and shows its mark, accent cell lit, in its own empty states. Because Shell's `AppIcon` shows `iconUrl` as an `<img>`, which cannot follow Shell's own theme class, Shell draws first-party marks inline from the cell map instead, painting the tile `#0F1B2D` in light and `#22324B` in dark; every other consumer — Marketplace's storefront, Harness's context icons, the OS — keeps the baked ink-tile `icon.svg` in both themes and, in dark mode, sets it on a card surface (`#17253B` or lighter) so the tile still separates by a tone.
- [ ] D5. Ship the Telemetry and Demo App navigation icons in `currentColor` instead of hard-coded colors.
- [ ] D6. Use the four status meanings across Shell — info blue, needs you amber (including pending approvals), failed red, working as an Info-blue pulse or ring with a label and a lime progress bar (replacing the sky spinner) — and keep lime out of charts.
- [ ] D16. Contrast pass on Shell: no text lighter than `#5A6A82` on light surfaces, `#6E7F98` and `#93A3BA` only for icons and disabled states, no `primary`-colored text, borders or dots (they move to `--brand-strong` or Info blue), and every state except the normal running dot carrying a label or its own shape, including the static ring for working under reduced motion.
- [ ] D19. Carry the tokens into every embedded first-party app with a web UI — Plans, Workspaces, Telemetry UI, Demo App, Marketplace and the Harness web UI (Whisper has none): replace the neutral shadcn values in each app's `src/app/globals.css` (`apps/harness/web/src/app/globals.css` for Harness; Plans still ships neutral hover and selection colors) with the light and dark tokens above, keeping the app's `--chart-1` override from D4; give the app's buttons, inputs, checkboxes, switches, tabs, selected rows, `::selection` and progress bars the same lime hover, focus, selection and progress states as D1, with the ink-edge focus treatment on every `--ring` consumer; and load IBM Plex Sans and JetBrains Mono for its `--font-sans` and `--font-mono` — with each app's version bump.

### Phase 2 — Shell pages

- [ ] D7. Rework the Dashboard rows as described under Dashboard: no header row, the shared fixed columns for Core and app rows, role icons instead of the System badge, version and runtime under the name with an available update as `current → new` and Manual start for the exception, the state name with its detail line, two-line resources with sparklines, one contextual action and More instead of hover shortcuts, and the All apps row with its left search, aggregate resources and the relocated Update all and Check updates; update the Core App Shell and Shell Navigation features, with the Shell version bump.
- [ ] D8. Add the Dashboard compact layout, selected by container width.
- [ ] D9. Build the data-grid page pattern on ReUI Data Grid and apply it first to the current-user Tokens & devices view, coordinating navigation and authority with the Settings experience feature.
- [ ] D10. Replace generic loaders and empty states with the grid-mark loader and cell empty states.
- [ ] D18. Add the provider role icon set and its chip (icon-only in rows, icon and name in app details) for `ui-client`, `assistant`, `speech-to-text` and `otlp-collector`, with the reserved icons for planned roles, and remove every "System" label from Shell.

### Phase 3 — Tools and small screens

- [ ] D11. Replace the permanent right tool rail with the top-strip Assistant button and Tools menu; panel headers get Open separately and Hide, which keeps frames, drafts, scroll and the selected conversation, while ending a tool instance moves to the tool's menu.
- [ ] D12. Apply the fit rule with page minimums (Dashboard 440 px, Settings and embedded apps 560 px) and a 320 px tool minimum: navigation folds to its rail first, then the tool becomes a sheet over the page; drafts, scroll and the selected conversation survive every dock, sheet and phone transition.
- [ ] D13. Add the phone layout below 600 px: bottom tab bar, last-tool sheet that a second tap hides, an always-visible All tools button, the grouped tool list with search, the Tools badge, and a sheet and frame sized to the visible viewport while the keyboard is open.
- [ ] D14. Show tools everywhere with their Lucide icon and the owning app's color badge.
- [ ] D15. Build the tool activity contract through Core as described under Activity: per-user reports keyed by the panel reference, an app-authenticated internal endpoint with an SDK server helper, time-to-live for working, re-reporting after a Core restart, a `tool.activity.changed` bus hint, "no connection" from Core readiness, and Shell's priority aggregation.
- [ ] D17. In Harness, pin a pending approval under its panel header with a Review action, keep its composer at the bottom of its frame on phones, and report its activity through D15 as the first provider.

### Phase 4 — Harness development page

- [ ] D21. Restyle Harness's development page as described under Harness development page: the three-column layout in the app frame, the sessions column with search, filter chips, app-mark groups, state lines and shapes and the External workspaces row, the conversation header with the pinned decision and working bar, the grouped transcript, the approval card with Allow once and Deny and the composer row, and the workspace column without tabs, with its header, repository card, preview card and Used by — keeping every action and state of the Harness development UI feature. Command results are not persisted today — `HarnessEvent` keeps only the `tool_use` input and the turn result, Claude's `tool_result` handler drops the body and Codex reports a completed command by its text — so D21 also records a bounded, redacted command result event (exit status, duration, at most one summary line) from both adapters, persists it with the transcript and replays it for restored sessions, with adapter tests. Harness ships with its version bumps.
- [ ] D22. Rework the pull request presentation: collapsible PR cards with the two-line summary, the icon rule (shape for the PR state, color for CI on open PRs, Info blue for checks in progress, muted drafts, violet merged, neutral closed, unknown and stale), the segmented CI bar whose check list opens by click beside the workspace column, and Review changes for open and draft PRs; update the Harness development UI feature, with Harness version bumps. `WorkspaceInspectionService.PullRequestsAsync` projects every `PublicationRecord.History` entry today with a null observation and a "Historical reference" error, so D22 also has Core retain each earlier PR's last observation — title, state, merge time, CI summary and thread count — when it leaves the active publication, and project it with its observation time, with Core tests and the platform version bump. A historical PR without a retained observation shows its number and link with the neutral unknown icon.
- [ ] D23. Replace the diff dialog with the review page: entries from Session changes, transcript edits and Review changes, the narrowed session conversation with its pinned decision and composer, the picker for Session changes, Since main and each open or draft PR, the file list with totals, viewed state and thread counts, the diff with the existing renderer, Unified / Split and wrapping, markers for lines not in the PR head, and Back to session that restores the conversation, its draft and its scroll. `DevelopmentWorkspaceService.DiffAsync` offers only the `local` and `session` views today, so D23 also adds a Core diff scope from a PR's merge base to its published head, and the per-line evidence of which rendered lines are absent from that head, to the workspace diff API and its model, with Core tests and the platform version bump; Harness ships with its version bumps.
- [ ] D24. Add line selection and threads to the review page: line-number selection with the lime fill, Ask Harness placing a structured reference (file, line range, source, revision) in the composer, and the PR's review threads under their lines, with author kind, state chip, Reply, Resolve through the existing resolution operation, and Ask Harness. Core's observation carries only each thread's ID, path, line, resolved flag and comment bodies today, so D24 also extends `GitHubPublicationProvider`'s review-thread query, `PublicationReview` and the publication inspection API with each comment's author login, whether the author is a bot or a user, and its creation time, and with each thread's full coordinates — `originalLine`, `startLine`, `originalStartLine`, the diff side, the outdated flag and the subject type (line or file) — with Core tests and the platform version bump. Harness derives "Addressed but not pushed" from the workspace's unpushed diff touching the thread's lines; it never resolves the thread. A file-level thread sits at the top of its file, a multi-line thread under the last line of its range, and an outdated or unplaceable thread in an "Outdated comments" group at the top of its file rather than disappearing. Harness ships with its version bumps.
- [ ] D25. Post PR review comments and replies from the review page through a new Core publication operation that uses the PR's selected GitHub connection, the operator's own authority and CSRF protection, refuses lines outside the PR head, and optionally asks Harness to address the comment; document it in the Assistant PR Lifecycle feature, with Core and Harness version bumps.
- [ ] D26. Add the Harness phone layout on top of D13's tab bar: the full-screen sessions list, the conversation with its pinned decision and composer above the tab bar, the workspace as a bottom sheet without tabs, session changes as a list with each file on its own page, and the CI bar expanding its checks in place, with Harness version bumps.

### Phase 5 — Environment, Marketplace, settings and app management

- [ ] D27. Add the first-run environment page to Core as described under Creating the environment: the four-step strip, the catalog checklist with `defaultEnabled` preselection, install rows with Ready, Starting, Queued and Failed, Retry and Continue without it, the existing administrator form and the Open step — guarded by the first-setup authority and unavailable once an administrator exists, replacing automatic seeding for a browser setup while keeping the seed marker's `pending` semantics; update the Removable System Apps feature, with the platform version bump.
- [ ] D28. Restyle Marketplace as described under Marketplace: search, Discover with category chips and cards, the app card with signer, footprint, screenshots and the permissions it asks for, the shared install dialog leading to Core confirmation, and the Installed tab from Core's installed-state API with Open and Manage; update the Runtime App Marketplace feature, with the Marketplace version bump.
- [ ] D29. Restyle Shell's settings as described under Settings: in-page navigation with My profile, Host, Users & security and Shell, a single App settings entry listing every app with Settings and Manage instead of one destination per app, a lone Settings entry in Shell's sidebar, destination titles, line tabs and the field and row patterns, with the Dashboard menu still opening an app's settings and Manage; update the Settings Experience feature, with the Shell version bump.
- [ ] D30. Restyle Manage application as described under Managing an app: the header with state and Open app, Restart, Stop and More, and the Launch, Parameters, Folders, Network, Permissions, Updates and Backups tabs, splitting typed parameters out of Launch and folding the source into Updates without changing any owning feature's behavior; update the Settings Experience feature, with the Shell version bump.

### Functional Parity

- [ ] D20. Inventory existing actions/states on each changed screen, preserve them where mockups are incomplete, and verify permissions, navigation, forms, drafts, panels and failure/recovery before accepting the visual replacement.

## Open Questions

- Should the environment page create the administrator before installing apps, so every install has
  an actor, or keep the artboard's order with installs running under the setup authority?
- Does App settings keep that name, or read Applications, now that it holds both app pages and Manage?

- Is the All apps row's More menu the right home for Check updates, or does a manual check belong in
  Settings now that Core checks on a schedule?

- The page minimums: are Dashboard 440 px and Settings 560 px right, and may an embedded app declare
  its own minimum in its manifest instead of the 560 px default?
- Is ⌘J the assistant shortcut?
- May a user pin one tool as a fifth phone tab?
- Where does Shell read an app's accent for the frame strip and tool badges — a manifest field
  limited to the fixed palette, or a table Shell keeps for first-party apps?
- Which existing diff scope does the review page's **Session changes** mean — the uncommitted
  changes, or everything the session has not pushed yet? Since main maps to the all-workspace scope.
- Does Comment on #N post single comments only, or collect a pending review that the operator submits
  at once?
- Should the approval card offer Allow for this session? It needs a new approval contract — which
  later actions it covers, how it is shown, revoked, audited and persisted, and the same behavior for
  Claude and Codex — with its own deliverable and an update to the approval features; today an
  Autonomous chat is the session-wide alternative.
- May an administrator comment through a PR whose publication uses another user's GitHub
  connection, or only that connection's owner?

## Verification

Compare changed screens against D20's functional inventory through Core/Shell, including actions absent from mockups.

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
- Harness development page through Core-managed Shell and a normal password login, in light and dark:
  every action and state from the Harness development UI feature is reachable; the review page opens
  from all three entries and returns with the draft and scroll intact; each picker source shows its
  own files; a selection reaches the composer as a reference; a GitHub comment lands on the intended
  PR line through the selected connection and is refused for a line outside the PR head; the CI
  popover opens only by click.
- Dashboard: a long state detail and a long contextual action never shift the columns, Core and app
  values line up, search filters together with the state filters, and the table never scrolls
  sideways at any width, switching to the compact layout first.
- Environment page on a fresh data root: no choice is possible without the setup authority; a failed
  image pull shows its cause and Retry installs it; Continue without it leaves that entry owed; the
  page is gone once the administrator exists.
- Marketplace, Settings and Manage application through Core-managed Shell in light and dark: every
  action of the owning features is reachable, including those absent from the artboards; App settings
  lists every installed app; the `manage:<app-id>` route opens the right tab.
- Phone checks on iOS Safari and Android Chrome: keyboard open with a long conversation, a pending
  decision while another tool works, 16 or more tools, rotation, and a hidden tool keeping its draft
  across dock, sheet and phone transitions.

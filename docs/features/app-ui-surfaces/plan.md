# App UI Surfaces

Status: Draft
Created: 2026-08-18
Updated: 2026-08-18

Give an app's UI a declared *kind*, so operator configuration stops living in the sidebar as if it
were a domain page.

## Goal

Two kinds of app UI exist and the manifest can express only one of them. `ui.navigation` puts a page
in the Shell sidebar — the right home for domain UI (telemetry's Metrics and Traces, the
Marketplace). But operator configuration has no other shelf, so it ends up there too: the AI
gateway's sidebar entry **is** its settings page (`navigation: [{label: "Assistant", path:
"/settings"}]`) — an admin-only configuration form presented as if it were an app the operator works
in.

The owner named two more kinds. **Panels** (2026-08-18): tabs on a right-side rail — the VS Code
two-rail concept, navigation on the left, tool panels on the right, and the content visible beside
both. In scope here, because the assistant is its first consumer and the concept resolves where the
assistant lives ([assistant-entry-points](../assistant-entry-points/plan.md)). **Widgets** — small
dashboard tiles — stay a recorded future axis and are not built.

## Current Behavior

- `ui.entrypoint` and `ui.navigation` place pages in the sidebar; the workspace embeds them in an
  iframe and answers the SDK's delegated-token handshake (`packages/app-sdk/src/embedder.ts`).
  **Only the workspace answers it** — a page embedded anywhere else in Shell would hang on the
  handshake, which has already produced one "the app never loads" defect.
- Shell's Settings page is a fixed set of native sections — Core, ingress, mounts, tokens — plus the
  Core-owned per-app configuration (runtime, ports, mounts, autostart, source, manifest `settings`).
  No app-served content appears there.
- The gateway serves its settings page as hand-written HTML from its Node process, with the recorded
  reason that a UI toolchain would be the largest thing in a headless app; the page predates any
  other place to put it.

## Target Behavior

- The manifest gains an optional `ui.settings: { endpoint, path }`. Additive: `ui.navigation` is
  untouched, no `schemaVersion` bump (it tracks the contract format, not additions).
- Core's app projection carries the new field, so Shell discovers settings surfaces the same way it
  discovers navigation — without reading manifests.
- The manifest also gains an optional `ui.panel: { endpoint, path, label }` — a tab on Shell's
  **right panel**. The panel is chrome: a tab strip present on every page, collapsible, absent
  entirely while no installed app declares a panel surface; its content is an iframe from the app's
  origin, exactly like a settings tab. The property that motivated it is **docking**: panel content
  sits beside the workspace rather than over it, so an operator reads an app's error and talks to
  the assistant about it at the same time. Today's assistant is a Dialog overlay pinned to the right
  edge, and having to close it to see the page underneath is the root cause of the lost-draft
  report in [agent-background-sessions](../agent-background-sessions/plan.md).
- Shell's Settings page renders one tab per installed app that declares `ui.settings`, hosting the
  app's page in an iframe from the app's own origin. **The delegated-token handshake gets one shared
  answerer used by every Shell embedding context** — the workspace today, Settings tabs and the
  panel now — rather than a copy per context, because the copy nobody remembers is how the
  workspace-only gap happened. Shell remains ignorant of every app's settings schema — the original objection to putting
  the gateway's settings in Shell was schema knowledge, not hosting, and this design keeps it
  honoured.
- A surface declaration is placement metadata, not access control: the page stays reachable
  standalone (`hosty apps open`), and the app keeps enforcing its own authorization on every request
  regardless of where it is embedded.
- The gateway moves: its `ui.navigation` entry is removed, `ui.settings` is declared, and the page is
  rebuilt on the standard stack — Next.js static export + Tailwind + shadcn — served by the same Node
  process. The assistant panel itself is untouched; it was never a workspace page.

### The settings split

By **owner of the state and audience**, not by whether a page looks like settings:

| State | Audience | Home |
| --- | --- | --- |
| Platform-owned (runtime, ports, mounts, autostart, source, manifest `settings`) | admin | Shell's native pages, as today — uniform by construction |
| App-owned operator configuration: rare, admin-only, changes behaviour | admin | the new Settings tab |
| App-owned domain work: routine use, possibly by non-admins | users | sidebar (`ui.navigation`) |

Litmus tests: *would a `host.user` ever legitimately open it?* → sidebar. *Does it change behaviour,
or produce and consume content?* → behaviour means Settings.

Applied to the fleet today: the gateway's whole page is operator configuration, so it moves and the
gateway keeps no sidebar entry; telemetry's Metrics/Traces/Logs stay in the sidebar, and its future
retention/ingest settings would be a Settings tab; Core-injected manifest `settings` stay native in
Shell.

## Deliverables

- [ ] Manifest: optional `ui.settings` and `ui.panel`, validated (endpoint must exist, path must be
      absolute, panel label required), documented in
      `skills/hosty-app-skill/references/app-manifest.md`.
- [ ] Core: the app projection and app-directory summaries carry both surfaces resolved to URLs,
      exactly as navigation entries are resolved.
- [ ] Shell: the right panel — tab strip on every page, collapsible, absent while nothing declares a
      panel surface, one iframe tab per declaring app.
- [ ] Shell: a tab per app on the Settings page, iframe from the app origin, **the delegated-token
      handshake answered on the Settings page** — the workspace-only gap is a known trap that has
      bitten once already. Admin gating comes free with the Settings page.
- [ ] Shell: a stopped or unreachable app's tab states that plainly instead of rendering a dead
      iframe (subject to open question 1).
- [ ] Gateway: drop `ui.navigation`, declare `ui.settings`; rebuild the page as a Next.js static
      export (Tailwind + shadcn) served by the existing process. **Relative fetches only** — the
      telemetry UI has already shipped the bug where `next build` baked a localhost origin into
      static layouts.
- [ ] SDK: confirm `embedder.ts` needs nothing new for the Settings placement; extend it only if the
      confirmation fails.
- [ ] Tests: manifest validation both ways; Shell renders a tab for a declaring app and none for a
      non-declaring one; the handshake answered on Settings (the pair: a page that loads there,
      beside the workspace still working); the gateway page standalone and embedded.
- [ ] Docs: `feature.md`, hosty-app-skill reference, index.

Version outcome: platform minor (manifest contract + projection), `apps/shell` minor,
`apps/ai-gateway` minor.

## Open Questions

1. **What does a declaring app's tab show while the app is stopped?** A greyed tab with a plain
   sentence and a start affordance, or no tab at all? Showing nothing hides the existence of
   settings; showing a dead iframe is worse than either.
2. **Do per-app tabs sit beside Shell's own sections at the top level, or under one "Apps" area?**
   With two first-party apps declaring surfaces it is cosmetic; with ten it is not. Can be decided at
   Ready with a mock, and changed later without touching the contract.

## Decisions

- **The split rule above** — recommended 2026-08-18 in chat and uncontested; recorded here so Ready
  review confirms it explicitly rather than inheriting it silently.
- **Iframe, not native rendering of app settings in Shell.** Preserves the recorded objection that
  moved the gateway's page out of Shell in the first place: Shell must not know any app's settings
  schema. Declarative Shell-rendered settings can be added later for simple cases without breaking
  this contract.
- **Static export, not a second `ui` service.** The gateway's recorded no-toolchain decision is
  overridden by the owner's one-stack goal (2026-08-18), but a telemetry-style second runtime for a
  settings form would be the heaviest possible reading of that goal. `next build` output served by
  the process that already exists keeps one runtime and gains the standard components. If the page
  ever grows real weight, the manifest already supports promoting it to a service.
- **The two-rail concept** (owner, 2026-08-18): left rail navigates, right rail holds tool panels,
  content stays visible beside both. The consequence worth recording: a panel surface is how an app
  ships an always-at-hand tool without Shell owning that tool's UI.
- **Widgets are deferred, deliberately.** The axis is recorded so fields stay per-kind
  (`ui.settings`, `ui.panel` — not one `ui.surface`) with room beside them, and nothing more.
- **Sequencing: this plan supersedes any standalone rewrite of the gateway page.** Rebuilding it on
  the standard stack happens *as part of the move* — one piece of work instead of a rewrite followed
  by a relocation.

## Verification

- Unit and integration tests as above.
- Live: open Shell Settings, see the gateway tab, change a provider toggle from inside it, and
  confirm the change applies (the page already reports "Applied to running sessions"). The sidebar no
  longer lists Assistant; the standalone URL still works.
- The negative that matters: a non-admin session sees no app settings tabs and cannot reach the
  gateway page through Shell — while the admin beside them can, since a Settings page that refused
  everyone would satisfy the first check alone.

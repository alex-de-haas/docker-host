# Assistant Entry Points

Status: Ready
Created: 2026-08-18
Updated: 2026-08-18

Make the assistant reachable from anywhere in Shell, and let an app hand it context — without letting
an app *drive* it.

## Goal

Two asks from the owner (2026-08-18), one mechanism short of possible today:

- **The trigger reads as a navigation item.** The sidebar's "Assistant" button is global already, but
  it sits in a list of pages and looks like one. An operator mid-error wants it on hand, not found.
- **Apps cannot offer "Ask Assistant".** Shell's own app-details dialog has exactly that button —
  `openAssistant({app, page})` seeds the session's first message with structured context, so the
  pattern exists and works. But it is reachable only from Shell-native UI: the embedder contract
  (`packages/app-sdk/src/embedder.ts`) carries auth recovery and delegated tokens, nothing more, so a
  telemetry error row has no way to say "open the assistant about me".

## Current Behavior

- Sidebar button (Sparkles, "Assistant") opens `AssistantPanel` — a **Dialog overlay** pinned to the
  right edge (`assistant-panel.tsx`), so the page under it is unreachable while it is open. Present on
  every page, styled as a page link. Hidden when no running app declares the `ai-gateway` interface.
- `openAssistant(context)` exists in `shell-client.tsx`; a non-null context **starts a new session**
  and the panel sends the context as a seed. The app-details dialog is its only structured caller.
- No keyboard shortcut, no attention state on the trigger (the indicator is an unchecked deliverable
  of [agent-background-sessions](../agent-background-sessions/plan.md)).
- Apps embedded in the workspace have no assistant-related message in the embedder contract.

## Target Behavior

- **The assistant is a tab on Shell's right panel** — the `ui.panel` surface from
  [app-ui-surfaces](../app-ui-surfaces/plan.md), declared by the gateway. The tab strip is on every
  page, so the trigger is permanently in view; the attention dot renders on the tab; a keyboard
  shortcut toggles it. Hidden as today for non-admins and when no gateway runs.
- **Docked beside the content, never over it.** The overlay is the root cause of the lost-draft
  report: the operator closed the assistant to copy an error under it. Docked, the error and the
  conversation are visible at once and the close-to-look move disappears — draft persistence then
  covers reloads, not routine reading.
- **The panel's content is gateway-served.** The sessions list and the chat move out of Shell into a
  page the gateway serves, embedded like any other panel surface — the same movement that took
  observability's pages out of Shell into telemetry-ui. Shell keeps a minimal gateway client for
  exactly one job: the badge.
- **A new embedder message, `hosty:ask-assistant { text }`**, origin-verified exactly like the two
  existing messages, plus an SDK helper. Shell **forwards it into the assistant panel's iframe**,
  revealing the panel if collapsed; the panel page inserts the text into the draft, prefixed with
  provenance ("From hosty.telemetry:"), and stops there. Shell's own app-details "Ask Assistant"
  becomes the same forwarded message as everyone else's.
- **The operator sends; the app never does.** This is the load-bearing rule, not a UX nicety — see
  Decisions.
- First consumer: telemetry-ui error rows get an "Ask Assistant" button composing the record into
  plain text.

## Deliverables

- [ ] Gateway: the panel page — the sessions list and chat, with everything the Shell-native panel
      does today (approvals, questions, context seeding) moved over. Depends on app-ui-surfaces'
      panel surface; the largest deliverable here and the price of Shell not holding provider UI.
- [ ] Shell: the assistant tab's badge, wired to the same state the agent-background-sessions
      indicator uses (one source, never a second poll), and the keyboard shortcut.
- [ ] SDK: `hosty:ask-assistant` in `embedder.ts` — message shape, origin verification identical to
      the existing pair, and an `askAssistant(text)` helper. SDK minor bump.
- [ ] Shell: the routing — a verified `hosty:ask-assistant` reveals the panel and is forwarded into
      its iframe with the source app id attached; length capped; messages from origins that fail
      verification dropped with a console warning, exactly as the token handshake does. The panel
      page owns the draft insertion and the provenance line.
- [ ] Telemetry UI: "Ask Assistant" on an error row, composing app id, timestamp, severity and body
      into the text. `apps/telemetry` minor bump.
- [ ] Tests: the message verified and inserted beside one from a wrong origin dropped; the draft
      carries provenance; nothing auto-sends — asserted, since it is the rule the design stands on.
- [ ] Docs: `feature.md`, embedder-contract reference in hosty-app-skill, index.

Version outcome: `apps/shell` minor, `packages/app-sdk` minor, `apps/telemetry` minor. No platform
change, no gateway change — the draft is client-side and the panel is Shell's.

## Open Questions

None open. Both were answered by the owner on 2026-08-18: the trigger is a tab on the right panel —
the VS Code two-rail concept — and an app-invoked ask lands in the **current** session's draft, where
the operator decides to send or to start fresh; the panel's own new-session affordance makes the
choice cheap. The layout mock was built the same day, iterated once (the top strip), and approved.

## Decisions

- **An app can fill the draft; only the operator can send.** App-provided text entering a model that
  holds host shell is the same trust boundary that keeps MCP providers off by default — third-party
  text must not become agent behaviour without a human between them. Auto-send would let any embedded
  app drive the agent with whatever its page happened to contain; prompt injection through an error
  message is exactly the attack shape. The draft, the visible provenance line, and the operator's
  send are the boundary.
- **Plain text in v1.** No structured payload beyond the verified source app id: a schema for
  "context objects" invites apps to smuggle structure the operator cannot read at a glance, and the
  operator must be able to see everything the model will.
- **Reuse the draft as the vehicle.** Depends on the draft-persistence deliverable in
  agent-background-sessions, and composes with it: an inserted error that the operator navigates away
  from is still there when they come back.
- **The assistant UI leaves Shell** (owner, 2026-08-18 — direction decided, layout mocked before
  Ready). The panel surface is what makes it possible without Shell learning the gateway's UI, and
  the docking is what makes it worth doing: content and conversation visible at once. Recorded with
  its consequences so the neighbouring plans stay honest — the session-list and draft deliverables in
  agent-background-sessions keep their behaviour but their pixels land in the gateway-served page if
  that plan ships second, and Shell's app-details button loses its private path.

## Verification

- Unit tests as above.
- Live: from a telemetry error row, press Ask Assistant, see the panel open with the error in the
  draft and its provenance line, edit, send, and get an answer about that error. Close the panel,
  reopen, and the unsent draft is still there (the composed check with the draft deliverable).
- The negative that matters: a page posting `hosty:ask-assistant` from an unverified origin changes
  nothing, and nothing ever reaches the gateway without the operator pressing send — verified beside
  the positive case, since a handler that ignored everything would pass the negative alone.

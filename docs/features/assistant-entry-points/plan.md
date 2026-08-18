# Assistant Entry Points

Status: Draft
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

- Sidebar button (Sparkles, "Assistant") opens `AssistantPanel`; present on every page, styled as a
  page link. Hidden when no running app declares the `ai-gateway` interface.
- `openAssistant(context)` exists in `shell-client.tsx`; a non-null context **starts a new session**
  and the panel sends the context as a seed. The app-details dialog is its only structured caller.
- No keyboard shortcut, no attention state on the trigger (the indicator is an unchecked deliverable
  of [agent-background-sessions](../agent-background-sessions/plan.md)).
- Apps embedded in the workspace have no assistant-related message in the embedder contract.

## Target Behavior

- **A fixed affordance in Shell's chrome**, visible on every page including Settings, with the
  attention dot from agent-background-sessions rendered on it, plus a keyboard shortcut. Hidden as
  today for non-admins and when no gateway runs.
- **A new embedder message, `hosty:ask-assistant { text }`**, origin-verified exactly like the two
  existing messages, plus an SDK helper. On receipt Shell opens the panel and **inserts the text into
  the draft**, prefixed with provenance ("From hosty.telemetry:"), and stops there.
- **The operator sends; the app never does.** This is the load-bearing rule, not a UX nicety — see
  Decisions.
- First consumer: telemetry-ui error rows get an "Ask Assistant" button composing the record into
  plain text.

## Deliverables

- [ ] Shell: the persistent trigger — placement per open question 1 — with the attention dot wired to
      the same state the sidebar indicator deliverable uses (one source, two renderings, never a
      second poll), and a keyboard shortcut.
- [ ] SDK: `hosty:ask-assistant` in `embedder.ts` — message shape, origin verification identical to
      the existing pair, and an `askAssistant(text)` helper. SDK minor bump.
- [ ] Shell: the handler — open panel, insert into the draft with provenance, cap the accepted length,
      and drop (with a console warning) messages from origins that fail verification, exactly as the
      token handshake does.
- [ ] Telemetry UI: "Ask Assistant" on an error row, composing app id, timestamp, severity and body
      into the text. `apps/telemetry` minor bump.
- [ ] Tests: the message verified and inserted beside one from a wrong origin dropped; the draft
      carries provenance; nothing auto-sends — asserted, since it is the rule the design stands on.
- [ ] Docs: `feature.md`, embedder-contract reference in hosty-app-skill, index.

Version outcome: `apps/shell` minor, `packages/app-sdk` minor, `apps/telemetry` minor. No platform
change, no gateway change — the draft is client-side and the panel is Shell's.

## Open Questions

1. **Where exactly does the trigger live?** Top bar next to the host status, or a pinned slot at the
   sidebar's bottom that survives compact mode. Same "decide at Ready with a mock" shape as
   app-ui-surfaces' question 2, and the two should be answered together so Shell's chrome is designed
   once.
2. **Does an app-invoked ask start a new session or land in the current one?** The existing
   app-details path forces a new session. For "ask about this error" a fresh session is usually
   right, but an operator mid-conversation may want the error appended to what they have. Options: always
   new (predictable), always current (context-preserving), or insert into the current draft and let
   the operator decide — the draft-only design makes the third nearly free.

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

## Verification

- Unit tests as above.
- Live: from a telemetry error row, press Ask Assistant, see the panel open with the error in the
  draft and its provenance line, edit, send, and get an answer about that error. Close the panel,
  reopen, and the unsent draft is still there (the composed check with the draft deliverable).
- The negative that matters: a page posting `hosty:ask-assistant` from an unverified origin changes
  nothing, and nothing ever reaches the gateway without the operator pressing send — verified beside
  the positive case, since a handler that ignored everything would pass the negative alone.

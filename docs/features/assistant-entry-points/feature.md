# Assistant Entry Points

Created: 2026-08-19
Updated: 2026-08-19

The assistant is reachable from anywhere in Shell, and an app can hand it context — without letting
an app drive it.

## The Assistant Is A Panel Tab

It used to be a Dialog pinned over the page, so reading the error you were asking about meant closing
it. That is the root cause of the lost-draft report: the operator closed the assistant to copy an
error underneath. Docked as a `ui.panels` tab on Shell's right rail, both are legible at once, and
the trigger is in view on every page.

**The chat is served by the gateway, not by Shell** — the same movement that took observability's
pages out of Shell into telemetry-ui. Shell hosts an iframe and knows nothing about the conversation.
A session list came with the move, which the Shell-native panel never had: closing it was the only
way back to a previous conversation, and there was no way back at all.

`Ctrl`/`Cmd`+`Shift`+`A` toggles it: already looking at the assistant puts the panel away, anything
else brings it here — including an open rail showing another app's panel. A shortcut that could only
open would make the rail a trap on a small screen.

**The panel still presents the operator's delegated token.** Not for authentication — the app session
cookie does that — but because the gateway keeps the presented bearer as the session's *delegation
seed* for app MCP. A panel authenticating only with its cookie would leave `session.credential` null,
every app-MCP path would be skipped by a guard, and the chat would work while the agent silently had
no app tools. The credential stays the operator's, obtained through the existing
`hosty:request-delegated-token` handshake; a gateway minting user-scoped tokens for itself is the
"token, not proxy" rule this design is built on.

## An App Can Fill The Draft; Only The Operator Sends

`askAssistant(text)` in `@hosty-sdk/app` posts `hosty:ask-assistant` to the embedder. Shell verifies
it, reveals the panel, selects the assistant's tab, and forwards the text with **the app id it
mounted** — never one the frame claims. The panel inserts it into the draft, prefixed with its
source, and stops.

**Nothing is auto-sent, and that is the load-bearing rule rather than a UX nicety.** App-provided text
entering a model that holds host shell is the same trust boundary that keeps MCP providers off by
default; an error message is exactly the shape a prompt injection arrives in. The draft, the visible
provenance, and the operator's press are the boundary.

Three properties follow, and each is a decision rather than an omission:

- **Plain text, no structured payload.** Shape the operator cannot read at a glance is shape they
  cannot check.
- **No reply.** The helper answers whether the message could be posted, never whether anyone acted on
  it.
- **The cap lives in the parser** (4000 characters), not in the embedder that happens to call it. A
  cap each embedder applies is a cap one embedder forgets, and the failure would be a page pasting
  itself into somebody's draft.

Verification is the same shape as the two messages beside it: `event.source` must be the mounted
frame's window and `event.origin` must match the frame URL's origin. A message that looks like an ask
but fails those checks is dropped with a console warning — silence would leave an app author
debugging a button that does nothing.

Unlike the delegated-token responder, **every** embedded app gets this one. Answering costs the
operator a glance; answering the token request hands out a credential.

### First Consumer

Telemetry's log details offer "Ask Assistant" on error rows, composing the app, the time, the
severity and the message into plain text. Errors only: an "ask about this" on every info line would
be noise, and the button exists for the moment an operator is already stuck.

## What This Does Not Do

**The attention badge on the assistant tab is not built.** It must read the same state as
[agent-background-sessions](../agent-background-sessions/plan.md)' attention indicator — one source,
never a second poll — and that state does not exist yet. Building it here would mean inventing the
second poll the design forbids.

**The panel page does not verify its own embedder's origin.** Shell verifies the app→Shell hop, which
is where an app's text enters; the Shell→panel hop is unverified because the page has no trustworthy
source for the expected origin — Core injects no embedder origin into apps, and a referrer can be
absent, so a gate built on one fails *silently*. Closing it properly is a platform change and is
recorded as such.

## Testing Expectations

- **The ask verified beside one dropped**: the same payload from a wrong origin, from a wrong source
  window, and with no active frame all yield nothing. Either assertion alone is satisfied by a parser
  that always answers the same way.
- **The three intents stay distinct** — an ask must never trigger the auth-required or delegated-token
  handler, and neither of those may parse as an ask.
- **The cap is asserted at the boundary**, since the point is that a page cannot paste itself into a
  draft; empty and whitespace-only asks yield nothing.
- **Nothing auto-sends.** The rule the design rests on is that the panel fills the draft and stops.
- **Not verified live**: no app has yet posted an ask against a running host, and the telemetry button
  has not been pressed there.

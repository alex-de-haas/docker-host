# Agent Background Sessions

Created: 2026-08-24
Updated: 2026-09-01

Leaving an agent working while you close the tab is a feature rather than a way to lose work: the
session is findable when you come back, and it reaches you when it needs you.

Spans three features and belongs to none: [ai-gateway](../ai-gateway/feature.md) owns sessions,
[notifications](../notifications/feature.md) owns delivery, and `apps/shell-swift` is the only client
that can raise a real OS banner. **No Core change** — everything needed already existed there.

## Waiting Is A State, Not A Pause

An agent session is unlike the background work the fleet already runs. A transcode has a defined end
and deterministic progress; an agent session that stops on an approval or a question is **waiting for
a person**, indefinitely. "Running in the background" means that at least as often as it means
"working", and everything here follows from treating the two as different.

- **The session list puts blocked sessions first and says why.** Ordering alone is invisible to
  someone who has not seen the list before, so the row is marked as well as moved.
- **The panel's tab carries a dot** when any session wants the operator. The tab is on every page, so
  a session that stopped is findable from wherever they happen to be.
- **The count comes from the page that holds the sessions**, posted to the shell and verified against
  its own DOM like every other embedder message. Never polled: a shell asking the gateway the same
  question on a timer would be a second source that disagrees with the first for its whole interval.
  This is what [assistant-entry-points](../assistant-entry-points/feature.md)' badge was waiting for.

## Reaching Someone Who Closed The Window

Entering a waiting status publishes one notification to the operator who started the session.

- **On entering, once.** The status setter already returns early when nothing changed, so a run full
  of approvals announces per state rather than per approval.
- **Deduped per session**, because an inbox with a row per approval is an inbox nobody reads.
- **Nothing on resolution.** A row that appears and vanishes on its own is one the operator learns to
  distrust; the state the UI reads is cleared instead.
- **No transcript content.** What the agent proposed is in the session, and an inbox row is not the
  place to repeat text nobody has approved yet.
- **The link carries the session.** Shell reads `?assistantSession=`, reveals the rail and forwards
  the id into the panel over the channel built for "Ask Assistant"; the panel decides whether that
  session still exists. The parameter is stripped once acted on, and the id's shape is checked so a
  crafted link cannot smuggle anything into the message.

Publishing is fire-and-forget. A missed notification costs a slower reply; a session that failed
because a notification could not be delivered would be a far worse trade. A Core that cannot be
reached is reported once and then muted: the gateway retries on every wait, and a line per attempt
would bury the log the warning exists to explain.

**On the Mac**, the same event raises a banner — the only thing this client can do that a browser tab
cannot. Permission is asked on the first notification rather than at launch: a prompt shown before the
operator has seen anything that would ever notify them is the prompt people deny, and a denial is far
harder to undo than a delay. The banner is identified by the host's own notification id, so a
reconnect replaying what was missed replaces it rather than stacking a second. The banner shows even
while the app is frontmost — suppressing it, which is the default, would mean an operator watching one
session never learns another has stopped for them. Only host-relative links are followed, re-checked
at the moment of acting on one rather than only where it was stored — a notification is written by an app, and one that could send the operator
anywhere would make an installed app a phishing vector with the host's own banner as the delivery.

## The Draft Is The Client's Alone

The gateway learns of text only when it is sent, so a draft can only be kept by the client. Reported
2026-08-18: text typed, panel closed to go copy an error message, text gone.

Docking the panel removed the reason to close it; this removes the loss on reload, which docking does
nothing about. Kept **per session** — switching sessions and finding someone else's half-written
sentence is the same loss wearing another shape. Written on change rather than on unload, because a
closed laptop, a crashed tab and a navigation away all skip unload handlers, and those are exactly
when the text matters. Cleared only once the gateway has the message, never before the round trip.
Drafts of sessions the gateway no longer has are pruned, or the store grows for the life of the
browser profile behind keys the operator cannot see. Storage that refuses everything costs a draft,
never the panel.

## Nobody Is Coming Back

A session that has waited a day is stopped and marked **abandoned**, keeping its transcript.

Its own status, not `cancelled` or `failed`: those say the operator chose or the harness broke, and
neither is true. Swept hourly rather than daily, or a session abandoned just after a tick holds its
harness process, its MCP proxy route and its share of the delegation chain for nearly two days.

The conversation survives the reclamation. The transcript is kept — an operator returning to find the
session gone would have lost the very question it was asking — and the next message starts a fresh
harness that resumes it.

## Testing Expectations

- **The draft as a set**: per session rather than global, an emptied box treated as a decision,
  cleared after a send, pruned when its session is gone, and a storage that throws costing nothing but
  the draft.
- **Attention ordering**: blocked first then newest, asserted against a list where the newest is not
  blocked and the oldest is — an order that happened to be chronological would pass a weaker case.
  The input is not mutated, since it is rendered state.
- **The attention message is sender-verified** and its count clamped: a wrong badge is a small harm,
  and a wrong badge any page could set is how an operator learns to ignore the badge that matters.
- **Notifications**: only statuses that need a person, deduped per session, targeted at the session's
  owner, silent when there is no owner to tell, and never throwing when Core is unreachable — with
  the warning *awaited* rather than left to escape, since publishing is fire-and-forget and a log
  emitted after the test has returned failed a green CI run as a worker teardown error. The muting is
  asserted beside it: a second unreachable publish warns no further. That check must outlast the
  rejection it observes, not the call that starts it — waiting only for the second request passed
  with the muting deleted.
- **Abandonment as a pair**: left alone before the deadline, stopped after it, and a merely running
  session untouched however long it runs — reclaiming that one on a clock would kill live work.
- **The Swift payload**: what a banner needs decoded, fields it cannot use ignored, an unreadable
  payload costing only the banner, host-relative links only, and read state understood — a live event
  is new by definition, an inbox row may not be.

---
created: 2026-10-28
updated: 2026-11-11
summary: Native next-message suggestions retained in Harness conversation history with explicit recorded choices, guarded draft insertion and bounded collection.
components: [apps/harness]
---

# Contextual Prompt Suggestions

Harness offers one optional next message after a successful interactive chat answer. It uses
the selected provider's native conversation. Suggestions appear as separate cards in conversation
history. Selecting one records the choice and inserts an editable draft when its guarded composer
remains empty; the user sends it explicitly.

## Composer And Personal Preference

**Prompt suggestions** in the composer's **Add to message** menu is enabled by default and saved
for the authenticated Harness user. It is independent of shared agent profiles, model selection,
reasoning effort and autonomy. Older clients that omit the opt-in retain ordinary turn completion.
Task execution and translation cannot opt in to prediction work.

The transcript displays a plain-text card with **Use suggestion** and **Dismiss**. Its original text
remains readable after selection, dismissal, context changes and Harness restart. Resolved
cards show **Selected for draft**, **Dismissed** or **Superseded**. Selection records an
operator choice; it is not evidence of local insertion or message delivery.

An actionable suggestion also replaces the empty composer's ordinary placeholder in muted text.
It remains a hint, not draft content, until accepted. Typing hides it; clearing the draft restores
the hint while that suggestion remains actionable. Attachments, queue editing and a blocked or
disconnected composer retain the ordinary placeholder. An accessible description explains Tab
acceptance and Escape dismissal.

Tab selects an actionable suggestion while an empty textarea is focused; Shift+Tab keeps normal
focus navigation. Escape explicitly dismisses the current actionable suggestion.
IME composition, mention menus, pending questions, approvals and other foreground actions retain
their existing behavior. Acceptance preserves undo and draft restoration and does not create app
mentions, attachments, tool calls, a task or another user message. Only explicit Send/Enter dispatches
the resulting draft. Native text retains its original language.

Typing, paste, dictation, attachments, a handoff draft and queue editing take precedence over draft
insertion. They do not record dismissal or erase historical cards. Existing content is preserved;
insertion waits for an empty composer. Disconnected clients retain readable history with actions
disabled. Turning off future suggestions retains existing history. Confirmed unsupported or unavailable results appear as
concise preference feedback without a repeated error toast or a permanent loading indicator.

## Native Providers And Automatic Detection

Claude Agent SDK receives `promptSuggestions: true` only for an eligible opted-in run. Its
`prompt_suggestion` message is accepted after a successful `result`, once, with the matching native
session ID and active run generation. Native suppression is normal: the first turn, plan mode,
usage limits or native settings can produce no suggestion. Harness does not override these settings.

Codex negotiates `experimentalApi` and calls `thread/prediction/request` once for the completed
native thread and turn. It accepts only a matching `thread/prediction/updated` notification.
Completed text, completed null, failure and unsupported method responses are distinct outcomes.
An uncertain request is never resubmitted to generate a replacement.

The pinned Codex 0.162.1 binary returns JSON-RPC `-32601` with
`thread/prediction/request is not implemented yet`, even after experimental negotiation. The
integration remains available for newer native versions. A process-local cache suppresses further
requests only after this protocol-level refusal (or method-not-found), keyed by the resolved command
and versioned initialize response. It holds at most 32 observations for 24 hours. A different native
version, worker restart or cache expiry permits a new attempt on the next explicit interactive turn.
Thus a dependency upgrade can enable suggestions without a Harness version allowlist or a setting
change. No background probes or fallback model calls run.

Authentication, account/model eligibility, quota, timeout and generic experimental errors do not
disable the protocol globally. An unversioned handshake is not cached as unsupported. Generated
types alone do not establish availability; a correlated native notification supplies the result.

## Answer Completion And Execution Ownership

Worker protocol version 2 separates the primary answer, optional `suggesting` phase and confirmed
native exit. The worker publishes `answer_complete` after a successful primary result, then collects
at most one suggestion for thirty seconds. Input is trimmed, bounded to 2,000 Unicode code points and
checked for malformed or control content. Duplicate, unrelated and late output is discarded.

The coordinator ends answering activity and unregisters the turn's MCP proxy and development tools
at the answer boundary. Only an exact already-reviewed deferred runtime or workflow request survives
that boundary until confirmed native exit and lease release; current policy, cancellation and Core
authority still apply before dispatch. Prediction output cannot enter the transcript as assistant text, a tool
request, an approval or a second conversational turn. The native process, connection claim and source
lease remain owned until exit is confirmed. API and worker versions must match; they are deployed
together.

A new explicit Send, model/context change, disable, cancellation or shutdown ends optional
collection. Worker admission gives foreground work priority over optional collection, including
Docker's single slot, and waits for native exit before releasing capacity. Stop preserves the
successful primary answer. Timeout or optional provider failure also preserves it. An unconfirmed
native exit retains ownership and exposes the existing recovery requirement.

Disabling the preference during an answer does not cancel that answer. It suppresses prediction
delivery and closes native execution at the primary result. Neither API/worker restart nor reconnect
generates a missed prediction.

## Delivery, Freshness And Retention

The existing authenticated event transport delivers durable `prompt_suggestion_created` and
`prompt_suggestion_resolved` events. A stable suggestion ID correlates the original literal text
with its native attempt and completed answer. Suggestions have no time limit: an unchanged suggestion
remains available after waiting, reconnecting or restarting Harness. Restart/read reconciliation
supersedes suggestions only when their context changes, without generating another prediction.
Legacy expiry records remain closed and appear as superseded; old deadline fields are ignored.
Creation events and direct suggestion responses retain a deprecated, bounded future `expiresAt`
field for already-open older clients. Current clients and persisted choice state do not use it
to expire suggestions.
The transient `session_suggestion` projection carries
optional collection/availability feedback, independent of historical retention.

New messages, provider/model/effort changes, app context and workspace changes supersede an
actionable suggestion. Session access is checked by the existing authenticated session routes. Preferences
use app-session identity, atomic revision-checked writes and separate user files; a delegated provider
token cannot change them.

Authenticated owner-only Harness routes read the current suggestions and record explicit choices.
Actions carry a UUID and expected suggestion revision. Exact retries return the recorded result;
competing choices conflict and clients refresh the authoritative card. A delegated provider token
cannot record an operator choice.

Browser selection and dismissal intents are saved before their API action, scoped to origin,
installation, owner and conversation. A lost reply reuses the same UUID. Draft insertion occurs
after confirmed selection and only in the same empty draft generation. Concurrent typing or clearing
preserves the changed draft; **Retry insertion** permits deliberate recovery. Ordinary reload restores
saved text/intent, never reconstructs a draft merely from a selected history card. Live insertion
participates in editor undo; the undo stack itself is not persisted across reload.

History exports project each suggestion as the `hosty.harness/prompt-suggestion` extension with literal
fallback text and its current choice. Sharing that extension requires explicit disclosure. Neither
the card nor its resolution creates a model turn or enters provider context. Internal worker
transport events retain their existing bounded journal retention and session cleanup.

## Verified Native Baseline

On 2026-10-28, authorized macOS Local verification uses the existing managed Claude Code token
connection, SDK 0.3.296 / Claude Code 2.1.296 and claude-opus-5-5 (Opus, High). Three chat-only
answers produce no tool, command or approval activity; the third emits a native next-message
suggestion. Use suggestion inserts its exact text into the composer, keeps the session idle and
leaves the durable user-message count unchanged. The native prediction path denies tools and
excludes its fork from the conversation transcript. Native silence on the first two answers is
accepted as absence, without retry generation or a failed primary answer.

The same host verifies a successful gpt-6.1-sol answer through managed Codex ChatGPT sign-in and
the explicit unsupported-version feedback for Codex 0.162.1. Credential-free native probes reproduce
the protocol-level refusal on macOS and in Docker. Deterministic fixtures cover a newer runtime
returning a correlated prediction. These results do not claim Windows or Linux native Local
acceptance or a live successful Codex prediction on the unavailable pinned binary.

## Verified History UI

On 2026-11-09 the production local runtime passes normal child Core password login/app PKCE,
transcript placement, retained choices after reload, guarded literal insertion, Tab/Shift+Tab,
undo, draft precedence, same-UUID lost-reply recovery and mobile dark layout with zero automatic
sends. `HOSTY_SUGGESTIONS_BROWSER=1 npm run test:integration -- harness-local` uses controlled
prediction events and action receipts in browser-test memory; these are UI evidence rather than
native inference or backend durability. Separate real sessions integration verifies Core-validated
history capabilities, exports and sharing/revocation; unit/API tests exercise restart and action
receipt persistence. Production cold/warm/missing-output recovery and owner-managed Finish pass.

## Testing Expectations

- Adapter fixtures cover Claude post-result ordering, session correlation, suppression and errors;
  Codex fixtures cover experimental negotiation, exact turn matching, null/failure/refusal,
  duplicate notifications and an unavailable-version-to-working-version transition.
- Worker and coordinator tests cover thirty-second collection expiry, confirmed-exit receipts, cancellation,
  disabling during the primary and optional phases, foreground preemption, failure recovery,
  durable correlation, choice UUID replay, ownership, availability after elapsed time and context reconciliation,
  transient availability and task/translation exclusion. Mixed protocol versions fail explicitly.
- Composer tests cover Tab/Shift+Tab, Escape, IME, literal mentions, undo, foreign/legacy
  events, draft precedence, concurrent choices, lost replies, guarded insertion and dismissal across reload.
  History tests cover extension capability, exports, safe attachment labels and explicit sharing disclosure. Managed browser acceptance covers
  normal Core login, draft-only acceptance, authenticated transport, mobile dark layout and restore.
  Its controlled prediction events are UI evidence, not live provider inference.
- Run `npm run harness:build-web`, `npm run harness:test`, `npm run harness:lint`,
  `npm run build:local --workspace @haas/hosty-harness` and affected integration suites
  `worker`, `harness-local`, `sessions` and `tasks`. The gateway static-page test needs the web export.
- Native contract probes use isolated homes and no provider credentials. Live provider evidence
  records the actual version/model/runtime and whether a suggestion was observed; account limitations
  and untested platforms remain explicit. Sandbox completion verifies owner-managed resource removal.

---
created: 2026-11-03
updated: 2026-11-10
summary: Responsive composer controls with a durable message stack, transcript suggestions, shared agent settings and capability-aware dictation.
components: [apps/harness]
---

# Compact Harness Composer Controls

The shared chat, workspace and embedded composer has one action row: Add, Agent settings,
Autonomy, Provider limits when applicable, Context usage, Dictation and Send. While the agent is
running, Send adds another message to the queue and a separate Stop button controls the current
response. The supported
minimum chat-pane width is 360 CSS px. The context ring and percentage remain visible. Independent
pane scrolling and retained drafts follow [Harness Development](../harness-development-ui/feature.md).

Context and provider limits share a compact ring shape with distinct center icons: stacked pages
for used context, an hourglass for remaining account allowance. Both percentages stay visible at
narrow widths; the `used` and `left` suffixes appear from a 640 CSS px composer width. Context is
neutral and limits blue until their respective warning thresholds. Unknown limits use a dashed
ring and `?`; their popover retains detailed observations and Refresh.
Both percentage labels use the same monospace font, size and regular weight, including inside the composer action row.
Below 640 CSS px the action row uses 24 px icon controls, a 32 px Send button and
20 px rings. Recording controls include the signal meter, elapsed/limit display, Stop and Cancel.

## Agent Settings

One Brain icon button opens an upward popover containing profile, provider connection,
model and reasoning fields. The button displays the confirmed model and effort when its composer
container is at least 640 CSS px wide, truncates long labels, and otherwise shows only the icon.
Its accessible name and tooltip retain the full selection at every width. Container queries use
the actual composer width, including when navigation, workspace details or an embedded host reduce
available space inside a wide browser window.

Before the first message, profile/provider selection follows the existing
[profile rules](../agent-profiles/feature.md) and
[connection rules](../ai-gateway-providers/feature.md#chats-and-capabilities). After start, profile
and exact provider/account appear as read-only rows with a lock and explanation. A selected
profile also fixes its provider before start. Accepted tasks retain immutable selection controls.
The panel remains readable while editing is unavailable. Choosing a different provider keeps the
common panel open and replaces the model catalog for that binding.

Model choices use a bounded scrolling picker. Reasoning levels come from the selected model's
catalog, in catalog order; they are not promises about price, latency or token budget. Multiple
ordinal levels use a discrete slider with the selected label. Pointer movement previews locally
and persists once on release; keyboard changes persist supported values and retain focus. A
separate Default action persists null, distinct from the lowest explicit level. Boolean thinking
uses a switch, a single supported level uses an explicit selection button, and models without
levels show an explanation. Unknown saved values remain visible as unavailable and are never
silently substituted. A model change retains effort only when the destination supports it.

Saving preserves the session's revision checks and blocks Send until persistence settles.
Confirmed values remain authoritative after failure. Settings controllers remain mounted while
the panel is closed, so closing it does not discard a pending result or prevent default adoption
and provider recovery. Credential changes and legacy original-account confirmation retain their
existing rules. Errors and recovery notices remain visible beneath the row when the panel is
closed; opening it exposes their detailed controls and retry actions. Autonomy errors also render
beneath the action row.

## Remembered Manual Choices

The browser remembers the last successfully saved manual model and reasoning pair per provider
connection, plus the last explicitly saved autonomy mode. Preferences belong to the current
Harness origin and authenticated user. They contain no profile selection, conversation identifier
or credentials. Merely opening a chat, receiving its updates or reading a profile does not change
them. A deliberate model override on a profiled chat is a manual choice and can be remembered
for later chats without a profile.

New ordinary, workspace and building chats send these optional browser defaults with their creation
request. New feedback-chat review displays the remembered choices before Send. The server selects
the profile and provider first, then validates an applicable remembered model/effort against that
provider's current catalog. A selected/default profile wins over remembered model settings; explicit
creation settings win over either remembered value. Unsupported pairs and unavailable catalogs
leave the usual defaults available. Admitted task settings stay fixed.

Creation stores the resulting settings atomically. A repeated creation request returns its original
chat even when browser defaults change. Opening an existing chat never replaces its settings with
browser preferences. Defaults carry their authenticated owner so an account switch between loading
preferences and creating a chat cannot apply another user's settings. Browser storage failure,
corrupt/oversized records and missing identity leave normal chat creation available. Preferences
survive reloads in that browser; browser storage clearing removes them and they do not synchronize
between browsers or origins.

## Message Stack And Draft Recovery

The message stack sits immediately above the composer. Send captures the current text and
attachments; after that snapshot is safely staged, the composer accepts the next draft while
uploads and server submission continue. Text entered after the captured snapshot remains in the
composer. Draft changes belong to their conversation: typing in B while A is submitting does not
leave A's unchanged submitted text in its composer after returning to A. Deliberately editing A
again preserves that replacement, including identical text. The stack shows uploading, saving and
sending states on the corresponding message,
with inline errors and Retry controls. The previous amber sending banner is absent. A message
with an unconfirmed send stays locked while its original request is reconciled.

The server owns accepted queued messages and their attachment bytes, and dispatches them in order
after the active agent turn. Queued messages use single-line previews, a left drag handle (also
operable with arrow keys), hover/focus edit and delete actions, and compact attachment counts.
The queue can be paused. Sending entries lose edit/delete controls. Browser outbox records preserve pending
uploads and exact command identities across reloads, scoped to the Harness origin, installation,
owner and conversation. Storage failures retain recoverable rows and preserve an unsaved composer.

When a local upload or enqueue is confirmed rejected before admission, Recover draft moves its
original text and files into Saved drafts, removes that local head and lets later messages proceed.
The current composer stays intact. This transfer is atomic; unavailable storage or a full Saved
drafts allowance keeps the original row. Uncertain requests retain Retry and cannot be recovered
into a replacement send. For durable local rows, a separate journal records each actual HTTP attempt
under its own local identity while retries keep their original server command identity; one call's
rejection cannot authorize discarding another call with an unknown outcome.

Editing first retains the current draft and attachments, reserves the queued entry, then restores
that message in the composer. The edit buffer is separate from ordinary draft synchronization.
Save or Cancel restores the stashed draft after confirmation; uncertain operations retain their
original Retry identity. Each document has its own editor identity, and a reload or another view
uses Recover edit explicitly. Stored edit text and file bytes support recovery without silently
overwriting a newer draft. Browser buffers are stored per queued entry and reservation, so editing
a different row in another tab preserves both rows' pending files and stashed drafts across reloads.
Legacy browser edit storage migrates with its bytes intact. Submission or an edit-destination change
also invalidates dictation results belonging to the previous composer destination.

When another tab has a newer ordinary draft, finishing an edit keeps it in the composer and
retains the earlier stashed draft under Saved drafts. Restore preserves the current draft before
replacing it. A live reservation takeover also preserves the displaced editor's local buffer;
the old view cannot continue saving against the transferred reservation.

## Suggestions In The Transcript

Suggestions appear as separate cards in the conversation history. Each card retains its literal
text and selected-for-draft, dismissed, expired or superseded state. Use suggestion inserts into
an empty ordinary draft, and Dismiss records that choice. Selection never sends a message by
itself. A populated draft or active queue edit disables insertion and explains how to preserve
the current work. The inline Tab hint follows the available card; suggestion text is absent
from the input placeholder/overlay. See [Prompt suggestions](../assistant-prompt-suggestions/feature.md).

## Dictation

The microphone button starts dictation immediately. Recording uses three compact inline icons:
a five-bar microphone signal indicator, Stop and transcribe, and Cancel to discard the recording. Starting
and transcription show a spinner and retain cancellation. Recording status is announced to assistive
technology, and a compact elapsed/maximum timer remains visible during recording. There is no
dictation popover. Provider
selection appears inline only when multiple providers need an explicit choice. On a narrow composer
its trigger is a compact chevron; the selected provider remains in its accessible value and tooltip.
Permission guidance,
errors, microphone release, conversation changes and late-result suppression retain their existing
behavior.

Chat capture waits for ready WAV capabilities from the selected provider and uses the smallest
of its advertised duration, byte allowance and the 600-second Harness cap. An older two-minute
provider retains its lower limit. Recording stops shortly before the effective maximum, and WAV
conversion/upload enforce the same bound. Unavailable or invalid capabilities disable capture
with an explanation. The separate feedback recorder retains its shorter limit. See
[Longer chat recordings](../long-speech-recordings/feature.md).

The meter analyses the existing microphone stream locally using Web Audio. Bar height follows the
measured signal; a lightweight voice-activity estimate highlights likely speech using speech-band
energy, an adaptive noise floor and hysteresis. It is an estimate, not a guarantee of speech
recognition. It changes only the indicator, never trims or gates the recorded audio. No audio is
uploaded for metering and there is no second microphone request. The silent analysis graph is
released on stop, cancellation, submission and conversation/edit-destination changes. Metering failure leaves
recording available.

## Testing Expectations

- Preserve provider default adoption, legacy account confirmation, credential revision recovery,
  profile/task locks and concurrent configuration revision ordering.
- Verify slider keyboard focus, pointer preview versus commit, explicit Default, binary thinking,
  single-level and unsupported catalogs, unavailable values, retries and save failure.
- Verify remembered manual pairs and autonomy across new-chat entry points, per-user and per-provider
  isolation, profile/explicit-setting precedence, account-switch races, immutable creation replay,
  unavailable catalogs, corrupt/blocked storage and no writes from mounted profiles or failed saves.
- Close settings during persistence: retain the Send interlock, confirmed result/error and draft.
- While the agent runs, verify Send queues the next message and the separate Stop action remains
  available. Check inline upload/send failures and Retry without an amber sending banner.
- Verify FIFO with slow uploads, exact request replay after lost replies, actor/installation
  isolation, storage failures, unchanged snapshot cleanup and newer drafts during submission.
  Switch A to B, type in B and return to A before acknowledgement; keep B intact and retire only
  A's unchanged submitted draft. Preserve an intentionally re-edited identical draft in A.
- Recover definitively rejected local snapshots into Saved drafts without replacing the current
  composer or losing file blobs. Full storage preserves the failed row. Multiple HTTP attempts
  sharing an exact server request never permit recovery while another attempt remains unknown.
- Edit queued text/files with an existing draft, then Save/Cancel/reload/recover. Preserve stashed
  and edited bytes for different entries in separate views, migrate the legacy browser format,
  reject stale reservation writes and reconcile uncertain operations before cleanup.
- Verify transcript suggestion history and recorded choices, empty-draft insertion, disabled
  insertion during edits, Tab/Escape behavior and no automatic send or composer overlay.
- Check the real action row at 360, 390, 480 and 640 CSS px, including wide viewports with narrow
  panes, light/dark themes, long model names, unknown and over-limit context usage. All supported
  actions remain visible without wrapping, overlap or horizontal toolbar scrolling.
- Check popover collision handling, focus return and nested model/provider menus in standalone and
  Shell-embedded Harness through normal Core login in a managed sandbox.
- Verify dictation provider selection, microphone release, cancellation and late transcript
  suppression through the compact entry point, elapsed/limit feedback, a 600-second fixture and
  lower provider duration/byte limits. Use controlled provider/model/usage fixtures when
  browser checks do not require real inference or credentials.

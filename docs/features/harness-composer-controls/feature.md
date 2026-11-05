---
created: 2026-11-03
updated: 2026-11-05
summary: One responsive composer action row with a shared agent-settings panel and catalog-driven reasoning controls.
components: [apps/harness]
---

# Compact Harness Composer Controls

The shared chat, workspace and embedded composer has one action row: Add, Agent settings,
Autonomy, Provider limits when applicable, Context usage, Dictation and Send/Stop. The supported
minimum chat-pane width is 360 CSS px. The context ring and percentage remain visible. Independent
pane scrolling and retained drafts follow [Harness Development](../harness-development-ui/feature.md).

Context and provider limits share a compact ring shape with distinct center icons: stacked pages
for used context, an hourglass for remaining account allowance. Both percentages stay visible at
narrow widths; the `used` and `left` suffixes appear from a 640 CSS px composer width. Context is
neutral and limits blue until their respective warning thresholds. Unknown limits use a dashed
ring and `?`; their popover retains detailed observations and Refresh.
Below 640 CSS px the action row uses 24 px icon controls, a 32 px Send/Stop button and
20 px rings, leaving both percentages and the recording meter, Stop and Cancel visible together.

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

## Dictation

The microphone button starts dictation immediately. Recording uses three compact inline icons:
a five-bar microphone signal indicator, Stop and transcribe, and Cancel to discard the recording. Starting
and transcription show a spinner and retain cancellation. Recording status is announced to assistive
technology; there is no visible recording label or duration, and no dictation popover. Provider
selection appears inline only when multiple providers need an explicit choice. On a narrow composer
its trigger is a compact chevron; the selected provider remains in its accessible value and tooltip.
Permission guidance,
errors, microphone release, conversation changes and late-result suppression retain their existing
behavior.

The meter analyses the existing microphone stream locally using Web Audio. Bar height follows the
measured signal; a lightweight voice-activity estimate highlights likely speech using speech-band
energy, an adaptive noise floor and hysteresis. It is an estimate, not a guarantee of speech
recognition. It changes only the indicator, never trims or gates the recorded audio. No audio is
uploaded for metering and there is no second microphone request. The silent analysis graph is
released on stop, cancellation, send blocking and conversation changes. Metering failure leaves
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
- Check the real action row at 360, 390, 480 and 640 CSS px, including wide viewports with narrow
  panes, light/dark themes, long model names, unknown and over-limit context usage. All supported
  actions remain visible without wrapping, overlap or horizontal toolbar scrolling.
- Check popover collision handling, focus return and nested model/provider menus in standalone and
  Shell-embedded Harness through normal Core login in a managed sandbox.
- Verify dictation provider selection, microphone release, cancellation and late transcript
  suppression through the compact entry point. Use controlled provider/model/usage fixtures when
  browser checks do not require real inference or credentials.

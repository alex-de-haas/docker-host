---
created: 2026-11-03
updated: 2026-11-03
summary: One responsive composer action row with a shared agent-settings panel and catalog-driven reasoning controls.
components: [apps/harness]
---

# Compact Harness Composer Controls

The shared chat, workspace and embedded composer has one action row: Add, Agent settings,
Autonomy, Provider limits when applicable, Context usage, Dictation and Send/Stop. The supported
minimum chat-pane width is 360 CSS px. The context ring and percentage remain visible. Independent
pane scrolling and retained drafts follow [Harness Development](../harness-development-ui/feature.md).

## Agent Settings

One Brain icon button opens an upward popover containing profile, provider connection,
model and reasoning fields. The button displays the confirmed model and effort when its composer
container is at least 440 CSS px wide, truncates long labels, and otherwise shows only the icon.
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

## Dictation

A single microphone button opens the dictation panel. Provider selection, recording controls,
transcription progress and errors stay inside that panel rather than widening the action row.
Opening settings does not request microphone access; Dictate starts capture. A running dictation
shows an activity indicator on the trigger. Closing the panel preserves the operation, while
conversation changes, cancellation and send blocking retain their existing cleanup behavior.

## Testing Expectations

- Preserve provider default adoption, legacy account confirmation, credential revision recovery,
  profile/task locks and concurrent configuration revision ordering.
- Verify slider keyboard focus, pointer preview versus commit, explicit Default, binary thinking,
  single-level and unsupported catalogs, unavailable values, retries and save failure.
- Close settings during persistence: retain the Send interlock, confirmed result/error and draft.
- Check the real action row at 360, 390, 480 and 640 CSS px, including wide viewports with narrow
  panes, light/dark themes, long model names, unknown and over-limit context usage. All supported
  actions remain visible without wrapping, overlap or horizontal toolbar scrolling.
- Check popover collision handling, focus return and nested model/provider menus in standalone and
  Shell-embedded Harness through normal Core login in a managed sandbox.
- Verify dictation provider selection, microphone release, cancellation and late transcript
  suppression through the compact entry point. Use controlled provider/model/usage fixtures when
  browser checks do not require real inference or credentials.

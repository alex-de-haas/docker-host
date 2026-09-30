# Speech Provider Hardware Acceptance

Status: Blocked
Created: 2026-09-29
Updated: 2026-09-29

## Goal

Complete hardware acceptance of the CPU speech provider on the owner's Windows/AMD host.
The owner approved implementation on 2026-09-29, explicitly excluding agent extraction and agent
interfaces, and requested a single pull request after implementation.

The implemented permissions, optional review, provider authority, independent Whisper app, both SDKs,
assistant handoffs and Harness dictation are described in [feature.md](feature.md). The PR covers that
complete implementation. This plan retains the remaining acceptance work instead of claiming that a
macOS run or generic Windows CI establishes performance on the owner's hardware.

## Deliverables

- [ ] Run the Core-managed Whisper app on the target Windows/AMD machine; verify CPU native loading,
      Russian and mixed-language recordings, silence, cancellation, repeated requests and restart.
      Record OS/CPU capabilities, selected model, latency, peak memory and recognition quality.
- [ ] Confirm browser microphone capture into Harness through the deployed Shell origin and check
      that recognized text remains editable, permissions can be revoked, and audio is not persisted.
- [ ] Update the verified platform evidence in `feature.md`, remove this plan and regenerate the index
      after these checks pass.

## Blocker

The development session has access to a macOS ARM64 host, not the owner's Windows/AMD server or its
microphone/browser deployment. Local Core-managed TypeScript and .NET consumer calls and native CPU
inference pass. CI runs the native model test on generic Windows/Linux/macOS runners. Those checks do
not replace target-device acceptance, and no Windows latency, GPU acceleration or human-dictation
accuracy claim is made.

## Verification

1. Install Core 0.115.0+ and the new Whisper manifest with the local runtime. Install .NET 10 SDK and
   the native runtime prerequisites documented in `feature.md`.
2. Start with `WHISPER_MODEL=small`; confirm `/capabilities` reports `whisper.cpp/cpu` and `ready: true`.
3. Install/update Harness, allow optional `providers.speech-to-text` through Core, and grant browser
   microphone consent on the deployed trusted origin. Test short Russian and mixed-language speech.
4. Check cancellation, conversation switching, permission revocation and process/model failure; retain
   existing drafts and never automatically send recognized text.
5. Repeat with `base` if latency/memory are unsuitable; make the choice explicit rather than silently
   reducing quality or using a cloud provider. Record measurements alongside the chosen model.

## Scope Boundary

`providers.agent` remains a name reserved for separate design work. This acceptance does not authorize
agent extraction, agent execution APIs, other Core Extension Model phases or Vulkan integration.

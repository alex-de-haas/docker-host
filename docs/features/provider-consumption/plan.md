---
status: In Progress
created: 2026-09-29
updated: 2026-10-10
summary: Remaining hardware measurements and edge-case acceptance evidence after the owner confirmed working speech recognition and dictation.
components: [apps/whisper]
---

# Speech Provider Hardware Acceptance

## Goal

Complete hardware acceptance of the CPU speech provider on the owner's Windows/AMD host.
The owner approved implementation on 2026-09-29, explicitly excluding agent extraction and agent
interfaces, and requested a single pull request after implementation.

The implemented permissions, optional review, provider authority, independent Whisper app, both SDKs,
assistant handoffs and Harness dictation are described in [feature.md](feature.md). The PR covers that
complete implementation. This plan retains the remaining acceptance work instead of claiming that a
macOS run or generic Windows CI establishes performance on the owner's hardware.

## Owner-Reported Functional Acceptance

On 2026-10-10 the owner confirmed that the speech provider has been tested and works, including
text dictation. The functional scenario is therefore no longer awaiting an initial owner test.
The report does not specify the machine, model, measurements or individual edge cases below.
Record existing results where available; this plan does not require repeating the successful
functional scenario merely because the agent did not perform it.

## Deliverables

- [x] D4. Record the owner's functional acceptance of the speech provider and text dictation, confirmed
      on 2026-10-10. This does not substitute for the detailed evidence in D1/D2.
- [ ] D1. Complete the hardware acceptance record beyond the confirmed functional scenario: identify
      the target Windows/AMD machine, OS/CPU capabilities and selected model; record latency, peak
      memory and recognition quality, plus results for CPU native loading, Russian and mixed-language
      recordings, silence, cancellation, repeated requests and restart.
- [ ] D2. Complete the browser acceptance record beyond confirmed dictation: identify the deployed
      Shell/Harness microphone path and record editable text, permission revocation and audio
      non-persistence checks.
- [ ] D3. Update the verified platform evidence in `feature.md`, remove this plan and regenerate the index
      after these checks pass.

## Evidence Boundary

The earlier blocker was the development session's lack of access to the owner's Windows/AMD server
and microphone/browser deployment. The owner's functional report now supplies direct usage evidence;
agent access is not required to accept that report. Local Core-managed TypeScript and .NET consumer
calls and native CPU inference also pass, and CI runs the native model test on generic
Windows/Linux/macOS runners. Neither those runs nor the functional report supplies the unreported
details in D1/D2. No Windows latency, GPU acceleration or human-dictation accuracy measurement is claimed.

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

`providers.agent` remains a name reserved for the separate
[agent and model provider Draft](../agent-provider-interface/plan.md). That plan owns agent
extraction and app-facing invocation design under the owner's 2026-10-10 direction. This speech
acceptance does not authorize those APIs, other Core Extension Model phases or Vulkan integration.

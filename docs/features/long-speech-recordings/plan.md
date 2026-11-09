---
status: In Progress
created: 2026-11-07
updated: 2026-11-09
summary: Extend Harness chat dictation and Whisper input to ten minutes with capability-aware limits, bounded processing deadlines and preserved cancellation.
components: [apps/harness, apps/whisper, packages/app-sdk]
---

# Longer Chat Speech Recordings

## Goal And Approval

The owner finds the current 120-second dictation limit too short. Propose a ten-minute maximum for
chat recording and Whisper, accounting for the selected provider's advertised limit. The owner
approved development on 2026-11-09. The existing
[speech provider feature](../provider-consumption/feature.md) describes current limits and transport.
Its [hardware acceptance plan](../provider-consumption/plan.md) retains its separate uncompleted
Windows/AMD evidence; this work does not claim that acceptance.

## Observed Baseline

The cap is enforced in the Harness capture timer, browser WAV conversion, Harness upload bytes and
Whisper's WAV parser/Kestrel limit. Raising only the timer produces a later upload or decode failure.
Whisper already advertises maxDurationSeconds and maxBytes through the speech capability API.
Harness, the TypeScript provider client and Whisper currently bound transcription to five minutes.
Long CPU recordings need a separately bounded processing deadline as well as a longer capture timer.

## Target Behavior And Contract

- Raise the Harness chat hard cap and Whisper maximum to 600 seconds. For mono 16 kHz PCM16 WAV,
  Whisper's maximum request size is 19,204,096 bytes including the existing bounded header allowance.
- Read existing provider capabilities and use the smaller of the Harness hard cap and the provider's
  advertised duration/byte allowance. An older 120-second provider keeps its actual lower limit.
  Missing, invalid or unavailable capabilities must not silently promise a ten-minute recording.
- Auto-stop just before the effective duration cap, with a compact elapsed/limit indication and an
  accessible status. Retain manual Stop, Cancel, microphone cleanup and transcript insertion only
  into the originating draft. Dictation never sends a chat message by itself.
- Bound Whisper processing to 15 minutes and its Harness/SDK consumer deadline to 15 minutes
  30 seconds, with linked cancellation throughout. Add a validated optional transcription timeout
  to the TypeScript SDK while preserving its current default for other consumers. Measure actual
  CPU behavior rather than claiming every model can process ten minutes within this deadline.
- Keep audio transient under the existing speech privacy policy, preserve single-recognition
  capacity and busy responses, and reject oversized/malformed input before unbounded allocation.

No new Core protocol is needed: use the existing speech capabilities/transcription interface.
Prepare/bind authorized Whisper source in the registered workspace before editing it, and verify
SDK source authority before changing that package. Do not modify a shared checkout or the live
Whisper installation to test this behavior.

The separate feedback recorder has its own shorter capture limit and JSON transport. Keep that
workflow within its existing limit; parameterize shared helpers where necessary rather than
inadvertently increasing every speech payload limit. The .NET consumer uses its caller-supplied
HttpClient timeout; update relevant usage guidance without changing that SDK unnecessarily.

## Deliverables

- [x] D1. Implement capability-aware chat capture/WAV/upload limits, duration feedback and preserved cancellation/draft insertion, including compatibility with a lower-limit provider.
- [x] D2. Raise Whisper's WAV/request limit and bounded processing deadline, add the optional TypeScript consumer timeout, verify the complete HTTP path supports that deadline and cover boundary/cancellation behavior.
- [ ] D3. Verify a long recording in a Core-managed child using independent Whisper data, record duration/latency/memory and platform limits, update affected feature docs and component versions, then remove this completed plan and regenerate the index.

## Verification And Completion

Browser fake-timer/audio fixtures must continue past 120 seconds, stop at the effective new cap,
respect a lower provider cap and release the microphone on cancellation/unmount/conversation change.
Test short/empty/silent audio, late permission and transcription replies, and preservation of a
draft changed while recognition runs. Measure browser conversion memory for the maximum fixture.

Whisper tests accept a valid 600-second PCM payload and reject one extra sample, byte overflow,
malformed chunks and invalid formats. Harness covers Content-Length and streamed overflow, error
copy and cancellation. SDK tests cover default/custom deadline validation and abort propagation.
Include regression checks that the feedback recorder retains its existing bound.
Check fetch/runtime and any proxy response deadlines on the actual supported HTTP path; a mocked
fetch test or a longer AbortSignal alone does not establish a 15-minute-30-second response window.

Run affected Harness/SDK tests and lint/build checks, Whisper .NET tests and the affected Whisper
integration suite. In an authorized child, verify normal Core password login, the advertised app
preview/microphone path and a synthetic or operator-supplied long Russian recording. Record model,
machine, processing latency, peak memory, cancellation and recognition result honestly; do not copy
live provider secrets or imply untested Windows/AMD performance. Export useful results before
owner-managed child cleanup, retaining a preview if the operator requests review.

Implementation bumps Harness, Whisper and TypeScript SDK versions according to their independent
release policies: Harness 0.96.0, Whisper 0.2.1 and TypeScript SDK 0.47.0. Publication, installation
and ordinary-data runtime activation remain separate authorized operations.

## Verified Implementation Evidence

On 2026-11-09 the affected Harness speech/audio/browser/feedback/local-runtime suites pass 68 tests,
the complete TypeScript SDK suite passes 798 tests, the SDK production build and Harness backend
typecheck pass, and Whisper WAV boundary tests pass 10 tests. The required
`npm run test:integration -- whisper` also passes both native tests, including the 600-second
repeated synthetic Russian fixture. A detailed macOS Arm64 run with the tiny CPU model records
5.09 seconds of inference and 8,307 recognized characters. The .NET runtime supplies no usable
peak-memory value on this platform; total/native memory and managed-child measurement remain
part of D3.

The standalone actual-Chromium maximum-conversion fixture also passes:
`node apps/harness/test/long-speech-browser.mjs` (Playwright selected through
`HOSTY_SPEECH_PLAYWRIGHT_MODULE`, or the shared `HOSTY_QUEUE_PLAYWRIGHT_MODULE` override). On
macOS Arm64 with Chromium 156.0.8078.80, the in-memory 600-second waveform converts through
`recordingWave` in 430 ms to exactly 19,200,044 bytes of 16 kHz mono PCM16 WAV; the encoder rejects
one extra sample. Fourteen CDP observations at a nominal 20 ms interval record JS heap before /
sampled peak / after of 1.20 / 30.13 / 1.36 MiB and peak backing storage of 73.25 MiB. These
partial metrics exclude total renderer/native audio RSS, fixture-preparation peaks and possibly
short peaks between samples. This synthetic localhost unit fixture verifies no microphone,
cancellation, normal Core login, managed-child identity or deployed transport behavior. D3 remains
open for those managed-runtime and memory boundaries.

The real SDK HTTP test first demonstrates a shorter response-header deadline, then completes a
delayed response using the request-owned matching Undici fetch/dispatcher. The supported local
path uses direct advertised app/provider origins after Core authority and binding calls, so Core
adds no audio proxy timeout. External ingress remains deployment-specific and is not established
by local evidence. D3 retains actual child identity/microphone and memory verification.

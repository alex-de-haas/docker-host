---
created: 2026-11-09
updated: 2026-11-09
summary: Chat dictation supports capability-aware recordings up to ten minutes with bounded CPU transcription and cancellation.
components: [apps/harness, apps/whisper, packages/app-sdk]
---

# Longer Chat Speech Recordings

## Capture And Upload

Harness chat dictation uses the existing speech provider capabilities contract. Capture is available
after the selected provider reports interface version one, ready WAV support and finite usable
duration/byte limits. Failed discovery, unavailable models and invalid capabilities keep capture
disabled with an explanation. Capability replies from a previous provider or conversation are ignored.

The capture limit is the smallest of 600 seconds, the provider's duration and its byte allowance
for mono 16 kHz PCM16 WAV with a canonical 44-byte header. A ten-minute chat payload is 19,200,044
bytes. A provider advertising 120 seconds retains that limit, and a tighter byte budget reduces
capture duration. Recording shows elapsed/maximum time and stops shortly before its limit; manual
Stop and Cancel remain available. Encoded browser recordings have a separate 32 MiB memory bound.

Browser WAV conversion and the Harness backend enforce the effective bound independently. The
backend rechecks provider authorization, availability and current capabilities before buffering
audio, and rejects both declared and streamed overflow. Audio travels directly from Harness to the
explicit provider under the [existing privacy and permission contract](../provider-consumption/feature.md).
It is neither persisted nor logged. Dictation inserts text into the originating editable draft
without sending a message. Cancellation, disable, unmount and conversation changes stop media
tracks and invalidate late results. The feedback recorder retains its existing one-minute capture
and two-minute WAV conversion limits.

## Provider And Transport

Whisper 0.2.1 accepts at most 600 seconds and 19,204,096 bytes, including its existing bounded WAV
header allowance. Its capabilities endpoint reports these actual limits. PCM/sample validation
rejects even one extra sample, including a payload still within the header byte allowance.
Recognition has one active slot, returns 429 when occupied and propagates cancellation into native
CPU processing. Its operation deadline is fifteen minutes.

Harness uses a fifteen-minute-thirty-second total request deadline. TypeScript SDK 0.47.0 exposes
an optional `timeoutMs` integer in `transcribe` between 1 and 930,000 milliseconds, preserving the
five-minute default. A request-owned Undici fetch and dispatcher align header/body timers with
that deadline and close after the response. This avoids lower transport limits and differences
between Node's bundled fetch and an independently versioned Undici handler interface. Authority
issuance retains its ten-second bound; redirects remain refused. The .NET SDK uses the calling
application's HttpClient timeout and cancellation token.

On the supported local path, Core supplies authority and endpoint bindings; audio and results use
the apps' direct HTTP origins. Core adds no transcription proxy deadline. External ingress or an
operator-supplied reverse proxy can impose its own response limits and requires deployment-specific
verification; local transport evidence does not establish those external limits.

## Verification Evidence

On 2026-11-09, local macOS Arm64 unit checks cover ten-minute PCM encoding/decoding, one extra
sample, malformed and oversized audio, provider byte/duration limits, auto-stop, late replies and
cancellation. A real local HTTP test demonstrates a lower response-header timeout, then accepts a
delayed response through the SDK's independent bounded transport. Native tiny-model CPU inference
recognizes the repeated synthetic Russian fixture at 600 seconds: one detailed run takes 5.09
seconds and returns 8,307 characters. The .NET runtime supplies no usable peak-memory value on
this platform. This checks interoperability rather than natural-speech quality and makes no
Windows/AMD performance claim.

A parent-managed child run on 2026-11-09 also verifies the authenticated production Harness →
Whisper HTTP path with independent tiny-model cache and the 600-second repeated Russian WAV.
The 19,200,044-byte request takes 5.602 seconds and returns 8,307 characters. Forty-three native
process-tree observations at a nominal 100 ms interval report summed RSS before / sampled peak /
after of 446,906,368 / 927,514,624 / 787,447,808 bytes and a process-tree CPU accounting delta of
18.21 seconds. These partial measurements can double-count shared pages and miss peaks; they are
neither a complete native allocation profile nor system peak memory.

The same child passes Chromium 156 acceptance through normal Core password login and the
advertised Core preview/Harness launch origins. Real MediaRecorder captures a controlled Russian
WAV microphone source for 5.5 seconds, shows the 600-second capability limit, inserts recognized
text into the existing draft and sends zero messages. All microphone tracks end on Stop/Cancel.
A separate generated 600-second HTTP request occupies the actual Whisper CPU slot, is aborted
by the browser and releases that slot within 22 ms. The oversized Content-Length probe returns
the expected 413 rejection. The parent confirms Finish and resource removal. The maximum payload
and short real-time microphone recording are separate checks; this evidence does not claim ten
minutes of wall-clock capture, a physical microphone, natural-speech quality or external ingress.

The standalone `apps/harness/test/long-speech-browser.mjs` fixture also exercises the actual
`recordingWave` Web Audio conversion in headless Chromium 156.0.8078.80 on macOS Arm64. On
2026-11-09, a deterministic in-memory 600-second waveform converts in 430 ms to a 19,200,044-byte,
16 kHz mono PCM16 WAV. One extra PCM sample is rejected by the encoder. CDP reports 1.20 MiB of
JS heap before conversion, 30.13 MiB sampled peak and 1.36 MiB afterwards; sampled ArrayBuffer
backing storage reaches 73.25 MiB. There are 14 observations with a nominal 20 ms sampling interval.
These are separate partial metrics, not total renderer/process memory: native audio allocations,
fixture preparation peaks and short peaks between samples are not fully represented. The fixture
uses a synthetic localhost origin and neither microphone access nor a managed Hosty runtime.
It does not establish cancellation, natural speech quality or deployed authentication/routing.

## Testing Expectations

- Browser fixtures continue past 120 seconds, respect duration and byte caps, stop at the effective
  limit and release tracks/analysis on every cancellation path. Maximum-length conversion includes
  memory measurement in a real browser. Existing draft text/attachments and changed drafts survive.
- Harness rejects unavailable capabilities, unauthorized providers and both Content-Length and
  streamed overflow; disconnects cancel the provider request.
- Whisper tests accept 600 seconds, reject one extra sample, byte overflow and malformed/unsupported
  WAV, and preserve silence/capacity/cancellation behavior. `npm run test:integration -- whisper`
  explicitly enables native CPU inference, including the long synthetic Russian fixture.
- SDK tests preserve default deadlines, validate custom deadlines, refuse redirects, propagate
  aborts and exercise actual delayed HTTP responses with a lower independent transport timeout.
- Core-managed child checks use normal password login, independent Whisper data and advertised
  Harness preview/microphone URLs; record model, machine, duration, latency and peak memory.
- Run `HOSTY_LONG_SPEECH_ACCEPTANCE=1 npm run test:integration -- harness-local` for the opt-in
  production-runtime path. It downloads a verified tiny model into independent child cache,
  reviews only optional speech access, sends the repeated 600-second Russian WAV through Harness
  and Whisper, then uses Chromium's controlled WAV microphone for real MediaRecorder/draft-only
  insertion and HTTP cancellation/CPU-slot recovery. `HOSTY_SPEECH_PLAYWRIGHT_MODULE` selects an
  installed Playwright module and `HOSTY_SPEECH_BROWSER_CHANNEL` an installed Chromium channel.
  Distinguish the short real-time UI recording from the maximum payload and keep sampled
  process-tree CPU/RSS evidence separate from full native peaks. The parent fixture owns cleanup.
- Run `node apps/harness/test/long-speech-browser.mjs` with Playwright and Chrome installed. An
  existing Playwright module can be selected with `HOSTY_SPEECH_PLAYWRIGHT_MODULE`; an alternate
  installed browser channel uses `HOSTY_SPEECH_BROWSER_CHANNEL`. Keep sampled heap/backing-storage
  measurements distinct from total native/process memory and managed-runtime acceptance.

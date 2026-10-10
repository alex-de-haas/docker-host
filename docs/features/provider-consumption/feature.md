---
created: 2026-09-29
updated: 2026-10-10
summary: Apps discover and call confirmed speech-to-text and assistant providers with short-lived Core credentials.
components: [apps/core, packages/app-sdk, packages/app-sdk-dotnet, apps/whisper, apps/harness]
---

# Provider Consumption And Speech Recognition

## Permissions And Review

Core 0.115.1 accepts `providers.speech-to-text` and `providers.assistant`. Each grants discovery and
use of every confirmed provider in its category, including later installations. There is no separate
use permission or per-provider ACL. Supply roles are `speech-to-text` and `assistant` in `provides`;
roles require installation/update confirmation. Ordinary runtime apps can supply and consume these
interfaces. Agent connections remain inside Harness; `providers.agent` is not accepted.

`corePermissions` is required authority. `optionalCorePermissions` is optional authority. Lists must
contain known, unique, disjoint names. Core confirmation offers optional choices unchecked on install,
preserves previously selected unchanged choices on update, and removes grants for removed declarations.
New declarations and optional-to-required transitions require review. Core stores declarations, grants
and a permission revision independently of the live source manifest. Restart and source adoption do
not grant permissions.

Shell's administrator-only Permissions tab shows accepted declarations, effective grants and the
current manifest. Required changes and optional choices use isolated Core permission-only confirmation,
including live development edits and legacy installations. A delegated app can request review only
for itself using `permissionsAppId`. Confirmation is bound to installation, permission revision,
source/runtime and the complete manifest digest. See [App permission management](../app-permission-management/feature.md).
Changing optional grants invalidates an already reviewed update plan: enqueue rejects it synchronously
before marking the app as updating or starting background work. Interface contract validation identifies
the declared provider category in both the error code and message.

## Discovery And Authority

Server-side SDK clients use the calling app's `HOSTY_APP_ID`, `HOSTY_CORE_ORIGIN` and
`HOSTY_APP_SERVICE_TOKEN`. Internal Core routes are:

| Method and route (below `/api/internal/apps/{appId}`) | Behavior |
| --- | --- |
| `GET /permissions` | Own required, optional and granted permission names |
| `GET /providers/{kind}` | Confirmed providers in an authorized category |
| `POST /providers/{kind}/token` | `{ providerAppId, key }` selects exactly one interface |
| `POST /provider/introspect` | Provider validates `{ token, kind, key }` on every request |

Descriptors contain app ID, name, category, interface key/version, capabilities, URL and availability.
Discovery and credential issuance resolve provider API URLs from the endpoint's direct transport
address. Generated browser hostnames and configured public origins are excluded from backend calls,
so local speech recognition does not depend on browser-only name resolution or public ingress.
Core 0.125.0 also includes `uiSurfaces` for assistants: declared panel, navigation and entrypoint
endpoint identities, paths and resolved browser URLs. Consumers validate handoff destinations
against these surfaces without an additional `apps.read` grant or an assumption that API and UI
share an origin. SDK 0.24.0 exposes this additive field; older Core omits it. Plans 0.4.0 uses it
for [document discussions](../plan-tracking/feature.md#discuss-a-document).
Stopped providers remain discoverable but cannot receive a new credential. A running speech process
can still be loading its model; its capabilities response distinguishes inference readiness.

Core signs separate, two-minute `hosty_provider.1` credentials bound to both installations, both
permission revisions, the target category and key. Introspection checks live grants and availability;
revocation, updates, removal and reinstallation invalidate prior credentials. A provider cannot
introspect a credential for another provider. SDKs send the app service token only to Core and the
provider credential only to the selected endpoint. Audio travels directly from the consumer's backend
to the provider. Core stores neither audio nor recognition results. No automatic provider/cloud fallback
occurs. Grant changes block subsequent requests; they do not retroactively retract already accepted work.

Assistant calls additionally require `X-Hosty-User-Token`, an app identity or delegated token addressed
to the caller. Core checks the user's access to both apps. Harness retains its administrator-only policy,
accepts provider credentials only on `/api/assistant/v1/handoffs`, and binds handoffs to the acting user,
consumer app and consumer installation. These credentials do not grant access to other conversations,
settings, MCP, agent connections or general Core APIs. Finalization always uses a
draft-only policy for provider-originated handoffs, regardless of the immediate-handoff setting.
Only Harness's own operator clients can dispatch immediately. Provider credentials never become
general delegation.

## SDKs

TypeScript `@hosty-sdk/app` 0.17.0 exports browser-safe types from `/providers` and server-side
`ProviderClient` from `/providers/server`:

```ts
const speech = new ProviderClient();
const permissions = await speech.permissions();
const providers = await speech.list("speech-to-text");
// Persist/select the appId + key explicitly in the consuming app.
const selected = providers.find(p => p.appId === chosenAppId && p.key === chosenKey);
if (!selected) throw new Error("Selected provider is not installed.");
const result = await speech.transcribe(selected, wavBlob, { signal, language: "ru" });
```

`permissions`, `list`, `speechCapabilities`, `transcribe` and provider-side `validate` accept cancellation.
`assistant(selected, getUserToken)` returns the existing version-one `AssistantClient`, minting fresh
bounded authority per operation. Provider changes require explicit reconnection. Redirects carrying
credentials are refused. Assistant HTTP failures expose `AssistantError` with the provider status
and code. Shell preserves these refusals, including a 409 `request_conflict` when a request identity
is reused with different input, instead of reporting a transport failure.

.NET `HostySdk.App` 0.7.0 exposes `HostyProviderClient` with `PermissionsAsync`, `ListAsync`,
`SpeechCapabilitiesAsync`, `TranscribeAsync`, `ValidateAsync` and `SendAssistantAsync`. The latter sends
existing `/handoffs` operations with the acting user's credential. Supply an `HttpClient` with automatic
redirects disabled and a suitable transcription timeout, plus `HostyAppOptions.FromConfiguration(...)`.
Methods accept `CancellationToken`. Both SDKs retain stable HTTP status/error codes and refuse interface
versions other than 1. For container callers, loopback provider URLs are rewritten to the Core host's
`host.docker.internal` address; that address must be reachable from the container runtime.

## Whisper Runtime App

`apps/whisper/manifest.json` installs the independent `hosty.whisper` app (0.1.0) with local and source
development profiles. It is headless, has no system role and is not bundled into Harness. A .NET 10 SDK
and network access for NuGet/build and the first model download are needed for the source installation.
Whisper.net and its CPU native runtime are pinned to 1.9.1. The factory explicitly disables GPU use.

The native runtime's Windows baseline is Windows 11 / Windows Server 2022 or newer, the Visual C++ 2022
redistributable and an x64 CPU with AVX, AVX2, FMA and F16C. An AMD processor with those capabilities can
use this CPU path without a discrete GPU. Linux and macOS use the corresponding packaged native runtime.
The target Windows/AMD machine has not been exercised locally; hardware acceptance is tracked in the
[plan](plan.md). No Vulkan acceleration or Windows performance claim is made.

`WHISPER_MODEL` selects multilingual `tiny`, `base` or `small` (default). Fixed upstream revision
`5359861c739e955e79d9a303bcbc70fb988958b1`, sizes and SHA-256 hashes are in `SpeechEngine.cs`. Models are
verified on load and downloaded into `HOSTY_APP_CACHE_DIR`; an invalid download is rejected and its
temporary file removed. Restart applies a model change. Audio is processed in memory and is neither
saved nor logged. Empty/silent recognition returns empty text. The application logs model readiness
and failure categories without audio content.

The authenticated version-one endpoint is `/api/speech/v1`:

- `GET /capabilities`: version, media types, maximum bytes/duration, actual backend and readiness.
- `POST /transcriptions?language=ru`: raw `audio/wav`; optional language defaults to `auto`; returns
  `{ text, language }`, with null language when auto-detection was requested.
- Baseline audio is mono, 16 kHz, PCM16 WAV, bounded to 120 seconds and 3,844,096 bytes. Invalid formats
  are refused. There is one active recognition and no queue; additional requests receive 429.
- Cancellation propagates to native processing. The operation has a five-minute deadline. Missing
  credentials return 401, revoked access 403, unsupported media 415, busy 429 and unavailable model or
  Core authorization 503. `/healthz` reports process liveness while a model downloads.

## Harness Dictation

Harness 0.38.0 requests optional `providers.speech-to-text`. Its composer offers explicit provider
selection when multiple providers exist, record/stop/cancel controls, and recognition errors. The
browser converts completed recordings to the WAV baseline. Recording stops before 120 seconds; audio
capture requires a secure browser context (HTTPS or trusted loopback) and separate browser microphone
consent. Shell 0.90.0 delegates microphone access to an embedded app's origin only with the speech grant;
changing that grant remounts the frame to release the prior document's microphone resources.

Recognized text is appended to the current editable draft, preserving text and attachments and never
sending a message automatically. Cancellation, sending, unmount and switching conversations invalidate
late results and stop microphone tracks. Permission/provider errors retain the draft. An absent grant
leaves dictation disabled. When Core advertises permission review, the tooltip
points to Dashboard → Harness → Settings → Permissions → Review changes, including legacy declarations.
Older Core versions retain guidance based on their stored optional declarations. Source observation
alone never grants access.
The microphone's tooltip remains available on hover and keyboard focus when the button is disabled.
It distinguishes loading, discovery errors, missing consent, no providers, an unselected provider,
an unavailable provider and a message being sent. Discovery failures do not imply missing consent.


## Assistant Activity Authority

Assistant-provider issuance requires the consumer's current browser-established
[activity window](../app-activity-window/feature.md) and live parent Core session. Provider token
validation rechecks that activity; a delegated credential cannot replace it. Harness also uses its own app activity and live Core sign-in for MCP and workspace/publication tool
calls; conversations require no additional consent.

## Testing Expectations

- Core: optional defaults and updates, review-only mutation, stale consent, stored declarations,
  role confirmation, audience/category/installation binding, live revocation and user-access checks.
  Provider discovery and issued credentials use direct transport URLs for IPv4, IPv6 and LAN endpoints,
  including apps with a configured public origin; missing transport remains unavailable. Assistant
  API addresses use transport while declared UI surfaces retain their browser addresses.
  Grant changes in either direction must reject stale update enqueue without changing operation state;
  missing speech and assistant interface contracts must report category-specific validation errors.
- SDKs: credential separation, denied access, compatibility, cancellation and assistant handoff ownership.
- Whisper: malformed/oversized WAV, PCM decoding, silence, busy capacity, cancellation and actual native
  CPU inference. `HOSTY_WHISPER_INTEGRATION=1 dotnet test apps/whisper/Hosty.Whisper.Tests` downloads the
  pinned tiny model; `HOSTY_WHISPER_TEST_CACHE` optionally reuses a verified cache. The fixture is locally
  synthesized Russian speech: “Привет. Это проверка голосового ввода. Открой настройки приложения.”
  CI enables this test on Windows, Linux and macOS. The ordinary test run explicitly skips native inference.
- Harness/Shell: optional permission UI, iframe policy, editable insertion, cancelled/late results,
  conversation switching, existing composer actions and attachments.
- Integration uses Core-managed apps and real Core identity. Local macOS verification exercised Russian
  and mixed-language synthesized recordings through independent TypeScript and .NET consumers, a Core-managed
  Docker consumer and the authenticated Harness backend. Reviewed revocation returns 403 on the next
  Harness transcription. Browser verification confirms optional consent and iframe microphone delegation. Tiny
  recognition contains errors; this is interoperability evidence rather than an accuracy benchmark.

- With immediate handoffs enabled, provider-originated finalization remains a draft, while operator finalization dispatches immediately.

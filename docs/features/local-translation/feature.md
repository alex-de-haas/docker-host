---
created: 2026-10-26
updated: 2026-10-26
summary: Independent OPUS-MT Big CPU translation app for English-to-Russian text and protected Markdown, with pinned native dependencies and verified model caching.
components: [apps/opus]
---

# Local OPUS Translation

## Application And Integration

OPUS Translate (`hosty.opus`, version 0.1.0) is a headless native runtime app in `apps/opus`, with
independent version, manifest, main feed and icon. Like [Whisper](../../../apps/whisper/manifest.json),
it has local and development profiles, app-owned cache storage, logs and HTTP health. It has no
system role, app UI or requested Core permissions. Core discovers its ordinary version-one
`translation` interface under key `default`; production code has no provider-specific Core branch.

[Documents](../documents-app/feature.md) discovers translation providers through the existing scoped
provider contract. The user grants Documents its optional translation permission and explicitly
selects OPUS Translate. It does not replace or configure Harness agent providers. Provider failure
messages in Documents also apply to local apps. [The comparison](../translation-provider/feature.md#expanded-local-comparison-2026-10-26)
records the model choice and accepted draft quality. Source documents remain authoritative and are
never overwritten. Translation output is not stored by this app.

## Native Runtime And Model

Source setup requires Node.js 24 and `uv` on the host PATH. It builds the bundled Node HTTP service
and uses `uv` to install managed Python 3.13 in the Core-provided `HOSTY_APP_CACHE_DIR`. The Python
packages are pinned with hashes: CTranslate2 4.8.3, SentencePiece 0.2.2, NumPy 2.5.4 and PyYAML 6.0.3.
Python and uv downloads belong to this app's cache, rather than the operator's Python environment.

The resident Python worker loads the OPUS/Tatoeba `eng-zle` transformer-big checkpoint dated
2022-03-13, with the `>>rus<<` target prefix, INT8 CPU execution, beam size 1 and one inter-operation
thread. `OPUS_THREADS` defaults to 8, accepts 1–32, is capped at available CPU cores and takes effect
on app restart. Node passes the worker a limited environment without app/provider credentials.

First model preparation downloads exactly 889,214,325 bytes from the pinned
[OPUS archive](https://object.pouta.csc.fi/Tatoeba-MT-models/eng-zle/opusTCv20210807+bt_transformer-big_2022-03-13.zip),
verifies SHA-256 `10cb109270a1c96c7a43434f3ebc6d7eac73401d1ef204136e3ea5b198435679`, bounds extraction,
rejects traversal and symlink entries, converts the weights and atomically publishes the finished
model generation. A receipt hashes every converted file. Startup verifies it; corruption rebuilds
from the verified archive. Incomplete downloads and staging directories are cleaned up. Allow at
least 4 GB of free cache space during initial preparation. After setup and preparation, inference
requires no model-service network connection; each API request still validates authority with Core.

The original model is supplied by the OPUS-MT/Tatoeba Translation Challenge project and carries
Creative Commons Attribution 4.0 in the archive's `LICENSE`. Its `README.md` and license are retained
alongside the converted weights. The transformation is CTranslate2 conversion and INT8 quantization;
there is no fine-tuning. The app's source uses the repository's AGPL-3.0-only license. The archive and
converted model are runtime cache artifacts, not repository files.

## HTTP Contract And Limits

The service binds to the Hosty-assigned HTTP port on loopback. `GET /healthz` reports process
liveness while the model initializes. Authenticated `GET /api/translation/v1/capabilities` reports
model readiness separately. `POST /api/translation/v1/translations` accepts the standard SDK request
and returns `text`, `sourceLanguage` and `targetLanguage`. Both provider routes validate the Core
invocation token on every request before reading document content. Responses disable caching.

- English to Russian is the only supported pair, including regional tags. Omitted source language
  and `auto` use the fixed English source; they do not perform language detection. Capabilities expose
  `sourceLanguages: [en]`, `targetLanguages: [ru]` and `autoSourceLanguage: en`.
- Markdown accepts up to 128,000 Unicode characters, plain text up to 16,000. Request and output
  bodies are bounded at one MiB; Markdown has at most 8,192 prose fragments.
- Prose is split into sentences and batches of at most 32 fragments. Every fragment, including its
  language prefix, must fit 512 model tokens. Overlong fragments and decoding-limit output are
  refused explicitly; input is not silently truncated.
- One request owns the worker at a time; concurrent translation receives HTTP 429. Model preparation
  exposes unavailable capabilities; translation receives 503 until ready.
- Requests have a 600-second deadline. Client disconnection, timeout or cancellation terminates active
  inference and reloads a clean worker from the verified cache. Requests are not replayed. Application
  shutdown stops the worker. Unexpected worker failure requires an app restart.

## Protected Markdown

The app parses CommonMark/GFM, translates decoded prose and escapes generated Markdown punctuation.
Frontmatter, code blocks, inline code, HTML, image markup, link destinations, reference definitions,
autolinks, shortcut/collapsed reference labels, task states, list markers and deliverable IDs remain
fixed. Ordinary link labels and headings translate. Entities, escaped punctuation and continuation
lines are handled as prose; inline formatting remains structural. Plain text keeps line boundaries.

A structural signature validates the reconstructed result before it is returned. Tests also compare
against the existing Harness provider validator without modifying that validator. Empty, incomplete,
multiline fragment output or changed protected structure fails the request. These checks protect
syntax and machine content, not the semantic accuracy of the model's prose.

## Verification On 2026-10-26

On macOS arm64, Apple M4 Pro (14 cores, 48 GiB RAM), native integration uses the pinned runtime and
real OPUS model. The first app-cache preparation reused the experiment's checksum-verified archive,
converted its weights and reached readiness in 5.175 seconds. A 250-character Markdown fixture took
66 ms; a 16,772-character repository document took 3.939 seconds. Both retained protected structure.
A subsequent verified-cache restart took 231 ms. These are local observations, not latency guarantees.

The opt-in integration suite also verifies overlong-fragment refusal, cancellation followed by a
usable worker, cache reuse without reconversion, and corrupted-cache reconstruction. No request text
is retained in the test cache. Ordinary unit tests run without downloading model weights.

Final checks pass: 14 Node app tests, three Python cache/archive tests, the real-model native suite,
eight Core manifest tests, 44 CI-policy/workflow/launcher tests, 147 Documents tests, both app builds,
version consistency, documentation validation and whitespace checks. The managed Python HTTPS probe
receives HTTP 206 from the pinned archive endpoint. Initial Documents checks used stale dependencies
from a temporary checkout symlink; replacing it with workspace-local lockfile dependencies resolves
those failures. Workflow YAML parses successfully; actionlint is not installed locally and was not run.

The Core manifest loader validates both runtime profiles. HTTP authorization tests use explicit
fixtures; they do not establish live Core identity. The available client exposes registered workspace
operations but no managed sandbox create/start/finish adapter, so installation, live provider
invocation and Documents/Shell UI integration were not exercised. No ordinary installed app, provider
selection, user data or running Core was changed. Linux and Windows native inference were not run.

## Testing Expectations

- `npm run opus:build`: type check and bundle the shipped entry point.
- `npm run opus:test`: Markdown/real-plan structure, language and size limits, capacity, live authority
  checks at the HTTP boundary, process failure, cancellation and credential-free worker environment.
- `python3 -m unittest discover -s apps/opus/runtime -p 'test_*.py'`: archive traversal/symlinks,
  checksummed cache corruption and bounded failed downloads. Requires Python 3.11 or newer.
- `npm run test:integration -- opus`: explicit local real-model preparation/inference, limits,
  cancellation, verified-cache restart and corruption recovery. Requires Node 24 and uv. A dedicated
  `HOSTY_OPUS_TEST_CACHE` reuses test artifacts; otherwise the temporary cache is removed afterward.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter FullyQualifiedName~RuntimeAppManifestRepositoryTests`: repository manifests, including OPUS local/dev.
- `node --test scripts/ci-policy.test.mjs scripts/ci-workflow.test.mjs scripts/test-integration.test.mjs`: component selection,
  required CI gate and opt-in native suite wiring. CI runs bounded Node and Python checks only.
- `npm run documents:test` and `npm run documents:build`: existing consumer behavior and generic
  provider diagnostics. Documents independently advances from 0.8.0 to 0.8.1; Core has no runtime change.
- `node scripts/check-versions.mjs`, `node scripts/docs-index.mjs --check`, `git diff --check`:
  version, documentation and whitespace consistency.

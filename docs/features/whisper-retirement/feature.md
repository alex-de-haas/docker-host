---
created: 2026-11-12
updated: 2026-11-12
summary: The obsolete Whisper app is retired while generic speech providers and Harness dictation remain supported.
components: [apps/core, apps/harness, scripts, distribution]
---

# Whisper Retirement

## Repository And Catalog

The owner retires the standalone Whisper application on 2026-11-12 in favor of Speech.
This repository contains no Whisper runtime, manifest, feed or model fixture. CI and release
selection, the release publisher, version validation and the local integration launcher omit the
retired artifact. The embedded update-source migration catalog omits Whisper migrations rather
than offering switches to its frozen release feed.
Historical retired CI-scope rejection guards and dated review evidence remain intact.

Speech is maintained independently. Core and both SDKs retain their generic speech-provider
contracts; Harness retains provider discovery, microphone capture, capability-aware limits and
draft-only dictation. The [provider contract](../provider-consumption/feature.md) requires no
specific application ID or bundled recognition engine. Upstream Whisper research references do
not install the retired app.

Marketplace reads its separate [catalog repository](https://github.com/alex-de-haas/hosty-catalog).
Removing this repository's manifest does not publish a catalog change. Production uninstallation,
retained source/data cleanup and catalog publication are distinct operations and require their
own observed results. Ordinary application removal preserves data, backups and source unless
explicit deletion options are selected; it does not affect another installed speech provider.

## Consumer Acceptance

The opt-in [long-speech fixture](../long-speech-recordings/feature.md#testing-expectations) takes
an explicit external manifest, declared production runtime and synthetic WAV. It preserves the
provider's source binding and settings and installs into the existing parent-managed child Core
with independent data/cache. The single-slot cancellation scenario has explicit compatibility
requirements; its historical Whisper measurements do not certify Speech or another engine.
Fixture-input checks do not establish browser or inference acceptance.

Removing obsolete migration metadata changes the Core embedded catalog; the platform version
advances from 0.179.4 to 0.179.5. Runtime application and SDK versions remain unchanged.

## Testing Expectations

- Build the exact Core project and run affected update-source migration tests for the embedded catalog.
- Run affected CI policy, integration-launcher and publication tests, version consistency and
  workflow lint where available. Keep retired-scope rejection coverage.
- Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/harness/test -p test_long_speech_fixture.py`
  and JavaScript syntax checks. Refuse implicit fixture paths, unrelated app declarations,
  development runtimes and unusable WAV input. Never sample Docker PIDs as local native processes.
- Validate documentation and relative links with `node scripts/docs-index.mjs --check --base <ref>`.
- Validate and build the separate catalog before publication; confirm Whisper is absent and the
  replacement's card and assets remain available in generated and published output.
- After an authorized production uninstall, observe the installed roster and replacement health.
  Report retained files and publication state separately from source-edit completion.

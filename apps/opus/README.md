# OPUS Translate

`hosty.opus` is an independent, headless Hosty translation provider. It runs OPUS-MT Big through
CTranslate2 CPU INT8 for English-to-Russian text and Markdown. Native profiles are `local` and `dev`.

Source installation requires Node.js 24 and `uv` on the host PATH. Hosty setup creates a Python 3.13
runtime in the app cache. First startup downloads and verifies an 889 MB model archive and converts
it to INT8. Allow at least 4 GB of free cache space during preparation. Later starts reuse the verified
cache. Documents can select this provider after installation and its usual Core permission approval.

See [the feature documentation](../../docs/features/local-translation/feature.md) for the provider
contract, model attribution, limits, prerequisites and verified test commands.

```sh
npm run opus:build
npm run opus:test
python3 -m unittest discover -s apps/opus/runtime -p 'test_*.py'
npm run test:integration -- opus
```

The last command requires `uv`, runs real native inference and downloads model/runtime dependencies
into a temporary test cache. Set `HOSTY_OPUS_TEST_CACHE` to a dedicated test-cache directory to reuse
it. It does not install an app or exercise live Core identity. Translation text is never saved in the
cache or logs. OPUS output is a draft reading aid; the original document remains authoritative.

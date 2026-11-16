---
created: 2026-10-15
updated: 2026-11-13
summary: Generic Core-scoped translation contracts and Documents consumption, with OPUS Translate as the sole shipped supplier and retained historical benchmark evidence.
components: [apps/core, apps/documents, apps/opus, packages/app-sdk, packages/app-sdk-dotnet]
---

# Translation Providers

## Contract And Selection

OPUS Translate is the repository's sole supplied translation app. Harness, Codex Provider and
Claude Code Provider do not expose translation interfaces or translation-account/model settings.
[Local OPUS Translation](../local-translation/feature.md) owns its native model, cache and language
support. Installing an agent provider does not install or configure a translator.

Core retains the generic confirmed supply role `translation`, category permission
`providers.translation` and version-one SDK contract. It discovers reviewed interface declarations
and current installation identities, without provider-name or application-ID rules. Consumers select
an installed `(appId, installationId, kind, key)` reference. OPUS declares the `default` interface at
`/api/translation/v1`; clients use the discovered interface rather than constructing its address.

The [provider authority protocol](../provider-consumption/feature.md) issues an invocation credential
for exactly the selected installation, category and key. Every invocation checks current grants.
Translation uses app authority without an acting-user assistant session, agent run, MCP tools,
provider account, or delegated chat credential. Consumer apps need their own reviewed translation
permission. A selected installation that disappears or becomes unavailable is reported explicitly;
consumers do not silently switch suppliers.

| Operation | Request | Response |
| --- | --- | --- |
| `GET /capabilities` | Exact-interface provider invocation credential | Version, supported formats/languages, limits, timeout, backend, readiness and optional reason |
| `POST /translations` | Same credential; JSON `text`, `targetLanguage`, optional `sourceLanguage` and `format` | Translated `text` and the requested source/target language tags |

`sourceLanguage` defaults to `auto`; `format` defaults to `text` and also accepts `markdown`.
Language values use bounded language tags. `auto` is valid only as a source language. OPUS supports
English to Russian, including regional tags, and treats `auto` as the fixed English source rather
than claiming language detection. Its capabilities declare `sourceLanguages: [en]`,
`targetLanguages: [ru]` and `autoSourceLanguage: en`.

Capabilities contain `version: 1`, `formats`, `maxCharacters`, `maxSegmentCharacters`, `maxBytes`,
`maxOutputBytes`, `timeoutSeconds`, `backend`, `ready` and an optional `reason`. Readiness describes
the local worker/model; it does not grant authority or trigger a translation. OPUS has no cloud
account, translation model selector or agent-account readiness extension.

## Markdown Plans

The supplier owns document processing. OPUS parses CommonMark/GFM, extracts decoded prose and
reconstructs the document while escaping generated Markdown punctuation. Leading YAML frontmatter,
code, HTML, image markup, link destinations/reference identifiers, task states, list markers and
deliverable IDs remain fixed. Ordinary link labels and headings translate. A structural signature
rejects changed protected content; it does not establish linguistic accuracy.

Markdown accepts at most 128,000 Unicode code points; plain text accepts 16,000. Request and output
bodies are bounded at one MiB. OPUS accepts at most 8,192 prose fragments, batches up to 32 at a time,
and refuses any fragment that exceeds its 512-model-token limit. Input and output are not silently
truncated. Its capability `maxSegmentCharacters` is 16,000; the local fragment token limit is an
additional model constraint. The source file is never written by the translation API.

## Execution And Failure Behavior

OPUS owns a pinned resident CTranslate2 CPU worker and verified model cache. After model preparation,
inference does not require a model-service network connection; each HTTP invocation still validates
its credential with Core. No agent CLI, native agent session, source workspace, chat history, skill,
MCP grant or chat prompt participates in translation.

One request owns the worker at a time; concurrent requests receive HTTP 429. Model initialization
reports unavailable capabilities and translation returns 503 until ready. Requests have a 600-second
deadline. Cancellation, client disconnection or timeout terminates active inference and reloads a
clean worker. Requests are not queued, retried or replayed, and there is no model/provider fallback.
Unexpected worker failure requires an app restart. Application shutdown stops the worker.

Routes validate current provider authority before consuming document input and disable response
caching. Ordinary browser cookies alone cannot invoke translation. Invalid input or unsupported
language pairs return 400, authority failures 401/403, bounds violations 413, busy capacity 429,
invalid output 502, unavailable runtime 503 and deadline expiry 504. OPUS does not persist request
text or translation output. Documents retains a temporary reading view rather than replacing source.

## SDK Usage

The server-only TypeScript client keeps the generic discovery and invocation API:

```ts
const client = new ProviderClient();
const providers = await client.list("translation");
const selected = providers.find(p =>
  p.appId === chosen.appId && p.installationId === chosen.installationId && p.key === chosen.key);
if (!selected) throw new Error("The selected translator is not installed.");
const capabilities = await client.translationCapabilities(selected, abortController.signal);
if (!capabilities.ready) throw new Error(capabilities.reason ?? "The translator is not ready.");
const result = await client.translate(selected, {
  text: markdownPlan,
  sourceLanguage: "en",
  targetLanguage: "ru",
  format: "markdown",
}, abortController.signal);
```

The .NET SDK exposes `TranslationCapabilitiesAsync` and `TranslateAsync` with
`HostyTranslationRequest`, `HostyTranslationResult` and `HostyTranslationCapabilities`. Supply an
`HttpClient` with redirects disabled and a timeout of at least 610 seconds, or an infinite timeout
with caller cancellation. Both SDKs check version one, retain service credentials inside Core calls,
pass cancellation through and verify the response's requested language tags. Removing agent-backed
suppliers does not remove the generic Core or SDK translation contract.

## Plans Consumer

Documents offers **Translate** above the selected Markdown document. The user grants its optional
translation permission and explicitly selects OPUS Translate and a supported target language.
Documents owns that selection and its temporary original/translation view, cancellation and failure
diagnostics. Current source authorization, displayed-byte fingerprints and installation identity
are checked before invocation. Source documents, workflow metadata and workspace diffs remain
authoritative. See [Plan Tracking](../documents-app/feature.md#translate-a-document-and-optional-permissions).

## Operator Preview Installation

This dated record describes the pre-extraction 2026-10-16 preview, rather than current installation
or credential setup. Its Worker image and embedded native runtime are retired.

On 2026-10-16, the operator's existing local installation was updated for interactive acceptance.
The preview was ported onto its installed release baseline `b996226e2c1574d6a34f0c0743147d54a3d98844`,
preserving the newer Sandbox permissions and Harness execution-mode settings. A separate managed
worktree named `plans-translation-preview` supplied Core 0.136.0, Harness 0.54.0 and Plans 0.7.0 in
source development mode. Shell 0.103.1 and Workspaces 0.4.0 remained running at their existing versions.
The worktree was retained as a runtime dependency for that preview. No release was published.

Harness translation settings selected the existing Codex connection with `gpt-6-luna` and the existing
Claude connection with `claude-haiku-5-5`. Chat defaults and native execution mode were preserved.
Plans retained its existing optional grants and additionally received `providers.translation`.
Core created pre-update backups for Harness and Plans. The local agent-worker image was rebuilt at
0.54.0 so the retained Docker execution option has the matching image available.

A live browser check translated `docs/features/accent-presets/plan.md` from the tracked public branch
to Russian through both variants. Both requests succeeded and passed the production Markdown validator;
headings, inline code, links, D1/D2 and unchecked tasks rendered correctly. **Show original** restored
the English reading view. Plans service logs reported complete HTTP request times of 8.6 seconds for
Claude and 15.3 seconds for Codex, one run each; these include source validation and provider transport
and were not a repeated latency benchmark. The plan also loaded within Shell. Translation interaction
was checked in the normally authenticated app window because the browser automation tool could not click
controls inside this Shell iframe; earlier isolated embedded-flow coverage remains recorded in
[Plan Tracking](../documents-app/feature.md#translate-a-document-and-optional-permissions).

## Measured Behavior

The following agent-backed results are historical measurements from October 2026. Those adapters
and their executable benchmark/native-policy probes are retired. The tables and raw evidence remain
for comparison; they do not describe current providers, account settings or reproduction commands.

On 2026-10-15, macOS arm64, English to Russian, low effort, fresh isolated profiles per document,
sequential segments, no Harness result cache. In the initial baseline, both backends use their native default model;
Claude reports `claude-sonnet-5-5`, while the Codex exec event stream does not identify its model.
These compare the configured services, not identical models or billing tiers.

| Synthetic input | Codex runs, seconds | Claude runs, seconds | Median Codex / Claude | Segments |
| --- | --- | --- | --- | --- |
| Paragraph, 285 code points | 6.048, 5.299, 5.508 | 4.780, 3.654, 2.362 | 5.508 / 3.654 s | 1 |
| Markdown plan, 1,480 code points | 11.352, 11.406, 11.432 | 6.272, 7.068, 4.683 | 11.406 / 6.272 s | 1 |
| Markdown plan, 19,861 code points | 76.178, 79.022 | 35.306, 35.936 | 77.600 / 35.621 s | 2 |

All 16 profiled translations passed structural validation. The same small and large inputs were used
for both agents; earlier Codex baseline runs (10.922–11.979 s and 73.471–78.331 s) remain in the evidence.
The short paragraph is additional evidence for the owner's few-hundred-character scenario.
Repeated measurements can benefit from upstream prompt caching, OS caches and connection conditions;
fresh profiles do not make the entire machine or provider cold. Small samples are not a latency SLA,
a percentile estimate or a formal linguistic quality score.

Two additional small-plan translations were reviewed directly (Codex 11.574 s, Claude 5.275 s).
Both preserve requirements, IDs, task states, metadata, code, link destinations and table layout.
The Claude title is less idiomatic Russian than the Codex title in this sample. Structural integrity
does not imply uniformly polished wording. Reviewed paragraphs and plans are included in the evidence.

### Where The Time Goes

The benchmark observes preparation inside the connection registry, native startup/events and cleanup.
For the small plan, representative median-total runs break down as follows:

| Observable phase | Codex | Claude |
| --- | --- | --- |
| Native call to ready event | 0.512 s | 1.368 s |
| Ready event to result | 10.404 s | 4.876 s |
| Result to native runner return | 0.476 s | 0.012 s |
| Everything outside native calls | 0.014 s | 0.016 s |
| Total | 11.406 s | 6.272 s |

Claude's representative run includes the first startup in that benchmark process; subsequent small-plan
startups were 0.474 and 0.482 s. Profile preparation itself took 0–3 ms across the comparison, and profile
cleanup took 1–9 ms. Outside-native time also includes Markdown parsing, settings reads, assembly and
integrity validation. For large plans, native startup across both segments totals 0.483–0.605 s for
Codex and 0.654–0.705 s for Claude. Waiting for results totals 74.573–77.106 s and 34.543–35.240 s.

Claude independently reports API time: 4.180–6.566 s for the small plan and 34.524–35.223 s across the
large plan's segments. Its structured-output execution reports two turns per segment; API time includes
that output protocol. Codex has no comparable server/API duration in exec events. Ready-to-result time
includes network, provider queueing, generation/reasoning and formatting; it is **not pure model compute**.
Non-streaming assistant events and the SDK's reported `ttft_ms` can arrive with a complete structured
message, so these observations do not establish actual first-token latency.

The evidence points to remote response time as the main cost. Removing temporary directories or
keeping an agent process alive cannot account for the tens of seconds spent on the large document.
No container or development workspace is prepared for translation; only a private profile and empty
working directory are created. The model still generates the translated document sequentially.

A separate tiny Markdown request through Core-managed discovery, credential issuance, Harness
validation and Codex completed in 4.907 seconds with intact task IDs/states. The main comparison is
service-level timing, excluding Core HTTP transport. The approved Claude benchmark reads the selected
saved token into process memory and supplies it through the native environment; the runner neither
prints it nor creates a credential file. Existing installation settings remain unchanged.

[Raw measurements, synthetic inputs and reviewed output samples](benchmark-evidence.json) preserve
the evidence. The legacy `benchmark.mts` and `native-policy.mts` executables are retired with
agent-backed translation. Their historical runs remain recorded here; current reproduction does not
require agent accounts, credentials or deleted Harness modules.

### Explicit Model Comparison

The same 1,480- and 19,861-code-point plans were rerun with explicit model selections, the same prompt,
English-to-Russian direction and low effort. Each fast candidate has three small and two large runs;
the explicit Sol/Sonnet controls have one run per size. A separate Haiku 5.5 availability pilot is
excluded from these medians. The complete comparison contains 19 measured runs plus that pilot.

| Requested model | Small median | Large median | Valid Markdown, small / large |
| --- | --- | --- | --- |
| `claude-haiku-5-5` | 4.194 s | 22.195 s | 3/3 / 2/2 |
| `claude-sonnet-5-5` | 4.743 s | 37.130 s | 1/1 / 1/1 |
| `gpt-6-luna` | 6.563 s | 37.272 s | 3/3 / 0/2 |
| `gpt-6.1-sol` | 11.528 s | 77.418 s | 1/1 / 1/1 |
| `haiku` → `claude-haiku-4-5-20251001` | 24.764 s | 70.825 s | 1/3 / 0/2 |

Rejected outputs still count toward timings; they are failures, not usable translations. Both Luna
large-plan runs add one repeated paragraph (82 top-level Markdown nodes instead of 81). Haiku 4.5
puts another serialized JSON text object inside the translation text in two short runs and at least
one segment of each large run. The production integrity check rejects all six changed documents.
No parser relaxation, repair, hidden retry or fallback is used to improve these results.

Direct prose review finds readable short-plan translations from Luna and generally more idiomatic
phrasing from Sol. Sonnet preserves the requirements but retains some literal wording. Haiku 5.5
preserves all deliverables and the repeated verification conditions, with minor semantic imprecision:
some titles turn the community library into a city library or a shared list, and one large-plan goal
changes allowing a reader to choose a language into requiring the reader to choose. Haiku 4.5 is more
literal, including its title and unfinished-book wording. This is an implementing-agent review of
synthetic samples, not a blinded linguistic benchmark or proof of quality on arbitrary plans.

Haiku 5.5 is the fastest usable tested choice for these samples; Sonnet 5.5 is the more conservative
choice for wording fidelity in this comparison. Native defaults in the operator installation remain
unchanged. The pinned SDK resolves `haiku` to 4.5, while the explicit 5.5 ID succeeds and is confirmed
by native init events on the tested account. The [Claude model documentation](https://code.claude.com/docs/en/model-config)
recommends Claude Code 2.1.293 or later for Haiku 5.5, so this successful isolated probe does not establish
compatibility for every account or client. [Codex's model documentation](https://developers.openai.com/codex/models/)
identifies Luna for focused tasks; these tests verify its actual Markdown limits in this pipeline.
Codex exec does not report the served model ID, so its table entries identify requested models.

For Haiku 5.5, profile preparation/cleanup takes 0–3 ms per phase. Small-plan native startup is
0.515–0.808 s and API time 2.823–4.435 s. Across the two segments of each large plan, startup totals
0.654–0.688 s and API time 21.130–21.773 s. Everything outside native calls takes 6–45 ms. The large
document remains dominated by remote response time, not profile preparation. API time includes the
native structured-output protocol and network/provider latency, not just model computation.

Explicit-model selections and their failures are historical results of the retired agent benchmark.
Reports, synthetic output and source hashes remain under `explicitModelComparison` in
[the evidence](benchmark-evidence.json); there is no current agent translation command to rerun.

### Local Model Measurements

An isolated experiment on 2026-10-15 compares two local models with the existing same-day Haiku 5.5
baseline. It uses identical English→Russian synthetic plans (1,480 and 19,861 characters), verified by
SHA-256, on an Apple M4 Pro with 14 CPU cores and 48 GiB memory. No additional cloud request or
credential access is involved. The then-existing static Harness variants did not run these local models.

The complete 26 local outputs, including failures, timings, model hashes and qualitative review are in
[local benchmark evidence](local-benchmark-evidence.json). Original inputs and Haiku outputs remain in
[agent benchmark evidence](benchmark-evidence.json).

| Pipeline | Small plan | Large plan | Markdown, small / large | Translation assessment |
| --- | --- | --- | --- | --- |
| Haiku 5.5, existing agent baseline | 4.194 s | 22.195 s | 3/3 / 2/2 | Best overall tested result; generally natural, with the previously recorded title and modality shifts |
| OPUS-MT en→ru, CPU INT8, sentence adapter, beam 1 | 0.200 s | 1.631 s | 3/3 / 2/2 | Very fast, but weak wording and some changed requirements |
| Hy-MT2 1.8B Q4_K_M, Metal GPU, 16K-character Markdown blocks | 4.220 s | 106.894 s, failed | 3/3 / 0/2 | Readable short plan; repeated paragraphs, missing headings and truncated large output |

Times are warm-request medians: three small calls and two large calls, with a separate first local call.
No result cache or duplicate-paragraph elimination is used. Local models remain resident between
requests; Haiku includes fresh agent-session startup. Ollama's prompt/KV cache remains enabled and its
cached-token counts are recorded. Fixed seed 42 makes repeated short Hy-MT outputs identical, so these
repeats measure latency rather than independent quality diversity. The long synthetic plan repeats 60
paragraphs: this exposes repetition failures, but is not a representative corpus of real plans. Quality
observations come from direct source/output review, not a blind human panel or reference-based score.

**OPUS-MT pipeline and quality.** The official
[2020-02-11 Marian archive](https://object.pouta.csc.fi/OPUS-MT-models/en-ru/opus-2020-02-11.zip) is converted
with [CTranslate2's OPUS-MT converter](https://opennmt.net/CTranslate2/guides/opus_mt.html). This exact
archive bundles CC-BY-4.0, unlike the Apache-2.0 label on the separately distributed
[Hugging Face conversion](https://huggingface.co/Helsinki-NLP/opus-mt-en-ru). Converted INT8 weights occupy
81.4 MB. CPU inference uses eight intra-operation threads, one inter-operation thread and batches of up
to 32 sentences. Inputs over 512 tokens are rejected instead of truncated.

The experimental adapter retains Markdown delimiters, YAML, deliverable IDs, code, URLs and task
states, translates prose leaves split into English sentences, and escapes generated punctuation. It
sends all 30/280 fragments, including repeated sentences. Structural integrity is enforced by that
adapter, not by the model's Markdown understanding. The probe supports plain text leaves in these
fixtures and explicitly rejects escaped/entity-bearing input; it is not a production codec.

An initial paragraph-level pilot drops the second and third Goal sentences despite passing structure.
Sentence splitting restores those sentences, but beam 1 still changes keeping an unfinished book visible
into “Не закончили читать книгу”, translates saving a fictional book as leaving a fictional edition,
and retains an English article in “Добавить a” at an emphasis boundary. Loss of context across inline
markup contributes to poor phrasing. A beam-4 probe improves the visibility requirement but retains
awkward titles and mistranslates task states. It takes 0.343 s small and 3.845 s large, one warm sample
per size. Direct raw-Markdown OPUS translation also fails structure validation. Passing Markdown does
not establish semantic completeness or suitability for plan requirements.

**Hy-MT2 pipeline and quality.** The experiment uses the official Apache-2.0
[1.8B Q4_K_M GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/tree/a0c709d9fac510f2c807aa3af52872340dc37a4a),
1.133 GB on disk, with Ollama 0.40.4 on an isolated localhost port and temporary model directory.
Ollama reports all 2.337 GB of runtime allocation in GPU memory. Its imported template lacks the prompt
placeholder; the probe bypasses it using `raw: true` with the
[pinned official template](https://huggingface.co/tencent/Hy-MT2-1.8B/blob/9a341cd1b679d3efd23b46e847b01745a71ed792/chat_template.jinja).
It uses recommended temperature 0.7, top-p 0.6, top-k 20 and repetition penalty 1.05, a 16K-token context,
and a 10K output-token cap for large blocks. Production Markdown instructions accompany the translation
prompt. Output is text directly, rather than the native agents' JSON envelope; YAML is copied unchanged.

The short plan preserves its requirements, with less natural wording such as “список чтений” and
“пустой статус”. Both large runs repeat text until the first block reaches the output cap, losing
scenario headings. A 4K-character-block probe with a 4K output-token cap avoids truncation but still
fails after 71.271 s: it duplicates scenario 2, omits scenarios 8 and 10, and expands the 60 scenario
paragraphs to 77. This is a limitation of this tested quantization, prompt and segmentation on these
fixtures, not evidence that every local model fails similarly.

**Time attribution.** Downloads take 6.09 s for OPUS-MT and 18.04 s for Hy-MT2; OPUS extraction and
conversion add 0.87 s and 0.57 s. These setup operations are excluded from request times. The main OPUS
process/import/model startup takes 0.394 s, including 0.089 s loading weights and tokenizers; its first
small request takes 0.227 s. Hy-MT preload takes 0.796 s and its first small request 4.341 s. These are
fresh process/model loads with downloaded files, not reboot-cold disk measurements.

OPUS warm inference accounts for 0.181–0.201 s small and 1.588–1.633 s large; tokenization, IPC, Markdown
preparation and validation add approximately 4–21 ms. Hy-MT warm small calls spend 3.990–4.236 s generating
output and about 8 ms evaluating the mostly cached prompt. Failed large calls spend 104.215–105.549 s
generating output across two blocks. Per-call model loading is below 1 ms. Hy-MT's delay is therefore
generation and repetition, not environment preparation. The previous Haiku startup measurements are
0.515–0.808 s small and 0.654–0.688 s combined large; its API phase dominates both. Provider-side queueing
and inference cannot be separated using those SDK timings.

Haiku 5.5 remains the better overall choice for these tested plans. OPUS establishes subsecond local
translation of the short plan, but does not match Haiku's quality. Hy-MT2 does not materially improve
short-plan latency and fails the long-plan test. Other candidates such as
[Argos Translate](https://github.com/argosopentech/argos-translate),
[TranslateGemma 4B](https://huggingface.co/google/translategemma-4b-it) and
[NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M) have no measurements in this experiment.

#### Reproduction

The retained local-only experiment is independent of Harness and native agent runtimes. Current
reports identify `experimentVersion: 2` and `adapter: standalone-local-contract`; its bounded Markdown
chunker/oracle is experimental and is not the production OPUS codec. Historical JSON is unchanged.
A model-free import/input check is available with `--kind opus --validate-only`. Running inference
still requires explicitly prepared isolated models/dependencies; these commands do not install them.

Scripts under `scripts/experiments/translation/` read the existing fixture evidence, verify its hashes
and invoke the production Markdown validator. Model revisions, URLs, checksums and runtime versions
are recorded in local evidence. Use a temporary Python 3.13 environment with CTranslate2 4.8.3 and
SentencePiece 0.2.2. Extract the official OPUS archive into the `original` directory below, then run:

```sh
/tmp/hosty-local-translation-venv/bin/ct2-opus-mt-converter \
  --model_dir /tmp/hosty-local-translation-opus/original \
  --output_dir /tmp/hosty-local-translation-opus/int8 --quantization int8
node --import tsx scripts/experiments/translation/local-benchmark.mts \
  --kind opus --output /tmp/opus-sentences.json
```

For Hy-MT, use a separate Ollama server with `OLLAMA_HOST=127.0.0.1:11555`,
`OLLAMA_MODELS=/tmp/hosty-local-translation-models`, `OLLAMA_MAX_LOADED_MODELS=1` and
`OLLAMA_NUM_PARALLEL=1`, then pull `hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M` into that server. Verify the
GGUF SHA-256 against the evidence before comparing runs; the upstream tag is mutable.

```sh
node --import tsx scripts/experiments/translation/local-benchmark.mts \
  --kind hymt --output /tmp/hy-mt.json
```

Use `--paragraph-spans` for the rejected OPUS pilot, `--beam 4 --probe-only` for its beam-search probe,
or `--max-segment 4000 --probe-only` for the shorter Hy-MT probe. The script unloads its model on
completion; stop only the isolated server afterwards. The measured server and workers are stopped.
Temporary model/dependency files remain under `/tmp` for reproduction. This experiment does not change
the existing Ollama model store, Core lifecycle, production settings or release-artifact versions.

### Expanded Local Comparison, 2026-10-26

A second isolated English-to-Russian experiment uses registered workspace baseline
`5568918df460b2f30d3c933df1939959d36d9ccb` on the same Apple M4 Pro (14 physical cores,
48 GiB RAM). It adds larger/newer OPUS checkpoints, Argos and Bergamot. These are native
experiment processes, not installed Hosty providers or Core/Shell integration tests.
No cloud inference, provider credential access or production configuration change is involved.

The two hash-verified synthetic inputs above are joined by real plans from that baseline:
`accent-presets/plan.md` (2,073 characters) and `removable-system-apps/plan.md`
(5,493 characters). Twenty additional complete sentences probe terminology, negation,
permissions and conditional requirements. The large synthetic input contains repeated prose;
no result cache or duplicate elimination is enabled. Each document has three warm runs,
except the large synthetic input with two. A separate first call is excluded from medians.
Timing includes prose extraction, local worker transport, translation, reassembly and the
production Markdown validator; it excludes download/conversion and resident-model loading.

| Pipeline | Small synthetic, 1,480 chars | Large synthetic, 19,861 chars | Real accent plan, 2,073 chars | Real platform plan, 5,493 chars |
| --- | --- | --- | --- | --- |
| OPUS 2020, CTranslate2 INT8, beam 1 | 0.195 s | 1.718 s | 0.322 s | 0.682 s |
| OPUS+BT 2021 bilingual, CTranslate2 INT8, beam 1 | 0.210 s | 1.579 s | 0.339 s | 0.702 s |
| OPUS TC Big 2022, CTranslate2 INT8, beam 1 | 0.308 s | 3.137 s | 0.538 s | 1.180 s |
| OPUS TC Big 2022, CTranslate2 INT8, beam 4 | 0.578 s | 7.613 s | 1.045 s | 2.557 s |
| Argos 1.11.0 stock package API, beam 1 | 1.286 s | 19.093 s | 1.959 s | 5.507 s |
| Argos 1.11.0 stock package API, default beam 4 | 2.383 s | 35.607 s | 3.703 s | 10.192 s |
| Argos EN-RU model through batched CTranslate2, beam 1 | 0.306 s | 3.176 s | 0.600 s | 1.336 s |
| Argos EN-RU model through batched CTranslate2, beam 4 | 0.631 s | 7.690 s | 1.738 s | 3.019 s |
| Bergamot Firefox WASM, 8 workers, beam 1 | 0.282 s | 1.090 s | 0.516 s | 0.848 s |
| Bergamot Firefox WASM, 1 worker, beam 1 | 0.727 s | 7.116 s | 1.482 s | 3.053 s |

The earlier Haiku 5.5 results (4.194/22.195 seconds for the synthetic inputs) are historical
context from October 15, not a concurrent cloud control. These small repeated samples are
latency observations, not percentiles or a representative translation-quality benchmark.

**Models and execution.** CTranslate2 4.8.3 uses CPU INT8, eight intra-operation threads,
one inter-operation thread, SentencePiece 0.2.2, and batches of at most 32 fragments. The
[2020 archive](https://object.pouta.csc.fi/OPUS-MT-models/en-ru/opus-2020-02-11.zip) has about
76M floating-point checkpoint weight entries and an 81.4 MB converted model. The
[2021 OPUS+BT bilingual archive](https://object.pouta.csc.fi/Tatoeba-MT-models/eng-rus/opus+bt-2021-04-14.zip)
has about 75M and 80.6 MB: it is newer, not larger. The
[2022 English-to-East-Slavic Big archive](https://object.pouta.csc.fi/Tatoeba-MT-models/eng-zle/opusTCv20210807+bt_transformer-big_2022-03-13.zip)
has about 239M and 249.4 MB. Its source tokens receive the required `>>rus<<` prefix.
All three downloaded Marian archives include CC-BY-4.0. These dates identify the tested
checkpoints; they are not a claim that the models were trained in 2026.

[Argos](https://github.com/argosopentech/argos-translate) uses the official index's
[`translate-en_ru-1_9` package](https://argos-net.com/v1/translate-en_ru-1_9.argosmodel),
whose metadata reports package version 1.9 while its README says English-Russian 2.2.
The package's CTranslate2 model is 214.3 MB. The stock-path probe calls `PackageTranslation`
for each protected prose fragment, with its bundled Stanza sentence splitter and without
Argos's result-cache wrapper. The separate batched probe uses the same weights and tokenizer,
keeps Argos's length penalty 0.2 and unknown-token replacement, bypasses Stanza, and submits
32 fragments per CTranslate2 batch. Its speedup demonstrates an integration/batching cost;
it does not establish that every application using Argos has the stock-path timings above.

Bergamot uses Mozilla's EN-RU `base` model marked **Release Desktop** in the
[model registry](https://mozilla.github.io/translations/model-registry/), snapshot generated
2026-10-26. Its identifier is `student_base_AYqN3ysXRp2EGkEqeaA5Rg`, with 42,686,774 parameters,
43.0 MB weights, 2.8 MB lexical shortlist and 0.9 MB shared vocabulary. The tested engine is
`v0.6.0+1de4a085d`, Remote Settings version 4.0, with matching Firefox 144 JavaScript glue;
[Mozilla documents this distribution](https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html).
Downloaded model and engine checksums match their registries. Execution uses Node 24.18.0,
WASM SIMD, the packaged fallback GEMM implementation, batches of eight requests, and no result
cache. It is not a native C++ or in-browser Firefox speed measurement. Eight WASM workers reach
2.88 GB process peak RSS; one reaches 0.574 GB. Model-file size alone understates runtime memory.
For context, the OPUS Big process reaches 1.34 GB across its beam 1/4 document probes.

The published `@browsermt/bergamot-translator` 0.4.9 package needs a temporary CommonJS worker
loader correction under Node 24. Its initial experiment is superseded by the matched Mozilla
engine above. The wrapper also adapts the newer seven-argument model constructor. All twelve
eight-worker document outputs are byte-identical between the old and matched engines, so the
observed wording defects are reproducible with the matched runtime. The official ARM64
translateLocally executable passes `--help`, but its model catalog contains no Russian pair;
it is not the backend of the measured Bergamot translations.

**Structure and meaning.** All 150 document outputs from the final configurations pass the
unchanged production Markdown validator, including frontmatter, code, URLs, identifiers and
checkbox states. This is a property of the prose adapter, not proof that these models can
safely rewrite Markdown themselves. The existing experiment adapter initially refuses the
real plans' indented continuation lines. A temporary copy admits indentation-only differences
and treats soft wraps as spaces before sentence segmentation. The original five adapter tests
and three added real-plan/soft-wrap checks pass. Earlier refused or incorrectly segmented
attempts remain separate from final measurements. Inline emphasis, links and code still split
sentence context: an isolated English article can remain untranslated beside a translated span.

Direct source/output review finds better terminology in OPUS Big than the 2020 model, but
none of these configurations demonstrates sufficient fidelity for replacing the agent provider
on technical requirements. Concrete failures include:

- OPUS Big translates an unchecked checkbox as remaining "unnoticed"; beam 4 does not fix it.
- Argos changes "only an administrator can enable translation" into only an administrator
  performing translation. It confuses enabling a provider with permission to use translation.
- Bergamot produces malformed terminology for "checkbox" and "byte-identical" in the complete
  sentence probe; it also changes finishing a sandbox into cancelling it. Runtime replacement
  preserves these failures. Some wording varies with the batch context.
- In the real platform plan, OPUS Big beam 4, Argos beam 4 and Bergamot turn "Verify no implicit
  install, UI substitution..." into an instruction **not to verify** those things. All three
  outputs still pass Markdown validation. Color names and UI terms such as lime and hover also
  remain unreliable without domain context.

Bergamot is the fastest tested configuration on the large synthetic input; OPUS Big improves the old OPUS
wording with modest CPU latency. Argos offers convenient model packaging but its ready API does
not provide a quality advantage in these probes. The evidence supports fast reading drafts,
with the English source available, rather than an unqualified replacement for requirements
translation. No local provider is added or enabled by this experiment. The separate
[OPUS Translate app](../local-translation/feature.md) implements the selected local model.

The local replay bundle, model metadata, source hashes, per-run outputs, rejected attempts and
summaries remain outside the repository at `/tmp/hosty-opus-20261026`. `summary.json` aggregates
only the final configurations. Its runners are `run.mts`, `run-real.mts`, `run-argos.mts`,
`run-argos-batch.mts`, `run-bergamot-firefox.mts` and `run-bergamot-firefox-one.mts`; each accepts
the registered worktree path. Model setup is in `setup_models.py`; the matched Bergamot glue and
WASM plus registry snapshots are retained in `firefox-engine/`. The bundle is local temporary
storage, not a published or permanent benchmark dataset.

## Historical Verification

These dated commands/results record earlier implementations. Harness/native-agent paths and temporary
preview bundles below are archival; they are not current installation or reproduction instructions.

Expanded local evaluation verification on 2026-10-26:

- `node --import tsx --test scripts/experiments/translation/local-markdown.test.mts`: five passed.
- The temporary adapter suite at `/tmp/hosty-opus-20261026/local-markdown.test.mts`: eight passed,
  including continuation indentation and soft-wrap handling on the real plan inputs.
- `node --import tsx /tmp/hosty-opus-20261026/verify-final.mts <registered-worktree>`: all 150 final
  document outputs revalidate and shared input hashes match. This validates structure, not meaning.
- `node scripts/docs-index.mjs --fix`, `node scripts/docs-index.mjs --check` and `git diff --check`: passed.
- Benchmark workers have exited; the temporary translateLocally disk image is unmounted. Model files
  and evidence remain in the temporary replay bundle. No release version changes or commits are made.
- Application builds, Core-managed integration/browser checks and the full test suites are not run:
  the repository change is documentation-only; all model/adapter experiments remain outside it.

- Historical settings UI coverage checked the separate translation tab, enable/disable persistence, models while
  disabled, multiple/missing/changed accounts, failed saves, and custom model validation.

Compact settings verification on 2026-10-19 (Harness 0.59.1):

- `npm run harness:lint`: passed; web lint and type checks passed again after the final focus change.
- `npm run harness:build-web`: passed.
- `npm run harness:test -- src/translation src/connections src/settings src/gateway.test.ts src/runtime test/translation-providers.test.tsx web/src/components/gateway-settings.test.tsx`: 162 passed across 13 files.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check`: passed.
- Browser/Shell verification is not performed for this change: the external Core connection exposes
  workspace operations but no supported sandbox lifecycle tools. No ordinary runtime or account data
  is changed. The remaining visual check is the compact tab at desktop/mobile widths through a
  normally authenticated Core-managed test installation. The full monorepo suites are not rerun for
  this Harness UI change; affected suites are listed above.

Preview-port verification on 2026-10-16:

- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj --artifacts-path /tmp/hosty-translation-live-build` succeeds with four existing warnings.
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter 'FullyQualifiedName~ProviderHttpTests|FullyQualifiedName~AppManifestServiceTests'`: 174 passed.
- `npm run harness:lint` and `npm run harness:build-web`: passed.
- `npm run harness:test -- src/translation src/connections src/settings src/gateway.test.ts test/translation-providers.test.tsx src/runtime`: 143 passed after the web build.
- `npm run plans:lint`, `npm run plans:build` and `npm run plans:test`: passed, with 137 tests.
- `npm run sdk:test -- src/providers-server.test.ts`: nine passed; `npm run sdk:dotnet:test -- --filter FullyQualifiedName~HostyTranslationClientTests`: five passed.
- The 0.54.0 agent-worker Docker image builds successfully. Documentation, version consistency and whitespace checks pass.
- Live Core reports a new process identity and the exact preview source project. All four previously running apps are running, and Harness/Plans report healthy.
- Full Core/Harness/SDK suites are not repeated for this deployment port; affected contract, runtime and translation suites above are the current evidence.


Local-model evaluation verification on 2026-10-15:

- `node --import tsx --test scripts/experiments/translation/local-markdown.test.mts`: five passed,
  including both fixtures, literal generated punctuation, sentence boundaries and rejected invalid input/output.
- `npm run harness:test -- src/translation/markdown.test.ts`: 15 passed against the production validator.
- All 26 saved local outputs were revalidated; their recorded success/failure flags and source hashes agree.
- Python worker syntax, documentation index, version consistency and whitespace checks pass. The isolated
  server has exited and port 11555 is closed; model workers are stopped.
- Application builds and full Core/SDK/Harness suites were not repeated for this experiment because only
  experiment scripts and evidence/documentation changed. The implementation checks below are earlier runs.

Implementation verification on 2026-10-15:

| Command | Result |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --artifacts-path .hosty-dev-translation-build --no-restore` | 3,145 passed; four Docker/VPN integration tests skipped by their environment gates |
| `npm run harness:test` | 592 passed after independent translation model settings |
| `npm run sdk:test` | 645 passed |
| `dotnet test packages/app-sdk-dotnet/HostySdk.App.Tests/HostySdk.App.Tests.csproj` | 64 passed |
| `npm run harness:lint` and `npm run harness:build-web` | Passed |
| `npm run build --workspace @hosty-sdk/app` | Passed |
| `dotnet build packages/app-sdk-dotnet/HostySdk.App/HostySdk.App.csproj --no-restore` | net8.0 and net10.0 passed; existing XML-documentation warnings |
| `node scripts/docs-index.mjs --check` and `node scripts/check-versions.mjs` | Passed |

The exact Core project was built by the isolated-output test command before integration startup.
The first full test attempts and Turbopack build were blocked by the execution sandbox's local-port
restriction; the successful runs above used approved local network access. The model-selection change
passed 109 focused translation/UI/HTTP tests, the full Harness suite, web build and lint. After the
static suggestions gained exact Claude versions, all 55 translation/UI tests and backend TypeScript
checking passed again. The native policy probe passed for Codex, Claude API-key and Claude OAuth
profiles. Core and SDK source are unchanged by model selection, so their earlier successful
builds/tests above remain the applicable evidence rather than newly repeated checks.

- The retired implementation’s Core tests covered both static keys, confirmed roles, category grants, exact-key
  token isolation, actor-free translation and live revocation.
- TypeScript/.NET SDK tests cover the request shape, credential separation, incompatible interfaces,
  refusal/invalid responses, cancellation and no retry/fallback.
- Historical Harness tests covered independent model persistence, defaults/reset, invalid IDs, per-document
  snapshots across segments, qualified provider/model forwarding and no retry on inference failure.
  They also cover settings persistence/revision ownership, admin gates, request bounds, disconnect
  cancellation, concurrency and invalid output. Provider-runtime tests cover native configuration,
  cleanup and credential renewal races.
- Markdown tests round-trip every repository `plan.md` and reject altered frontmatter, code, links,
  deliverable IDs, checkboxes, list markers and table structure. The 2026-10-15 run covered 58 plans.
- Historical browser verification used normal password sign-in and a Core-managed Harness in a separate data root;
  it verifies selected Codex/disabled Claude display, preset/custom model saving, and independent model
  values after reload, including explicit Haiku 5.5. The browser reports no warning/error console logs.
  The [settings screenshot](model-settings.png) records the test installation, not the operator's settings.
- The native-policy executable and agent translation adapters are retired. These dated results are
  evidence for their recorded baselines, not current requirements or proof of OPUS linguistic quality.

## Testing Expectations

- Core tests cover confirmed roles, category permission, exact-interface/installation credentials,
  actor-free translation and current revocation without a supplier-specific identity branch.
- TypeScript/.NET SDK tests cover request/response validation, credential separation, incompatible
  interfaces, readiness, refusal, cancellation and no retry or fallback.
- `npm run opus:test` covers language/format/size limits, protected Markdown, capacity, HTTP authority,
  cancellation and worker environment; its structural oracle is independent of Harness.
- `npm run opus:build` checks the shipped app. Native model/cache acceptance belongs to
  [Local OPUS Translation](../local-translation/feature.md#testing-expectations) and is opt-in.
- Documents tests cover optional permission, explicit qualified selection, guarded source bytes,
  original/translation views, cancellation and provider failure diagnostics.
- `node --import tsx --test scripts/experiments/translation/local-*.test.mts` and
  `node --import tsx scripts/experiments/translation/local-benchmark.mts --kind opus --validate-only`
  verify the independent experimental codec and unchanged fixed input hashes without model access.
- `node scripts/docs-index.mjs --check`, `node scripts/check-versions.mjs` and `git diff --check`
  validate documentation, versions and whitespace. Historical commands above are records of their
  dated baselines, not instructions to restore retired translation suppliers.

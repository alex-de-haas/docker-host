---
created: 2026-10-15
updated: 2026-10-16
summary: Core translation discovery and scoped invocation, SDK clients, and two static Harness variants for translating text and Markdown plans.
components: [apps/core, apps/harness, apps/plans, packages/app-sdk, packages/app-sdk-dotnet]
---

# Translation Providers

## Contract And Selection

Core recognizes the confirmed supply role `translation` and category permission
`providers.translation`. One app can expose several versioned interface entries with distinct keys.
The provider is the installed supplier; the interface describes its callable contract. Consumers
select `(appId, kind, key)`, so Harness supplies two translation choices without becoming two apps.
The existing [provider authority protocol](../provider-consumption/feature.md) issues a credential
for exactly that app/category/key and checks current grants on every invocation. Translation uses
app authority, without an acting-user assistant session or tool delegation.

Harness 0.54.0 declares static `codex` and `claude` entries at `/api/translation/v1/{key}`. Both
are discoverable even when no agent connection is selected. The administrator selects an existing
connection of the matching kind under **Settings → Providers → Translation providers**. A selection
includes its credential revision and, for an existing Codex host login, an account fingerprint.
Changing the chat default does not change translation. Removed/replaced accounts require explicit
reselection; no alternate account, backend or provider is tried automatically.

Each variant also has an independent translation model selection: **Agent default**, a static
suggestion, or **Custom model ID**. Suggested Claude choices include explicit Haiku 5.5 and Sonnet 5.5
versions as well as native aliases. Suggestions are not an account entitlement catalog. Aliases follow
the installed native runtime; exact IDs pin the requested version. Model IDs accept 1–128 ASCII letters,
digits, dots, underscores and hyphens, starting with a letter or digit. Availability is checked by the
upstream inference request, with no Harness model fallback or retry.

The administrator endpoint `PUT /api/settings/translation/{kind}` saves `connectionId` and optional
`model`. A null model selects the native default; an omitted model preserves the previous choice for
older clients. Existing settings without `translationModels` retain native defaults. The service
snapshots the connection and model once per document, including all of its segments, and passes an
explicit selection through Codex `--model` or Claude SDK `options.model`. Chat models, chat defaults
and the consumer translation contract are independent of this setting. Reasoning effort remains low.

The selection is host-wide and authorizes consumer apps already granted `providers.translation`
to use that account's allowance or API billing. The UI states that text is sent to the selected
external model provider. Configuration readiness does not prove remote login validity, quota or
model entitlement; those failures are reported by the inference request.

| Operation | Request | Response |
| --- | --- | --- |
| `GET /capabilities` | Exact-key provider bearer credential | Version, formats, character/byte limits, timeout, backend, readiness and optional reason |
| `POST /translations` | Same credential; JSON `text`, `targetLanguage`, optional `sourceLanguage` and `format` | `text`, requested `targetLanguage` and `sourceLanguage` |

`sourceLanguage` defaults to `auto`; `format` defaults to `text` and also accepts `markdown`.
Language values are bounded language tags such as `en`, `ru`, `pt-BR` or `zh-Hant`. `auto` is only
a source-language option. The result echoes the requested source tag; it does not claim language
detection. Capabilities contain `version: 1`, `formats`, `maxCharacters`, `maxSegmentCharacters`,
`maxBytes`, `maxOutputBytes`, `timeoutSeconds`, `backend`, `ready`, and optionally `reason`.

## Markdown Plans

Markdown plans are the primary translation input. The translator preserves the complete leading
YAML frontmatter and uses a GFM syntax tree to check the resulting document. Heading levels, block
and list structure, list markers/numbering, task checkbox states, deliverable IDs (`D1` etc.), table
alignment, link destinations and reference identifiers must match. Code blocks, inline code, HTML,
images and link definitions must remain byte-identical. Only prose changes. Structural changes
produce `translation_markdown_changed` instead of a successful rewritten plan. The source file is
never written by this API. Structural validation does not prove linguistic accuracy.

Markdown accepts up to 128,000 Unicode code points. It splits at block or list-item boundaries
into segments of at most 16,000 code points, grouping small intervening code blocks with prose to
avoid one model call per paragraph. Frontmatter and oversized code blocks are copied. An oversized
indivisible prose block is refused with `translation_block_too_large`; it is never truncated.
The complete result is validated after concatenation. Plain text accepts up to 16,000 code points.

Request and document output each have a one MiB byte limit; each generated segment is bounded to
128,000 UTF-8 bytes. A segment has a 120-second deadline and the request a 600-second deadline.
The operation is non-streaming. Long plans need a waiting state and cancellation in the consumer.

## Execution And Failure Behavior

Each request leases its selected connection exclusively. An open chat/reservation on that connection
or another translation produces a busy error; a dedicated translation connection avoids that
contention. The lease prevents credential replacement and native-token refresh races. Translations
do not create Harness conversations or use chat history, MCP grants, custom prompts or source workspaces.

Codex uses the pinned 0.160.0 CLI's ephemeral exec mode, an empty working directory, isolated profile,
read-only sandbox, disabled host tools/features, no project instructions/host skill discovery, and a
strict single-field JSON output schema. Claude uses Agent SDK 0.3.288 with a temporary profile,
no configured tools/skills/plugins/MCP/settings sources/hooks, denied tool requests, disabled
session persistence, low effort, two turns and a USD 1 budget ceiling per segment. API-key connections
use bare mode. Subscription OAuth connections use safe mode plus a restrictive hook-disable policy:
[bare mode does not read subscription tokens](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
The OAuth path checks the SDK's resolved settings before startup and refuses hosts with a managed
settings source, because safe mode alone still permits managed hooks. It does not override that policy.
An API-key connection supports bare mode on those hosts. This is native configuration isolation,
not protection against an administrator changing machine policy concurrently with a request.

The native policy probe observes the actual inference requests through a local fake endpoint:
Codex advertises only its internal `request_user_input` (which exec cannot service); Claude advertises
only `StructuredOutput` in both API-key and OAuth profiles. Host instruction sentinels remain absent
from inference and test startup hooks do not execute. Neither profile advertises host filesystem, shell, browser or MCP tools.
Codex tool event attempts are rejected. These controls describe the pinned versions, not arbitrary
operator replacements of the native binary and not OS/container isolation for the whole Harness.

Only the selected account credential enters the native environment/profile. Core/Harness service
tokens and unrelated vendor overrides are excluded. Temporary profiles are removed after success,
failure and cancellation. File-backed Codex login renewal is written back only while the original
account document still matches; managed ChatGPT renewal is also persisted through Core secret storage.
Keychain-only existing Codex logins are unavailable for translation. A renewal persistence failure
requires reconnection. Harness does not persist translation input/output in chat history or logs.
The selected upstream provider's account and retention terms apply to inference.

Routes revalidate provider authority before consuming the body. Settings retain administrator and
same-origin/CSRF checks. Ordinary operator session cookies alone cannot invoke the translation route.
Disconnects cancel native execution, including the Codex process group. There is no request queue,
retry or fallback. Typical failures are invalid input (400), missing/revoked authority (401/403),
changed connection (409), oversized input (413), busy (429), invalid/model output (502), unavailable
connection (503) and execution timeout (504).

## SDK Usage

TypeScript SDK 0.31.0 adds `translationCapabilities` and `translate` to the server-only client:

```ts
const client = new ProviderClient();
const providers = await client.list("translation");
const selected = providers.find(p => p.appId === chosenAppId && p.key === chosenKey);
if (!selected) throw new Error("The selected translator is not installed.");
const result = await client.translate(selected, {
  text: markdownPlan,
  sourceLanguage: "en",
  targetLanguage: "ru",
  format: "markdown",
}, abortController.signal);
```

.NET SDK 0.10.0 exposes `TranslationCapabilitiesAsync` and `TranslateAsync` with
`HostyTranslationRequest`, `HostyTranslationResult` and `HostyTranslationCapabilities`. Supply an
`HttpClient` with redirects disabled and a timeout of at least 610 seconds (or infinite with caller
cancellation). Both clients check version one, keep service credentials inside Core calls and pass
cancellation through to inference. Requested language tags must match the provider response.

## Plans Consumer

Plans 0.7.0 consumes the two variants through a **Translate** action above its selected Markdown
document. It owns translator and target-language choices; Harness owns account and translation-only
model settings. The original file, workflow metadata and workspace diff remain authoritative.
Translations are temporary reading views with an original toggle and cancellation. Current source
authorization, displayed-byte fingerprints and installation identity are checked before invocation.
See [Plan Tracking](../plan-tracking/feature.md#translate-a-document) for the UI and acceptance evidence.

## Operator Preview Installation

On 2026-10-16, the operator's existing local installation is updated for interactive acceptance.
The preview is ported onto its installed release baseline `b996226e2c1574d6a34f0c0743147d54a3d98844`,
preserving the newer Sandbox permissions and Harness execution-mode settings. A separate managed
worktree named `plans-translation-preview` supplies Core 0.136.0, Harness 0.54.0 and Plans 0.7.0 in
source development mode. Shell 0.103.1 and Workspaces 0.4.0 remain running at their existing versions.
The worktree is an active runtime dependency, not disposable build output. No release is published.

Harness translation settings select the existing Codex connection with `gpt-6-luna` and the existing
Claude connection with `claude-haiku-5-5`. Chat defaults and native execution mode are preserved.
Plans retains its existing optional grants and additionally receives `providers.translation`.
Core creates pre-update backups for Harness and Plans. The local agent-worker image is rebuilt at
0.54.0 so the retained Docker execution option has the matching image available.

A live browser check translates `docs/features/accent-presets/plan.md` from the tracked public branch
to Russian through both variants. Both requests succeed and pass the production Markdown validator;
headings, inline code, links, D1/D2 and unchecked tasks render correctly. **Show original** restores
the English reading view. Plans service logs report complete HTTP request times of 8.6 seconds for
Claude and 15.3 seconds for Codex, one run each; these include source validation and provider transport
and are not a repeated latency benchmark. The plan also loads within Shell. Translation interaction
is checked in the normally authenticated app window because the browser automation tool cannot click
controls inside this Shell iframe; earlier isolated embedded-flow coverage remains recorded in
[Plan Tracking](../plan-tracking/feature.md#translate-a-document).

## Measured Behavior

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
the evidence. `scripts/experiments/translation/benchmark.mts` reproduces it with an explicitly supplied
sample and credential. Reports contain timing metadata only unless `--include-output` is explicitly
selected for synthetic sample review. `native-policy.mts` uses only fake local credentials.

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

Use `--model <id>` with `scripts/experiments/translation/benchmark.mts` to reproduce a selection.
`--continue-on-error` retains repeated failures; `--include-output` additionally retains synthetic
segment output for diagnosis even when final Markdown validation rejects the document. Reports and
source hashes are stored under `explicitModelComparison` in [the evidence](benchmark-evidence.json).

### Local Model Measurements

An isolated experiment on 2026-10-15 compares two local models with the existing same-day Haiku 5.5
baseline. It uses identical English→Russian synthetic plans (1,480 and 19,861 characters), verified by
SHA-256, on an Apple M4 Pro with 14 CPU cores and 48 GiB memory. No additional cloud request or
credential access is involved. Neither static Harness variant runs these local models.

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

## Testing Expectations

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

- Core manifest/provider tests cover both static keys, confirmed roles, category grants, exact-key
  token isolation, actor-free translation and live revocation.
- TypeScript/.NET SDK tests cover the request shape, credential separation, incompatible interfaces,
  refusal/invalid responses, cancellation and no retry/fallback.
- Harness tests cover independent model persistence, legacy defaults/reset, invalid IDs, per-document
  snapshots across segments, native model forwarding, and no retry on inference failure. They also
  cover settings persistence/revision ownership, admin gates, request bounds, disconnect
  cancellation, concurrency, native configuration, invalid output, cleanup and credential renewal races.
- Markdown tests round-trip every repository `plan.md` and reject altered frontmatter, code, links,
  deliverable IDs, checkboxes, list markers and table structure. The 2026-10-15 run covered 58 plans.
- Browser verification uses normal password sign-in and a Core-managed Harness in a separate data root;
  it verifies selected Codex/disabled Claude display, preset/custom model saving, and independent model
  values after reload, including explicit Haiku 5.5. The browser reports no warning/error console logs.
  The [settings screenshot](model-settings.png) records the test installation, not the operator's settings.
- Re-run native policy probes when upgrading either pinned agent. Fixtures alone do not establish
  real account availability, latency or translation quality.

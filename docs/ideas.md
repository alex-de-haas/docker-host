---
created: 2026-10-23
updated: 2026-10-27
---

# Ideas

<!-- idea-id-high-water: 17 -->

This living document collects early possibilities, questions and examples that may expand or
complement the [vision](vision.md). The vision describes the system the owner wants to build;
these ideas are still too unformed even for a Draft feature plan. They can evolve, be combined or
be discarded without becoming commitments or replacing the vision.

There are no statuses, deliverables, schedules or implementation approvals here. When a specific
idea becomes concrete enough to plan, develop it in the owning feature's `plan.md` and link that
work from here. Only an explicit direction decision changes the vision; recording an idea does
not make that decision.

Hosty is considered a personal or shared environment assembled from applications. Documents,
household records, media and everyday assistance are first-class examples; development and
automated code review are examples of the same composition mechanisms.

## Sources And Reading Guide

Initial ideas were captured on 2026-10-23 from the owner's discussion and the supplied presentation
"How to make ChatGPT yourself" (`kak-sdelat-chatgpt-samomu.pptx`, October 2026 meetup, 29 slides).
The presentation describes an assistant built with Ollama, ComfyUI, Qdrant, MongoDB and a
Node.js/React application. Slide references below use the page numbers, including
the cover. Its SHA-256 is `599e67f880aef9990de9550c24eb388380f086ead766662c9e1e69423faef0f7`.
The presentation is a source supplied in the conversation, not a repository dependency or
implementation specification. No source code or measured acceptance evidence accompanied it.

Each topic distinguishes material described in the slides, the owner's exploration, and candidate
interpretations. The latter are discussion aids rather than decisions. The repository links near
the end record the initial implementation context and existing ownership of related work.
Idea labels such as I1 are references for discussion, not deliverable IDs or implementation promises.

Owner framing, 2026-10-23: Hosty builds its own applications inside the platform, much as an
operating system ships its own apps. Many ideas here have mature counterparts elsewhere, and that is
expected. **Prior art and options** blocks name libraries, protocols and engines a Hosty app could
embed, and products whose design is worth studying. A named product is a reference design to learn
from, not an integration target or a replacement for a Hosty app. **Known pitfalls** blocks record
problems those projects already ran into, so a Hosty design can avoid them. Both were collected on
2026-10-23; recheck versions, defaults and licences before relying on them.

I12–I15 and the knowledge and search material in I1–I2 moved here from the vision on 2026-10-23.
The vision keeps decision 52 and the direction it sets; these sections keep the forms and choices
that still need shaping. [Platform Precedents](#platform-precedents) collects lessons that apply
across several ideas.

## I1. Memory As A Replaceable Provider

**Owner boundary, 2026-10-26:** Keep learned long-term memory outside the current
[composable-work investigation](features/composable-agent-systems/plan.md). Session context,
explicitly shared materials, artifacts and skills should suffice for its first compositions.
Do not add a memory implementation, automatic extraction or adaptive policy as a dependency.

A later idea is to remember a person's recurring preferences or decisions so an agent does not
repeat the same question. Its applicability, visibility, correction and forgetting need separate
design: an old answer must not silently become a new permission or override changed circumstances.
This remains an idea; the owner is concerned about unpredictable influence on subsequent behavior.
Existing session history and explicit standing instructions are not excluded by this boundary.

**Source:** Slides 12 and 17 describe chat search with embeddings, Qdrant and hybrid ranking.
Slide 16 separately describes explicit save/recall/delete tools and user/chat memory in MongoDB.

**Owner exploration:** Memory is an optional provider application. One implementation might bundle
a small API service and a MongoDB service. Installing Core need not install either MongoDB or
Qdrant. The provider needs to expose stored information for retrieval as well as accept writes.
One application may implement several provider roles.

**Candidate interpretation:** A common memory interface could describe saving, reading, revising,
deleting and searching records while leaving storage and indexing to the selected provider.
Illustrative record properties include a provider-qualified identity, revision, scope, source
references, timestamps and a distinction between user-confirmed facts and generated summaries.
These are concepts to compare, not chosen method names or a wire schema.

MCP is one way to expose that capability to an agent. A Core-hosted facade could route stable tools
to a selected provider without storing the knowledge in Core. Another option is for the provider,
or a separate bridge, to expose MCP and use Core for discovery and authority. The location of the
MCP endpoint and the ownership of the memory implementation are independent choices.

**Open boundary:** The owner suggested Core might host the MCP surface, but this is not settled.
The existing MCP direction places provider discovery and authority in Core and tool invocation in
apps. A new Core-hosted memory facade would require an explicit reconciliation with that boundary.
Provider selection, unavailable providers and the scopes visible to each user/session also remain
open. Neither a shared workspace nor a common index implies access to all users' knowledge.

**Vision exploration (moved 2026-10-23):** Knowledge is broader than project documentation:
personal information, documents, selected conversation excerpts, requirements, decisions and
reports may all be useful. Scope can be personal, shared with a household or team, associated with
apps, or tied to a particular activity. A mandatory Project container is not selected. Knowledge can
be discovered across permitted contexts without keeping their original workspaces alive or loading
every previous conversation into a new session.

The owner leans toward an independently supplied knowledge capability with a common interface.
Harness knows its session representation and could submit selected history, excerpts or summaries;
other apps could contribute their own documents or artifacts. The provider chooses how to store,
organize and retrieve them. An initial idea placed aggregation in Core; the later clarification
favors replaceable provider implementations, with any necessary Core contract/authority support
still to be determined. Core need not become the owner of every source document or conversation.

A remembered proposal, a confirmed decision and an inferred summary have different meanings.
Retained knowledge should carry its origin and any known revision or replacement; a search hit
alone cannot establish that a proposal was accepted or remains applicable. Exact representation,
validation and conflict resolution remain open. Source permissions and sharing changes must also
apply to retrieval and derived copies; indexing is not a new access grant.

**Prior art and options:**

- Provider role: the [provider consumption](features/provider-consumption/feature.md) pattern that
  speech, translation and assistant providers already use fits memory too: a `provides` role, a
  `providers.<kind>` permission, Core discovery and two-minute provider credentials. The provider
  serves an HTTP interface to apps and `interfaces.mcp` to agents. Core keeps discovery and
  authority, and no Core-hosted memory facade is needed.
- Agent-facing tools: the `search` plus `fetch` pair used by ChatGPT connectors and deep research
  is a de facto convention for bounded discovery followed by explicit reading.
- Record meaning: Graphiti (Zep) stores facts as edges with `valid_at` and `invalid_at`, which
  models "replaced" and "no longer applicable" directly. A lighter form is a `kind` (fact, decision,
  proposal, summary) plus a `supersedes` reference.
- Memory designs to study: basic-memory (Markdown files plus MCP, readable by people), Mem0 and
  OpenMemory (automatic extraction), Letta (agent-managed memory tiers).
- Storage inside one provider container instead of separate Qdrant and MongoDB services: SQLite
  with FTS5 and sqlite-vec (no extra service), Postgres with pgvector (plus ParadeDB `pg_search`
  for BM25), or Meilisearch (built-in hybrid search that can use an Ollama embedder).

**Known pitfalls:**

- Automatic memory fills with trivia, duplicates and contradictions; ChatGPT had to add a visible
  memory list with editing and deletion. Prefer explicit saves and treat automatic extraction as a
  suggestion the user confirms.
- A fact without provenance cannot be corrected: the user needs to see where it came from to fix
  or delete it.
- Recalled text is untrusted input. A stored note or document can contain instructions aimed at
  the model; recall never widens tool permissions.

## I2. Search Across Knowledge Providers

**Owner exploration:** A separate search provider might search knowledge stored by another provider.
The difficult part is supplying information through a common contract without exposing a database's
private layout.

**Candidate interpretations:** Keep several arrangements available for comparison:

| Arrangement | What would be shared | Main tradeoff |
| --- | --- | --- |
| Memory provider owns storage and search | Common record and search-result interfaces | Small integration surface; search quality follows that provider |
| Independent indexer/search provider | Authorized content reads plus enumeration and revision/change information | More interchangeable search, with synchronization and derived-data ownership to solve |
| Federated search | Bounded query/results interfaces on each source | Less central copying, with uneven capabilities and ranking across sources |

A separate indexer would need bounded text or extracted fragments, source identity and revision,
and enough authority information to return only permitted results. A change feed, polling or
explicit reindexing could communicate edits and deletions; no mechanism is selected here. Returned
hits need excerpts and source references so the caller can retrieve supporting material lazily.

Deleting a source, revoking access, changing a document or replacing an embedding model affects
derived summaries and indexes. A common representation should address those transitions before
promising interchangeable providers. An initial combined memory/search provider would still fit
the modular direction; separate deployable apps for every operation are not a requirement.

Search over historical material, explicit durable memory, and compaction of one conversation are
distinct. A retrieved discussion is evidence of a discussion, not automatically a current decision.
Relevant memory can be loaded on demand; automatic context insertion is a separate configurable
behavior. Hybrid lexical and semantic ranking is an implementation candidate, not a Core dependency.

**Vision exploration (moved 2026-10-23):** A search capability may be part of that provider or
separately supplied. Qdrant is one possible backend for a provider; no engine, embedding model,
deployment or vector schema is selected. The interoperability question is what producers and
consumers exchange: content or retrievable references, identity/version, provenance, sharing scope
and update/deletion meaning are candidate common elements. Apps retain their domain semantics.
Native provider storage formats need not be identical, and a common interface must not erase
authorship or current access restrictions.

Prefer bounded discovery followed by explicit reading of relevant excerpts and surrounding context.
A new session can discover associated apps and available materials without receiving their complete
contents. Session-local context remains independent of the shared store. Searching retained history
and recalling curated knowledge are distinct capabilities; the consuming app can expose optional
MCP tools and instructions controlling when to use them. Tool enablement, background ingestion and
summarization policies should be distinguishable choices, with context size and processing cost
visible enough to tune. Disabling retrieval stops subsequent access; it does not erase information
already delivered to a conversation.

**Prior art and options:**

- Producer-to-index synchronization: a cursor-based changes API that returns upserts plus
  tombstones for deletions, as in Microsoft Graph delta queries, Google Drive `changes.list` and
  CouchDB `_changes`. The [Core event bus](features/core-event-bus/feature.md) stays a hint that
  something changed; the indexer pulls by cursor and recovers after downtime.
- Push instead of crawl: iOS Core Spotlight lets apps donate items with a unique id and a domain id
  and delete them by either. The system owns the index while the data stays with the app, so no
  crawler has to understand each app.
- Authority in two places: scope labels stored at indexing time filter queries, and `fetch`
  revalidates access with the source under the caller's delegated token. Relationship-based
  engines such as OpenFGA or SpiceDB are an option if household and team sharing outgrows simple
  scopes.
- Embeddings for Russian and English: bge-m3, multilingual-e5, Qwen3-Embedding; reranking with
  bge-reranker-v2-m3. Store the model id with every vector, build a replacement index beside the
  old one and switch atomically (Qdrant collection aliases, Meilisearch index swap).
- Chunking: structure-aware splitting, returning the parent section with a matched chunk, and
  contextual retrieval (a short context prefix per chunk plus BM25, published by Anthropic) all
  reduce missed answers.

**Known pitfalls:**

- Pure vector search misses exact strings such as invoice numbers, SKUs and surnames. Lexical
  ranking is required, not optional.
- SQLite FTS5's only built-in stemmer, `porter`, is English. Russian needs a Snowball tokenizer
  extension or Postgres's `russian` text-search configuration.
- Fixed-size chunks split tables and lose headings: "total: 120 000" arrives without "doors".
- Indexing exposes latent permission mistakes. Microsoft 365 Copilot's "oversharing" problem
  surfaced files people could technically open but did not know about; in a household the
  equivalent is a child finding salary documents. Default to private scope, share explicitly, and
  give a derived summary the narrowest scope among its sources.
- Indexers compete for CPU, as Spotlight and Windows Search showed. Queue work with priorities,
  throttle it, and allow pausing or idle-only processing.
- Keeping only vectors means an embedding-model change requires re-extracting every source. Keep
  the extracted text.

## I3. Shared Artifacts, External References And Configurable Storage

**Selected minimal investigation, 2026-10-26:** The
[composable-work Draft](features/composable-agent-systems/plan.md#basic-artifacts-and-explicit-context-handoffs)
coordinates basic artifacts for handing work between sessions and agents; the separate [Shared Artifacts Draft](features/shared-artifacts/plan.md) owns that minimal capability. A worker can return a
summary and described/versioned reports, scripts or prepared documents; another authorized worker
can find and read those results without sharing a complete transcript. People can contribute input
materials too. Preserve provenance and the intended lifetime beyond temporary execution resources.

Keep session context, explicitly selected shared context, artifacts, skills and learned memory
distinct. Memory remains deferred under I1. The initial artifact investigation does not require
session/workspace/global tiers, automatic promotion, semantic indexing or a storage-provider choice.
An agent or configured workflow can select useful outputs to save. The external-storage and broader
knowledge possibilities below remain ideas, not additional deliverables for that Draft.

**Source:** Slides 6 and 7 describe lazy tool-result loading and files stored separately from their
database metadata. Slide 20 describes extracting text from audio, images and documents.

**Owner exploration:** Materials uploaded to an assistant could live in a shared artifact collection.
Users could also connect existing storage, with iCloud Drive as an example, and ask about a document
by name, link or remembered subject. Connecting a source could optionally initiate indexing of the
files in the selected scope. Uploads could be placed in a configured destination, possibly that same
external storage, using a configurable organization scheme.

The concrete example is a household invoice: "How much did replacing my doors cost, and which
manufacturer supplied them?" The assistant could locate the invoice, retrieve the relevant content
and answer with a reference to it, even when the user no longer remembers the filename.

**Candidate interpretation:** Distinguish three representations:

- A reference to an externally owned original, including the connector and source identity.
- An uploaded artifact whose original bytes the selected storage provider manages.
- Derived material such as extracted text, a summary, preview or search index.

Remembering an external file need not create another permanent original. Indexing may still require
reading its contents and retaining derived data; temporary downloads and caches need their own
policy. A small catalog entry can describe availability, type, revision and provenance without
putting the whole file into every conversation. The association with the session that mentioned
the file can be retained separately from ownership of the file itself.

An application could supply storage, source access, extraction, indexing and memory together, while
other applications implement only selected roles. Upload routing needs a recoverable outcome: a
failed external upload must not be presented as successfully stored or indexed.

**Open boundary:** iCloud Drive is a desired scenario, not a verified connector. Supported access
methods, operating systems, background availability and read/write capabilities need investigation.
Source connection, indexing scope, retention of extracted content and write access are distinct
settings. Renames, unavailable originals, deletions and changed sharing rights also affect results.
An answer about a price or manufacturer should be checked against the source, not only an older
generated summary.

**Prior art and options:**

- iCloud Drive has no clean server-side path:
  - rclone's `iclouddrive` backend (since 1.69) needs the Apple ID password and two-factor
    authentication. Its trust token lasts 30 days, and Advanced Data Protection adds approval
    steps, so unattended background access is fragile.
  - On a macOS host, `~/Library/Mobile Documents/com~apple~CloudDocs` can be attached read-only
    through [external mounts](features/external-mounts/feature.md). Evicted files are placeholders
    until downloaded, so the folder needs Finder's "Keep Downloaded" option.
  - The native Apple client can upload files the user selects on the device.
- Other storage: rclone covers Google Drive, OneDrive, Dropbox, WebDAV/Nextcloud, S3 and SMB behind
  one interface, and `rclone rcd` exposes a remote-control API a Hosty storage app could embed.
- Originals: content-addressed blobs named by SHA-256 on the filesystem. If S3 is needed, note that
  MinIO's community edition was archived in 2026; Garage, SeaweedFS and RustFS are maintained
  alternatives.
- Extraction: Docling converts PDF and Office files to Markdown or JSON with page and bounding-box
  provenance, so an answer can cite the exact region. Apache Tika and MarkItDown cover more
  formats. OCR options are Tesseract, PaddleOCR or a vision-language model such as olmOCR or
  granite-docling.
- Designs to study for the household-document scenario: Paperless-ngx (immutable originals, a
  separate OCR'd archive version, correspondents, custom fields such as an amount, a consumption
  folder) and Immich for photos (external libraries, CLIP search, shared albums).
- Platform analogues for references that carry access: Android content URIs with temporary per-URI
  grants and macOS security-scoped bookmarks.

**Known pitfalls:**

- Two-way sync is the most expensive feature in this space; Dropbox and Nextcloud spent years on
  conflicts. Prefer references plus one-way import or indexing, with writes only through explicit
  uploads.
- Paths break on rename. Identify files by provider id, inode or content hash, with the path as a
  hint.
- Immich marks external-library files "offline" instead of deleting them when a disk or NAS
  disappears. Model "original unavailable" explicitly and keep derived data until a policy
  removes it.
- SMB and NFS shares deliver no change notifications; periodic rescans are the fallback.
- Folder-based organization is costly to change: in Paperless-ngx a new filename scheme renames
  many files. Organize by metadata and treat the folder layout as a derived view.
- Garbage collection by reference count is a classic way to delete live data in content-addressed
  stores. Prefer mark-and-sweep with a grace period.

## I4. One Conversation Can Coordinate Several Specialized Providers

**Source:** Slides 8 and 10 describe agent tools and ComfyUI workflows producing attachments.

**Owner exploration:** A user selects a primary agent/model for a conversation, but can also select
an image/video model and a preset. A request such as "make a beautiful kitten" can be expanded by
the primary agent into a suitable generation prompt, then sent to the selected specialist. The
result returns to the same conversation. The same pattern can support review, transcription or
other specialist work.

**Candidate interpretation:** Keep the conversation, the orchestrating agent run and each delegated
operation distinct. Record the selected provider/model, preset or workflow revision, effective
input, execution state and returned artifact references. This makes it possible to explain which
component produced a result and reproduce the relevant request.

The primary agent can call a specialized capability as a tool or delegate a bounded task to another
agent. A second inference call need not become a second visible conversation. Instructions can
shape the request, while provider contracts define accepted inputs and results. A preset may contain
workflow parameters as well as wording. Explicit model/preset choices should survive prompt
expansion rather than be silently replaced.

**Open boundary:** Compare direct tool invocation, a reusable workflow and delegation to a full
agent. Define which component owns cancellation, continuation, output validation and retries. The
specialist needs the relevant input and authority, not an automatic copy of the entire conversation.

**Prior art and options:**

- ComfyUI's API accepts an API-format workflow JSON on `/prompt` and reports progress over a
  WebSocket. A preset can be a saved workflow with exposed parameters and a hash. ComfyUI also
  embeds the workflow in PNG metadata, which helps reproduction.
- A specialist role such as `image-generation` can follow the same provider pattern as speech.
- Operation-state vocabulary: A2A task states (submitted, working, input-required, completed,
  failed, canceled) and artifacts. For long tool calls, the MCP Tasks extension (`tasks/get`,
  `tasks/cancel`) replaced the experimental core Tasks of the 2025-11-25 revision.
- Attribution: OpenTelemetry GenAI semantic conventions (`gen_ai.*` attributes, `invoke_agent`,
  `execute_tool` and `chat` spans) record which component produced which result, and
  [observability](features/observability/feature.md) already ingests OTLP.

**Known pitfalls:**

- ComfyUI workflows break when custom nodes update. A reproducible preset pins node versions and
  model hashes, not only the graph.
- DALL·E 3 in ChatGPT silently rewrote prompts; OpenAI later returned `revised_prompt`. Show the
  effective prompt and offer "use my prompt as written".
- Two engines on one GPU, such as Ollama and ComfyUI, run out of memory. One GPU arbiter can unload
  models before switching (`keep_alive: 0` in Ollama, `POST /free` in ComfyUI).

## I5. Agent Providers, Model Catalogs And Configurable Execution

**Owner exploration:** A provider can be the single endpoint that accepts prompts, context,
instructions and tools, and offers its supported models. A Codex integration exposes the models
available through that integration; an Ollama-backed integration can discover models installed on
its configured machine. The UI need not force users to configure two separate products called
"agent" and "model provider."

**Technical distinction:** Ollama's documented tool-calling API returns proposed calls; its examples
execute the functions and repeat model requests in application code. An Ollama-backed agent provider
can package that loop, tool/MCP adapters, approvals and context handling around Ollama. This makes
the owner's product model viable without treating a bare inference server as a complete agent.
Not every installed model is necessarily suitable for every required capability.

**Source and owner correction:** Slides 11 and 15 discuss local resource estimation and queues, but
the owner emphasized orchestration over GPU management. Execution policy should depend on the
provider and workload. A subscription-backed agent need not inherit an artificial global serial
queue; actual provider limits still apply. Local GPU workloads may benefit from admission limits,
load progress and coordination between engines. These are configurable policies, not one universal
definition of a run. Local, remote self-hosted and cloud execution remain distinct deployment choices.

**Prior art and options:**

- A .NET tool loop without a heavy framework: `Microsoft.Extensions.AI` (`IChatClient` with
  `UseFunctionInvocation()`), OllamaSharp as the client, and the MCP C# SDK, whose client tools are
  `AIFunction` instances. Microsoft Agent Framework adds multi-agent orchestration on top; the
  Vercel AI SDK is the TypeScript counterpart.
- Ollama 0.14 and later implement the Anthropic Messages API, so Claude Code can run local models
  through `ANTHROPIC_BASE_URL`, and Codex can also use Ollama. An Ollama agent provider may be an
  existing Harness connection with a different base URL. `opencode serve` (HTTP API and SDK) is
  another multi-model agent runtime to study.
- Model capabilities: Ollama's `/api/show` returns `capabilities` such as `tools`, `vision`,
  `thinking` and `embedding`; models.dev catalogs cloud-model limits and prices.
- Local inference on macOS runs natively (Ollama, LM Studio, MLX) because containers in Docker
  Desktop for Mac have no Metal GPU access. A Docker foundation needs native inference providers
  to be first-class.
- GPU admission: Ollama's `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS` and
  `OLLAMA_MAX_QUEUE`; llama-swap switches models across engines on demand.

**Known pitfalls:**

- A lowest-common-denominator abstraction, the usual criticism of LangChain, hides reasoning,
  prompt caching and native tools. Keep a thin common core, explicit capability flags and
  provider-specific pass-through options.
- Ollama silently truncates prompts to `num_ctx`, whose default was 2K to 4K tokens for a long
  time; an agent then loses instructions or tool definitions without an error. Set the context
  explicitly and compare `prompt_eval_count` with the expected size.
- Small models emit malformed tool-call JSON or invent tools. Validate against the schema, repair
  or retry, and use structured outputs (Ollama `format` with a JSON Schema) where possible.

## I6. Events, Schedules And Optional Automation Applications

**Source:** Slide 14 describes scheduled chats, a serial queue and run history.

**Owner exploration:** Schedules, hooks and other events can initiate agents through a reusable
mechanism. A code-review application could select its own model, skills and instructions, react to
a new pull request associated with a workspace, inspect it and publish review threads. Other apps
could define unrelated personal or team workflows through the same building blocks.

**Candidate interpretation:** An event or schedule supplies the trigger; a configured action invokes
a provider; a run record tracks the outcome and results. Application-specific logic decides what a
review means and where its findings go. The review example needs the repository/PR identity and
reviewed revision, including a policy for a newer revision arriving during execution. Writing review
comments is a separately authorized effect, not a consequence of merely observing the event.

**Open boundary:** The owner suggested a Core-level mechanism, possibly extended by providers.
Existing direction gives Core durable delegation and puts the runner in an app/client. Current Core
events are ephemeral refresh hints, not a durable job queue. Delivery, deduplication, replay,
cancellation, retries and overlap policy remain questions; this note creates no second scheduler
plan. Serialized work can be scoped to a task or resource where needed rather than the whole host.

**Prior art and options** (reference design: a Windmill-style automation app built for Hosty):

- Event envelope: CloudEvents, where `id` plus `source` give deduplication and `type`, `subject`
  and `time` describe the event.
- Queue: Windmill keeps its job queue in Postgres with `FOR UPDATE SKIP LOCKED`. One host needs
  neither Redis nor Kafka; a SQLite or Postgres table is enough to start.
- Durable execution engines to study or embed: Restate (single binary), Hatchet (Postgres),
  Inngest (concurrency keys, debounce, idempotency keys) and Temporal (heavier, with the strongest
  replay model); in .NET, Quartz.NET (misfire instructions) and Hangfire.
- Overlap policy per resource: a concurrency key such as the PR id, like GitHub Actions
  `concurrency` with `cancel-in-progress`, answers "a newer revision arrived during review".
- Schedules people read: RFC 5545 RRULE ("every second Tuesday") alongside cron.
- Review automation reference: PR-Agent (open source, any LLM including Ollama). This repository
  already runs hosted Codex and Claude reviews, so a Hosty review app earns its place through local
  models or workspace context.

**Known pitfalls:**

- Exactly-once delivery does not exist; handlers must be idempotent. Deduplicate webhooks by
  delivery id (GitHub's `X-GitHub-Delivery`), answer quickly (GitHub waits about 10 seconds) and
  process asynchronously.
- Definitions change while runs are in flight. Windmill pins each run to a script hash, and
  workflow versioning is Temporal's hardest operational topic. Pin the definition version per run
  and let running work finish on it.
- Missed schedules: Airflow's long-standing `catchup=True` default (changed in Airflow 3) launched
  floods of backfill runs after downtime. Make the misfire policy explicit: skip, run once or catch
  up.
- Daylight-saving transitions run a 02:30 job twice or never. Store the time-zone name rather than
  an offset, and test DST boundaries.
- n8n's execution history grew until pruning was added. Apply a retention policy to run records
  from the first version, and mask secrets in run logs.
- Feedback loops: an agent triggered by a comment event writes a comment, which triggers it again.
  Record the originating actor on events, suppress self-triggering and cap chain depth.

## I7. Personal Speech Correction And A Reusable Dataset

**Owner exploration:** Preserve raw recognition output, let the speaker correct names such as
"Hosty," remove filler words and improve phrasing, and accumulate examples that personalize future
dictation. Fine-tuning is one possible consumer of these examples.

**Candidate interpretation:** Keep recognition correction and editorial cleanup as separate labels:

| Material | Potential use |
| --- | --- |
| Original audio or selected audio segments | Evidence of pronunciation and input for ASR adaptation |
| Raw transcript, model/settings and segment references | Reproduce errors and compare recognizers |
| Human-corrected faithful transcript | Target for recognizing what was actually spoken |
| Edited text with fillers removed or thoughts reorganized | Examples for a separate text-cleanup step |

Text corrections alone cannot teach an ASR model how the speaker sounds. They can support a
correction dictionary, retrieved editing examples or a text postprocessor. If audio is discarded,
that limits future acoustic adaptation. Dataset capture and retention could be an optional feature
with selected examples rather than an unconditional recording archive for all users.

Whisper can be fine-tuned from paired audio and transcripts using a training stack such as
Transformers. That is separate from loading a model for inference. Vocabulary prompting is another
candidate: upstream Whisper accepts an initial prompt for names and specialized vocabulary. Whether
and how to expose equivalent behavior in the installed Whisper.net path still needs evaluation.

An initial experiment could compare vocabulary hints and conservative text cleanup before choosing
training. Cleanup should preserve intent, numbers, negation and uncertainty, with the original and
edits available for inspection. A useful evaluation set would contain recordings kept out of
training/examples, including names and ordinary speech. Recognition accuracy and editing quality
need different evaluation criteria; no amount of data or improvement is promised here.

**Current baseline:** Hosty's speech service uses Whisper.net/whisper.cpp on CPU and accepts pinned
`tiny`, `base` or `small` models. It returns recognized text without a correction dataset or training
pipeline. Custom model loading, training/export compatibility and the correction UI would require
separate work. The present implementation does not become adaptive by saving transcripts alone.

**Prior art and options:**

- Vocabulary without training: Whisper.net's processor builder accepts an initial prompt
  (`WithPrompt`), so a short list such as "Hosty, Harness, Core" works with the current engine.
- Models stronger than `small` for Russian: GigaAM-v3 (Sber, Russian-specific) and
  Parakeet-TDT-0.6B-v3 (25 European languages including Russian, fast on CPU). sherpa-onnx runs
  both, has a C# API and supports hotword biasing for transducer models, which can fix names
  without fine-tuning. A quantized Whisper `large-v3-turbo` is another option.
- Fine-tuning path: Hugging Face Transformers with PEFT/LoRA, then conversion to ggml for
  whisper.cpp.
- Dataset format: a JSONL manifest in the NeMo or Lhotse style (`audio`, `duration`, `raw`,
  `verbatim`, `edited`, `model`, `settings`), with Silero VAD for segmentation.
- Evaluation: WER and CER with jiwer, plus a separate recall score over a list of names.
- Dictation products to study: VoiceInk (open source, with a personal dictionary and AI cleanup),
  Handy and superwhisper.

**Known pitfalls:**

- Whisper hallucinates on silence. In Russian the classic outputs are subtitle credits and "to be
  continued" lines inherited from subtitle training data. Run VAD first, apply a no-speech
  threshold and filter known phrases.
- Conditioning on previous text can lock Whisper into repetition loops; disable it or reset it
  when output repeats.
- A long initial prompt gets copied into the output, and only about the last 224 tokens count.
  Keep it to a short word list.
- LLM cleanup can change meaning through numbers, negation and hedges. Keep the raw text, show a
  diff and forbid edits to numbers and negations.
- In a household every speaker's voice is personal data. Consent to recording and training
  belongs to each speaker, not to the device owner.

## I8. Additional Ideas Kept For Reference

- Model selection for background work: slide 19 uses a separately configured summarization model.
  Indexing, extraction and summaries can have different requirements from the main conversation.
- Retrieval migration: slides 12 and 17 describe rebuilding indexes when the embedding model changes.
  Any provider replacement discussion needs source portability and derived-index lifecycle.
- Context compaction: slides 5, 6 and 19 describe preserving recent messages and summarizing older
  ones. This can coexist with lazy retrieval; a summary does not authorize deleting all source data.
- Progress and recovery: slides 8 and 21 describe tool progress and reconnect/restore. Long imports
  and specialist generation also benefit from inspectable operation state.
- Conversation branches: slide 22 describes edit-and-retry as a new node. This is distinct from
  several sessions sharing a workspace or knowledge collection.
- Local placement and data flow: the deck also uses Google OAuth and external integrations. A local
  model alone does not make an entire operation offline; auxiliary processing matters too.

**Prior art and options:**

- Conversation branches: a message tree with a `parent_id`, as in Open WebUI and LibreChat, where
  edit-and-retry creates a sibling node.
- Open WebUI and LibreChat together cover most of the presentation's feature list (Ollama, RAG,
  memory, ComfyUI, MCP, branches, several users) and are useful reference designs for a Hosty chat
  app.
- Compaction: keep recent turns verbatim and replace older ones with a summary that references the
  stored originals.

## I9. Native Subagents, Visibility And Delegation Controls

**Owner exploration:** The agent-management interface could show when a provider runs several
subagents, including work it delegates automatically. Users could also explicitly request subagent
assistance or guide delegation through instructions when the provider supports it.

**Candidate interpretation:** Treat observing subagents and controlling them as separate provider
capabilities. A provider may expose child-run activity without allowing Hosty to create, message or
cancel individual children. Capability discovery should reflect the configured provider/runtime;
a model name or reasoning-effort setting alone is not evidence of support.

A compact activity view could show parent/child relationships, each child's task or role, reported
model where available, state, and a result summary or artifact reference. Parallel work, waiting,
requests for approval, failures and completion would be visible without turning every child into a
separate top-level chat. Runtime events and declared summaries are sufficient; this does not require
access to private model reasoning. Missing telemetry should appear as unavailable detail rather
than a claim that no subagents exist. Stable run identities could preserve the view after reconnect.

Possible controls include requesting delegation for a task, choosing an available specialist/profile,
and configuring delegation preferences or concurrency/budget limits. These are candidates, not a
selected UI or API. Instruction-based preferences and enforced runtime controls must be presented
differently: sending "use subagents" is a request, not proof that delegation occurred. Unsupported
controls should be identified rather than silently treated as effective.

Native subagents inside a provider and delegation to another provider, discussed in I4, can share
some presentation concepts while retaining different ownership and control contracts. A child need
not own a separate persistent session or workspace. Sharing files does not itself coordinate
concurrent edits or grant broader access.

**Open boundary:** Compare the information and controls real providers expose before selecting a
common child-run contract. Parent cancellation, child failures, approval ownership, limits on nested
delegation and attribution of usage need defined semantics; aggregate usage should not count the
same work twice. A Hosty-managed delegation mechanism could complement native support, but would
need to be identified as its own execution mechanism. This idea adds no new implementation plan.

**Prior art and options:**

- Claude Agent SDK messages carry `parent_tool_use_id`, and its hooks report subagent lifecycle;
  Codex's app-server protocol emits its own item events. Normalizing both into OpenTelemetry GenAI
  spans produces a parent/child tree.
- Trace views to study: Langfuse (self-hostable) and Arize Phoenix.
- Usage accounting: record tokens only on leaf `chat` spans and aggregate upwards, which avoids
  counting delegated work twice.

**Known pitfalls:**

- Deep fan-out makes a flat trace unreadable. Collapse children by default and show one summary
  line per child.

## I10. Interactive Sessions That Wait For User Actions

**Owner exploration:** A user could ask an assistant to start an interactive activity, act in an
application's UI, and receive the assistant's next response in the same conversation. Chess is one
example; learning exercises, forms and collaborative editing could use the same mechanism.

**Candidate interpretation:** Keep the application's domain state, the conversation and each agent
run distinct. The app could retain an activity identity, current state and its link to a session.
After a response, the interaction can wait without repeatedly invoking the model. A relevant user
action could continue the associated session with bounded context: the action, current state and
any results needed for the next response. The model need not reconstruct the activity from the
entire transcript. Persisted state could allow the user to close the UI and return later.

MCP tools can expose application actions and state. Elicitation is a possible mechanism for asking
the user for input through a supporting client; MCP Apps can provide an interactive view that calls
tools and sends messages or context to the host. Hosty's own app panels are another presentation
candidate. These mechanisms are not interchangeable guarantees: a notification or context update
does not by itself promise that an agent will run. The assistant host needs an explicit connection
between the interaction and the appropriate session, subject to its provider's continuation support.
Keeping a tool call pending is another option for bounded waits, with client/runtime timeout limits
to investigate; it need not be the lifetime of the activity.

**Open boundary:** Determine which app or client owns continuation, how a waiting activity is
cancelled or resumed after reconnect, and how duplicate actions or actions against an older state
are handled. Opening or focusing a panel should remain separate from submitting an action.
The [panel system](features/sdk-panel-system/feature.md) and
[background sessions](features/agent-background-sessions/feature.md) are related existing concepts,
not evidence of a complete app-action continuation contract. Relate this idea to I6's event and
execution questions without selecting a new scheduler, MCP adapter or Core responsibility here.

**MCP revision update:** The 2026-07-28 MCP revision supersedes the 2025-11-25 revision cited in
the references. It removes protocol sessions and the initialize handshake, and recommends that a
stateful server return an explicit handle from a tool for the model to pass back, which matches
the activity identity above. Server-to-client requests such as elicitation are allowed only while
a client request is being processed, through an `input_required` result. Elicitation therefore
suits short clarifications, not waits at a person's pace. Tasks moved to an extension, and
sampling is deprecated.

**Prior art and options:**

- MCP Apps (SEP-1865, stable since 2026-01-26; hosts include Claude, VS Code Copilot and Goose):
  a server returns a `ui://` resource that the host renders in a sandboxed iframe. The view can call
  tools and send `ui/message` into the conversation, which is the explicit link between an action
  and a continued session. Aligning the panel system with MCP Apps would let one app view work in
  Harness and in other MCP hosts.
- Actions taken outside the chat: a Harness inbox resumes the session by id (Claude Agent SDK
  `resume`, Codex thread resume) with a synthetic user message carrying the action, a state
  snapshot and its version.
- AG-UI (CopilotKit) is an event protocol between agents and UIs, with `STATE_SNAPSHOT` and
  `STATE_DELTA` (JSON Patch) events and interrupts for human input.

**Known pitfalls:**

- State kept only in the transcript drifts. The app is the source of truth, and each turn receives
  a fresh snapshot.
- Stale and duplicate actions: carry a state version and an idempotency key, and reject a
  mismatched expected version with a conflict.
- MCP clients apply tool-call timeouts, so an open tool call cannot wait at a person's pace.
- Every action that starts a model run costs latency and money. Decide per activity whether to run
  on every action, on request, or only on significant events.

## I11. Application-Provided Roles, Instructions And Interaction Profiles

**Owner exploration:** An application could supply the assistant with roles, additional instructions
and selectable behavior profiles for its own activity. Users could choose a profile in the app
without writing a system prompt themselves. A game might offer an opponent or coach; a language
app might offer a conversation partner or teacher.

**Candidate interpretation:** A profile could combine instructions, relevant tools and context,
and application parameters. Keep its scope and duration explicit: a role for one activity should
not silently change unrelated conversations. App instructions guide behavior within the user's
selected scenario; they do not grant extra access or override platform or user constraints.
Changing a profile could change tone or assistance without discarding the activity's state.
Instructions express preferences, while app rules and runtime controls enforce concrete limits.

### Example: Chess With Difficulty, Personality And Coaching

The user says "Let's play chess," the app creates a match and opens its board, and the assistant
joins as the selected opponent or coach. A move made on the board, by voice or in chat is validated
by the game. The resulting position can trigger the next assistant response through the interaction
described in I10. Move comments can accompany the opponent's reply or be requested separately.

Three independent choices could shape the experience:

- **Difficulty:** Beginner, intermediate or stronger play, including deliberate leniency for a
  beginner. The game or a selected chess engine could control move selection and strength, with
  instructions supplementing those settings. Asking an LLM to "go easy" alone does not define a
  reproducible difficulty level. An LLM choosing moves and an engine choosing moves with an LLM
  explaining them are alternative arrangements, not a selected implementation.
- **Personality:** Calm, encouraging, competitive, talkative or playfully sarcastic commentary.
  Tone and verbosity can vary independently of playing strength. A strong opponent can still be
  supportive, and a beginner opponent can have an expressive character.
- **Coaching:** Explain good moves and mistakes, highlight threats, offer hints or suggest trying
  again. Feedback could appear during play, after a move or in a post-game review. A coach might
  say, "You attacked the rook, but left your knight undefended. Would you like to reconsider?"
  Such explanations should be grounded in the actual position and available analysis. Timing and
  hint settings can prevent unsolicited coaching from revealing the opponent's plan.

The chess app would own the board, rules, legal-move validation and persisted match state. The
assistant would handle conversation and use the available game tools. Opponent strength, analysis
and commentary can be supplied by different components when useful. Chess-specific rules and
personalities need not become Core features.

**Open boundary:** Explore how apps declare profiles and supported controls, how users inspect or
change the effective role, and how a role ends when the interaction ends. Provider capabilities,
instruction precedence and the distinction between advice and an executed action need clear
semantics. These are reusable interaction ideas, not a chess implementation commitment or an
addition to any feature plan.

**Prior art and options:**

- Profile carrier: MCP prompts (`prompts/list`, and `prompts/get` with arguments) are the standard
  way for a server to offer templates a user selects. Longer instructions fit Agent Skills, which
  Hosty already loads through [app-provided skills](features/app-provided-skills/feature.md). A
  profile can bundle a prompt, a tool subset and app parameters.
- Platform analogue: iOS App Intents let apps declare actions and parameters that the system
  assistant may invoke.
- Chess building blocks:
  - Rules: chess.js or python-chess.
  - State: FEN as the bounded snapshot, one line instead of the game history.
  - Reproducible difficulty: Stockfish with `UCI_LimitStrength` and `UCI_Elo` (from 1320), or
    `Skill Level` 0–20.
  - Human-like play: Maia-2 (via lc0) plays like a person of a chosen rating, which suits
    beginners better than a weakened Stockfish.
  - Grounded coaching: Stockfish MultiPV evaluation deltas classify mistakes, and the LLM
    explains only that structured analysis.
  - Board: chessground, Lichess's board (GPL-3.0, compatible with AGPL).

**Known pitfalls:**

- LLMs choosing chess moves play illegal moves at inconsistent strength. The engine chooses, the
  LLM explains.
- Waiting for a model on every move makes play feel slow. The engine replies immediately and the
  commentary streams afterwards.
- Tool poisoning: Invariant Labs showed in 2025 that instructions hidden in MCP tool descriptions
  steer the model. App-supplied profiles are the same channel, so show them, pin them, and require
  review of changed instructions on update, as manifests are reviewed today.
- Personas drift over long conversations. Keep profiles short and send them again each turn.

## I12. Workspace, Session And Material Lifetimes

**Moved from the vision on 2026-10-23.** The vision keeps decision 52's direction: workspaces are
optional, sessions are independent, and their association is a separate relationship. This section
keeps the details that still need design.

The [Multiple Sessions In A Shared Workspace feature](features/workspace-sessions/feature.md)
implements the approved 2026-10-25 scope of explicit administrator membership, concurrent internal
sessions, independent source identity and lifecycle/retention compatibility. Shared materials,
broader team roles and knowledge lifetimes remain exploration here.

| Resource | Intended lifetime and relationship |
| --- | --- |
| Workspace and its worktrees | Retained while useful for work and while source/consumer checks require them; optional for ordinary app use |
| Agent session | Has its own history and retention; can attach to or detach from a workspace |
| Documents, attachments and reports | May be shared materials with their own owner and lifetime rather than disposable chat files |
| Knowledge and decisions | Can remain useful across sessions and workspaces, including sessions that never had a workspace |
| Search index | Supports discovery of authorized material; storage and rebuild/deletion semantics depend on the selected provider |

Sharing concerns both people and their agents. Participation, reading a conversation, editing source,
using an app, running tests and publishing changes need distinguishable authority. The existing
administrator-only development path is the current baseline. Narrower team roles and ordinary-user
source work remain questions alongside [user sessions](features/user-agent-sessions/plan.md) and
existing execution/authorization work; this exploration does not mark their boundaries implemented.

Internal sessions are enough to reason about the first scenarios. The owner is not pursuing
external chat viewing or synchronization for now; [I17](#i17-viewing-external-agent-chats-beside-workspaces)
keeps the earlier exploration for reference. Preserve the existing external workspace capability
without assuming that Hosty can obtain another agent application's conversation history.

**Prior art and options:**

- Model the association as its own record (membership with attach and detach times) rather than a
  field on either side, so history keeps resolving to a tombstone after a workspace is deleted.
- Repository role ladders such as GitHub's read, triage, write, maintain and admin are a familiar
  starting point for distinguishing reading, editing, testing and publishing.
- Family accounts: Apple Family Sharing shares selected purchases, locations and albums while each
  member's private data stays private from the organizer.

**Known pitfalls:**

- Attachments owned by a chat disappear with the chat. Give materials an owner, a user or a group,
  and let sessions reference them.

## I13. Retention, Transcription And Summaries

**Moved from the vision on 2026-10-23.** Users may choose to keep, archive, summarize or delete
conversations independently of workspaces. One possible experience offers those choices when a
conversation ages, including summarizing before deleting its full history. Another installation may
retain all text transcripts. No universal retention duration or automatic deletion rule is selected,
and storage cost alone does not decide how much history is useful.

Optional recorded conversations or meetings could be transcribed into text without retaining the
original audio indefinitely. Recording, audio retention, transcription and later summarization are
separate choices; this is not a requirement to record every discussion. A summary is a lossy derived
material, not a complete transcript. Preserve its provenance and make unavailable originals clear;
any retained supporting excerpts need explicit retention semantics. Full history, summaries,
attachments and search copies need coordinated deletion rules, without retaining workspace resources
as an accidental archive. Indexing and bounded retrieval must keep a large archive from filling an
agent's context in one request.

**Prior art and options:**

- Coordinated deletion: one deletion record (a tombstone) that every derived store consumes, using
  the same changes feed proposed in I2 for originals, summaries, attachments and index entries.
- Meeting transcription with speaker labels: WhisperX and pyannote. Voice sessions with an agent:
  LiveKit Agents and Pipecat.

**Known pitfalls:**

- Slack's 2022 move to a 90-day history on its free plan drew strong backlash. Deleting history
  must be explicit and visible, never silent.
- A summary shown without its source looks authoritative after the original is gone. Mark it as
  derived and say when the source is unavailable.
- Recording needs consent from every participant, not only from the person who starts it.

## I14. Collaboration And QA As Optional Compositions

**Moved from the vision on 2026-10-23.** A development example combines business analysis and plans,
source work, tests and review. A business analyst may work in an external system or a Plans-like
app. A developer may prepare a workspace and give QA access to test it; QA may describe a failure or
ask an authorized agent to propose a fix, and a developer may inspect, adjust and publish those
changes. Users can exchange responsibility or work concurrently. None of those roles or transitions
is a mandatory platform workflow, and a single person can use the same capabilities.

**Selected investigation, 2026-10-25:** [vision decision 54](vision.md) and the
[Composable Human And Agent Work Draft](features/composable-agent-systems/plan.md) now track
the reusable capability/gap map, ownership questions and investigation order behind these
compositions. Specific QA application designs and collaboration forms below remain ideas.
The umbrella and the separate [capability Drafts](features/composable-agent-systems/plan.md#separate-owners-and-initial-packaging-2026-10-26) preserve existing feature ownership and authorize no implementation.

**Owner refinement, 2026-10-26:** [Vision decision 55](vision.md) and that Draft capture the
preferred shared task/agent-participant model, explicit artifact handoffs and a common Decisions
surface. One document can initiate one task, whose responsible participant creates visible child
tasks and assignments. A coordinator keeps its extra workflow state and agent hierarchy separately.
Task and agent hierarchies are independent. Decisions 62-64 select existing users/apps and opaque
executor choices; Harness profiles remain internal configurations with lifetimes distinct from runs.

Related delegated work normally reuses a selected workspace. An unrelated defect discovered during
feature work can instead have an explicit independent workspace and PR, with a human decision about
urgency or hotfix targeting. Avoid accidental duplicate workspace creation; do not enforce one
workspace on every task tree. Choosing child versus related task remains an app workflow decision.

The [Basic Tasks](features/basic-tasks/feature.md) feature provides the first manual/API task journey.
The [Harness Work Orchestration Draft](features/harness-work-orchestration/plan.md) retains the later
combined Tasks, Decisions and Artifacts experience; separate clients can also consume the contracts. Decisions can reach a responsible human or a team reviewer rather than only
the person watching a chat. A quick reply continues live work; an overnight wait preserves the
question and resumable state, and the eventual answer triggers continuation. Exact packaging,
schema and resource-wait policy remain Draft questions. Basic artifacts support these handoffs;
learned memory stays only in I1 and outside the current work.

**Skill-library boundary, 2026-10-26:** [Vision decisions 57-60](vision.md) and the
[Shared Skills](features/agent-skills/feature.md) select one administrator-managed Core pool,
profile selections and current installed content, without retained session revisions. Automatic Git skill updates and personal
skill libraries remain possible later ideas, without a commitment or current deliverable. The first
slice has Git/app packages, manual Git updates, app-coupled updates and editable instructions/profiles;
it excludes a package editor/fork workflow. Manual skill package upload is deferred as a possible
later idea, without a delivery commitment. These possibilities must not reintroduce
per-user pools or in-product package editing as dependencies of the initial orchestration UI.

It should be possible to distinguish earlier implementation work from later QA/agent changes and
review a particular change before committing it. Commits and PRs provide some evidence; reviewable
uncommitted changes and links to sessions/runs are also candidates. Their representation is open,
including whether checkpoints are useful. Concurrent unrestricted writes to one directory do not
provide reliable authorship merely because a session was active. This does not introduce source
snapshot/restore guarantees or relax repository commit rules.

A workspace might group one feature, several independent efforts or a release, with zero, one or
several PRs. Multiple PR references do not themselves supply independent branches or safe concurrent
publication; worktree/branch structure and change attribution need design. Existing per-repository
feature/PR rules remain applicable. Comments or discussion threads may refer to a workspace, session,
plan, change or test result. Text or optional voice collaboration could help participants and an
agent prepare a plan together, while the resulting plan has its own explicit review and authority.

A QA application could let a person describe scenarios, have an agent generate or refine Playwright
or other test definitions, review those definitions, run them on demand or by a chosen schedule,
and inspect reports. Test authoring, runner/provider, scheduling and reporting may be separate
capabilities or one app's composition. Reuse authorized sandbox/runtime inputs and export useful
results independently of temporary resources. Existing Playwright/browser support is a starting
point, not proof that this proposed QA application or automatic scenario pipeline exists.

**Prior art and options:**

- Playwright Test Agents (planner, generator and healer, since Playwright 1.56) together with
  Playwright MCP follow the same path: describe a scenario, generate a test, review it, run it.
  Reports can use Playwright's HTML reporter or Allure.
- Attribution with several writers: isolated worktrees and commit trailers such as
  `Hosty-Session: <id>` are possible approaches. Hosty's
  [shared-workspace feature](features/workspace-sessions/feature.md) permits cooperative concurrent
  sessions; their activity alone does not prove authorship. Jujutsu (jj), whose working copy is
  always a commit with an operation log, is a model for reviewable uncommitted changes.
- Joint planning by voice: LiveKit Agents or Pipecat.

**Known pitfalls:**

- Several writers in one directory lose authorship and overwrite each other. Isolation per session
  followed by a merge is more reliable for source than real-time co-editing.
- Generated end-to-end tests become brittle when they target CSS structure. Prefer role- and
  label-based locators, which Playwright's generator already favors.

## I15. Bringing Existing Applications Into Hosty

**Moved from the vision on 2026-10-23.** The desired entry points include installing from a catalog,
a remote link or an existing local repository. One candidate flow selects source/development
execution at installation and reuses the operator's existing checkout, possibly through existing
override mechanisms, without creating a second source copy. A later explicit switch can select a
packaged production runtime. This revisits source-adoption choices; it does not change today's
registered-workspace instructions, adopt a checkout, or select a live runtime merely by recording
the idea.

Another candidate lets an agent inspect an existing web project and prepare the Hosty manifest
using its declared commands, such as those in `package.json`. The intended benefit is convenient
Start/Stop and managed hosting with minimal project changes, ideally a manifest where sufficient.
Arbitrary projects may need additional runtime configuration. Manifestless/convention-based hosting
is a further possibility, not a selected manifest-contract change. These entry points should be
useful without a mandatory Marketplace, Shell or hosted assistant; an authorized external client
may supply the editing workflow. Existing installation/source/runtime behavior remains authoritative
until a concrete change is approved.

**Prior art and options:**

- Detecting how to build and run a project: Railpack (the successor to Nixpacks), Cloud Native
  Buildpacks, `devcontainer.json` and the Procfile convention.
- `docker-compose.yml` as an input: many projects ship one, and the Umbrel, CasaOS and Runtipi app
  formats are compose-based. A converter to a Hosty manifest, in the spirit of Kompose, would turn
  such a project into a Hosty app.

**Known pitfalls:**

- Sandstorm's strong app model required porting each app, and its catalog stagnated. Keep the
  manifest-only path cheap.
- Convention detection guesses wrong on monorepos and custom scripts. Show the generated manifest
  for review instead of applying it silently.

## I16. A Portable Environment And A Dedicated Hosty OS

**Owner exploration:** Hosty runs on macOS, Windows and Linux, with apps mostly in containers. A
person who uses it as a personal assistant and data store could move the whole environment (apps,
their data, settings and identity) to another machine or operating system in one step, and could
eventually boot Hosty as a dedicated system on its own device. External mounts that point at other
host data are the expected exception.

**Candidate interpretation:** An environment archive could hold the installed apps with pinned
versions and digests, Core state (users, assignments, grants, settings), each app's data and a
separately protected secrets bundle. Restore installs the same versions on the target and imports
the rest. The existing per-app [data backups](features/app-data-backup-retention/feature.md), which
cover each app's primary data directory, are a natural base; the
[secrets store](features/app-secrets-store/feature.md) stays outside backups and needs an explicit
export.

**Prior art and options:**

- Whole-installation backup and restore: Home Assistant restores a full backup during onboarding on
  new hardware; Cloudron and YunoHost restore onto a new server; Sandstorm let users download and
  upload individual grains. Velero does the same for Kubernetes clusters. Most of these assume the
  same operating-system family, so moving across operating systems is the less common part.
- Deduplicated, encrypted archives: restic and Kopia are cross-platform single binaries.
- A dedicated OS image: bootc builds a bootable OS from a container image, which fits a
  container-based platform. Fedora CoreOS and Flatcar are immutable container hosts, and NixOS
  gives reproducible images. Home Assistant OS and umbrelOS are appliance images to study.

**Known pitfalls:**

- CPU architecture: Apple Silicon and Raspberry Pi are arm64, most servers are amd64. Every app
  image needs both architectures, and native apps need a build for each.
- Database files are not a portable format. Postgres data directories are bound to the major
  version and platform, so portable archives use logical dumps (`pg_dump`) or an app-provided
  export hook. Copying the data of a running app produces torn copies; stop it or quiesce first.
- Filesystems differ: case sensitivity (APFS and NTFS usually ignore case, ext4 does not), file
  ownership and UIDs in bind mounts, symlinks and path length on Windows.
- Secrets bound to a machine (keychain, DPAPI) do not move. Re-encrypt them under a passphrase for
  export.
- Host-specific settings break on a new machine: ports, public origins, tunnel tokens and OAuth
  redirect addresses.
- Native workloads, such as GPU inference on macOS, do not move as they are. The target has to
  satisfy the same provider role with its own runtime.
- "One click" can still mean hundreds of gigabytes of media. Show the size and allow excluding
  large data.

## I17. Viewing External Agent Chats Beside Workspaces

**Owner position, 2026-10-23:** Do not pursue chat viewing or synchronization for external systems
for now, including the proposed Codex viewer. The owner currently leans against adding this
capability. The separate Draft prepared on 2026-10-22 is withdrawn; the notes below preserve the
possibility for reference, without a plan, delivery commitment or implementation approval.

**Original motivation:** An operator could read the conversation behind external development
work beside its diff, branch and PR in Harness, reducing switches between applications when several
tasks are active. Its value is less clear when the operator already follows the work in Codex and
uses Harness mainly for application management. The cost includes local-profile access, client
compatibility, conversation binding and continued maintenance.

**Earlier candidate, retained as context:** The proposed first version was a read-only view of one
explicitly selected local Codex chat associated with an external workspace. It would show saved
user/assistant messages and compact tool activity, load older pages on demand, and refresh on entry,
manual request or return to the view. A last-read timestamp and incomplete/unavailable indicators
would distinguish saved history from live execution. Live streaming, durable history mirroring,
attachment-file access and recursive child-chat imports were not part of that proposal.

The design boundaries considered were:

- Codex would remain the conversation owner. No composer, session start/resume/stop, steering,
  approvals, provider switching, execution takeover or automatic context import into a Harness agent.
- A workspace/task ID, agent label, branch or working directory would not establish the identity
  of a Codex chat. Any association would need an explicit thread and local-profile identity, scoped
  access and a way to unlink it without changing Codex history.
- A backend reader would use supported history APIs rather than depend on internal SQLite/JSONL
  formats. It would expose only authorized history reads, not an unrestricted provider connection.
  Core would retain its workspace role rather than become a conversation engine.
- Native and containerized Harness have different access to the host user's Codex profile. A local
  helper might be necessary; a browser alone cannot read that history. Mounting the entire Codex
  home or copying provider credentials was not selected as an integration approach.
- Codex would stay the authoritative history store, with only bounded disposable viewer caches.
  Unlinking, permission changes and workspace deletion would clear the view without deleting the
  source chat. An inaccessible or archived chat would not justify resuming or taking it over.

**Technical lead from 2026-10-22:** The
[official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) described
stored-history methods such as `thread/read`, `thread/turns/list` and `thread/items/list` without
resuming a session. Method/store compatibility and safe reading while another client owns the
active chat were not tested for this idea. A history-read API does not establish live subscriptions
or guarantee compatibility with the Codex version bundled in Harness.

**Questions only if reconsidered:** Is the benefit sufficient to maintain another chat view?
Which local topology and Codex versions are supportable? How could the operator authorize and bind
one conversation without exposing unrelated chats? How would paging, stale content and permission
revocation behave? Revisit these questions only after an explicit decision to reopen the idea.

**Related scope:** [External development workspaces](features/external-development-workspaces/feature.md)
continue to support source work and observed Git/PR state without a synchronized chat. The separate
[external context exchange](features/assistant-external-session-context/plan.md) proposal concerns
explicit reads/reports, already excludes automatic Codex synchronization, and is not expanded or
approved by this note.


## Platform Precedents

Hosty is meant to work like an operating system for its own applications. These precedents from
operating systems and app platforms apply across several ideas:

- **Sandstorm**, the closest "OS for a personal server": grains and the Powerbox grant access to
  selected objects through a picker the user controls. The model was strong, but adapting apps was
  expensive and the catalog stagnated. Borrow Powerbox-style grants for household sharing (I3, I12)
  and keep app adoption cheap (I15).
- **Android permissions** moved from all-or-nothing grants at install time to runtime prompts,
  one-time grants and automatic revocation of unused permissions. The same lessons apply to
  optional Core permissions.
- **iOS Core Spotlight** lets apps donate items to a system index (I2).
- **Windows 8 Search and Share contracts:** few apps implemented them well, and the Search
  contract was deprecated in Windows 8.1. Provider contracts must be small enough that Hosty's own
  apps implement them.
- **Android content URIs and macOS security-scoped bookmarks** are references that carry access
  (I3).
- **iOS App Intents** are declared app actions that the system assistant invokes (I11).
- **Home Assistant** frustrated users with frequent breaking changes until it introduced
  deprecation periods and a Repairs dashboard. The 2026-07-28 MCP revision also added a
  deprecation policy. App contracts need one too.
- Every optional capability multiplies the possible configurations. Define a minimal composition
  and test how each feature degrades without each provider.

## Relationship To Existing Documents

The following implementation observations were checked on 2026-10-23 at repository commit
`c31c76db4f6c18c73898548d3a46dc7103f4fc5d`. Recheck them when revisiting an idea; the collection
itself can evolve and is not a frozen review of that commit.

- [Vision](vision.md) keeps decision 52 and the direction for personal and shared environments.
  I12–I15 and part of I1–I2 moved here from it; this collection makes no new vision decision.
- [Core extension model](features/core-extension-model/feature.md),
  [provider consumption](features/provider-consumption/feature.md) and the
  [MCP directory](features/agent-mcp-directory/feature.md) describe existing boundaries. Memory,
  search and shared-file roles described here are proposed concepts, not accepted Core permissions.
- [MCP facade](features/mcp-facade/plan.md) is On Hold and places a future general facade in an
  app. A Core memory facade is therefore an open architectural choice, not an existing convention.
- [Agent/model provider interface](features/agent-provider-interface/plan.md) is Draft and already
  considers multiple models, Ollama, bounded inference and full agent execution. Agent connections
  in Harness are not yet a generally available `providers.agent` contract.
- [Durable Agent Jobs](features/durable-agent-jobs/plan.md) owns the former Bridge D11 scope of
  remaining durable jobs; [Core events](features/core-event-bus/feature.md) do not supply their
  persistence contract. This collection does not change either plan's scope or status.
- [SpeechEngine](../apps/whisper/Hosty.Whisper/SpeechEngine.cs) and the
  [speech endpoint](../apps/whisper/Hosty.Whisper/Program.cs) establish the recognition baseline.

## Technical References

Primary sources consulted on 2026-10-23, in addition to the supplied slides and repository baseline:

- [Ollama tool calling and agent-loop examples](https://docs.ollama.com/capabilities/tool-calling).
- [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/).
- [Ollama deployment, local-only mode and concurrency](https://docs.ollama.com/faq).
- [Upstream Whisper transcription and initial-prompt support](https://github.com/openai/whisper/blob/main/whisper/transcribe.py).
- [Hugging Face's Whisper fine-tuning walkthrough](https://huggingface.co/blog/fine-tune-whisper).
- [MCP elicitation, protocol revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).
- [MCP Apps interactive views and host communication](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html).
- [MCP 2026-07-28 release candidate: stateless core, extensions, Tasks and deprecations](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).
- [MCP Tasks proposal and its move to an extension](https://modelcontextprotocol.io/seps/1686).
- [rclone iCloud Drive backend](https://rclone.org/iclouddrive/).
- [Ollama Anthropic API compatibility](https://docs.ollama.com/api/anthropic-compatibility).

The technical references establish available mechanisms, not verified Hosty integrations.
Concrete integrations require their own investigation and verification when an idea is developed.

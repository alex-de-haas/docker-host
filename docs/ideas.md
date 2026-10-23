---
created: 2026-10-23
updated: 2026-10-23
---

# Ideas

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

## I1. Memory As A Replaceable Provider

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

## I3. Shared Artifacts, External References And Configurable Storage

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

## Relationship To Existing Documents

The following implementation observations were checked on 2026-10-23 at repository commit
`c31c76db4f6c18c73898548d3a46dc7103f4fc5d`. Recheck them when revisiting an idea; the collection
itself can evolve and is not a frozen review of that commit.

- [Vision](vision.md) contains the broader personal/shared environment exploration. This collection
  preserves additional candidates separately and makes no new vision decision.
- [Core extension model](features/core-extension-model/feature.md),
  [provider consumption](features/provider-consumption/feature.md) and the
  [MCP directory](features/agent-mcp-directory/feature.md) describe existing boundaries. Memory,
  search and shared-file roles described here are proposed concepts, not accepted Core permissions.
- [MCP facade](features/mcp-facade/plan.md) is On Hold and places a future general facade in an
  app. A Core memory facade is therefore an open architectural choice, not an existing convention.
- [Agent/model provider interface](features/agent-provider-interface/plan.md) is Draft and already
  considers multiple models, Ollama, bounded inference and full agent execution. Agent connections
  in Harness are not yet a generally available `providers.agent` contract.
- [AI Agent Bridge](features/ai-agent-bridge/plan.md#step-11--durable-jobs-and-notifications) owns
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

The technical references establish available mechanisms, not verified Hosty integrations.
Concrete integrations require their own investigation and verification when an idea is developed.

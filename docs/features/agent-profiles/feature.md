---
created: 2026-10-26
updated: 2026-10-29
summary: Shared Harness agent configurations with connection, model, reasoning, role instructions and explicit skills, selectable before a conversation starts.
components: [apps/harness]
---

# Shared Agent Profiles

Harness stores a shared collection of reusable agent configurations. A profile has a unique display
name, description, role instructions, connection reference, model, reasoning effort and selected
Core skill IDs. It has no archive/active state, identity, project/app/workspace binding or permission
settings. Generalists and specialists use the same configuration. Permissions and native tool
approvals remain independent of profiles and their instructions.

Profiles are Harness-owned application data and use its administrator API. They are separate from
provider credentials and conversations, and are shared within Harness rather than exported to other
applications. The configuration type and controlled `AgentProfileForm` component are reusable without
a second configuration editor. [Basic Tasks](../basic-tasks/feature.md) exposes profiles as opaque
executor choices and snapshots the selected configuration into each accepted execution. Profiles
remain private to Harness; task providers receive no configuration or credentials. Richer
coordination belongs to [Harness Work Orchestration](../harness-work-orchestration/plan.md).

## Editing And Defaults

Settings → Agent profiles supports create, edit, duplicate, delete, set default and clear default.
The form explains shared working rules versus role specialization, loads models/efforts from the
selected connection and selects optional guidance from the [Core skill library](../agent-skills/feature.md).
Changing connection clears provider-specific model/effort values; changing model clears effort.
Ollama profiles preserve tagged model IDs and advertised thinking values. Incompatible installed
models are disabled with their server/catalog reason; no compatible model is substituted.
Unavailable connections/models produce errors rather than substitutions. Failed discovery retains
saved selections. Profile-list loading is independent of connection discovery.

Common instructions remain under Instructions and retention. Role instructions are additional
standing guidance. [Core platform context](../core-platform-skills/feature.md) is included for every
agent; the profile editor shows its package checked and disabled with Core version provenance.
Additional packages, including `hosty-app-skill`, remain optional native guidance, with no implication
that each package must activate on every turn. The Skills tab manages packages; it has no assistant-wide
selection checkboxes. The legacy settings mutation rejects skill selection with `skill_selection_moved`.

On first profile-store access, General captures the previously selected assistant skills but is not
selected as the default. New installations start without a profile. An operator can explicitly set a
default in Settings; existing configured defaults and conversation snapshots are preserved. Existing skill migration runs before that capture. Initialization occurs once; deleting
all profiles does not recreate General. Creating another profile does not change the default.
Deleting the default clears it. A chat without a profile receives the platform introduction and
package, common instructions and no implicitly selected additional skills. Explicit session `skillIds` remain supported for manual/API consumers.

Names are unique ignoring case, with a 100-character limit. Descriptions allow 2,000 characters and
role instructions 8,000. A collection holds at most 200 profiles. Skill references use existing Core
stable IDs while the interface shows native names and Core provenance. Successful catalog reads prune deleted
IDs from editable profiles and persist the removal. Catalog outages retain selections. Skill files
keep current-content export semantics; profile snapshots do not preserve removed package bytes.

The store serializes changes and atomically replaces `{data}/agent-profiles.json`. Directory and
profile revisions reject stale edits/selections. A failed save keeps form fields; reloading stored
values requires the explicit Reload saved profile action. Settings load on entry and refresh after
action or explicit Refresh, without periodic requests that overwrite edits.

## Conversation Selection And Persistence

A new chat starts with No profile unless the operator explicitly configured a default or supplied a
profile choice. No profile leaves provider selection available before the first message. Before its
first message the composer can switch profile, applying connection/model/effort, role and skill
selection as one persisted change. Profile selection and message dispatch share the session queue
and selection revision, so a send cannot race a partially applied profile. Creating or switching
conversations retains one set of profile, model, reasoning and provider controls for the selected
session. Profile changes refresh the saved configuration together, without requiring a page reload.
When a model event overtakes a pending profile read, the client replaces that read with a fresh full
configuration. Older responses cannot lower the selected configuration revision, including responses
to local profile changes. A message, live status or app-context event that overtakes a pending settings
read replaces that request so the complete configuration can catch up. Settled settings do not refresh
on ordinary conversation activity. Once admission locks the profile/provider, older responses cannot
unlock them.

The session stores a copy of the selected profile. At the first admitted message it captures common
workflow instructions, common operator instructions and role instructions. The profile then remains
fixed, including after restart. Editing or deleting the source profile does not rewrite the stored
role, instructions or skill selection. Existing explicit model/reasoning controls remain available
between turns; the provider retains its existing started-session lock. Unavailable configured
providers/models are reported rather than silently replaced. A profile with a missing default
connection requires an available connection before execution.

Creation request replay returns the originally accepted conversation even after its profile is
deleted. Session ownership, workspace associations, retention, native resume and export cleanup keep
their existing contracts. Existing conversations without profile metadata retain their legacy
behavior. Planner-to-developer work uses separate conversations and existing workspace association.

## Administrator API

All routes use existing Harness authentication, same-origin mutation and administrator checks.
Session mutations additionally require the conversation owner. No provider-token public profile
protocol or new cross-application identity is introduced.

| Route | Input / result |
| --- | --- |
| `GET /api/profiles` | Directory revision, default ID, profile configurations and optional catalog-unavailable indication |
| `POST /api/profiles` | `{ profile, expectedRevision }`; creates a profile and returns the directory |
| `PUT /api/profiles/{id}` | `{ profile, expectedRevision }`; replaces configuration |
| `DELETE /api/profiles/{id}` | `{ expectedRevision }`; deletes configuration and clears its default if selected |
| `PUT /api/profiles/default` | `{ profileId, expectedRevision }`; null clears the default |
| `GET /api/connections/{id}/models` | Existing connection model/effort catalog |
| `POST /api/sessions` | Optional `profileId` and `profileRevision`; null explicitly selects no profile |
| `PUT /api/sessions/{id}/profile` | `{ profileId, profileRevision?, expectedRevision }`; applies before first dispatch |

Profile configuration rejects extra resource/authority fields. Profile responses use `no-store`.
Selecting a profile together with manual connection/skill overrides is rejected. Explicit legacy
manual connection/skill inputs without a profile bypass the profile default.

## Verification Evidence

Verified on macOS, 2026-10-26, for Harness 0.71.0 → 0.72.0:

- `npm run harness:test`: 1,712 tests in 158 files pass. The first run preceded the required static
  build; another run encountered a transient JSON-read failure in an existing question test.
  The focused gateway suite (63 tests) and final full run both pass without a code change for that failure.
- `npm run harness:lint` and `npm run harness:build-web`: pass. The preview also builds to its
  configured `HOSTY_HARNESS_WEB_OUTPUT=out` directory.
- `npm run test:integration -- worker`: passes with the manifest-matching Docker image, including
  real Claude/Codex native catalogs and Claude model/effort reset without submitting inference.
- A parent-managed source child Core uses separate data and normal password login. Core starts
  Harness in its supported Local runtime and Shell in its development runtime. Two distinct profiles
  pass through the real Harness API/worker with synthetic Codex transport, different models/efforts
  and skills. First-send locking, profile deletion and unchanged instructions/native session identity
  after Harness restart pass. Removing a library skill prunes editable profile selections while
  retaining the started session configuration. This checks configuration transport and recovery, not model judgment.
- Playwright through Shell verifies profile creation, connection/model/effort/skill controls, explicit
  default selection, a new chat adopting the default, switching to Developer, and fixed profile with
  model controls still available after a completed turn, deletion of the default, and keyboard focus
  returning to the form opener after cancellation. The form and narrower chat layout are
  inspected visually. Fixture file-change requests are denied; no live provider credentials are copied.
- The owned child is Finished through its parent, its data/resources are removed, and the parent
  Core and browser are stopped. The dirty development worktree is retained.
- A user-authorized live trial installs the Git code-review package, creates a Codex reviewer with
  GPT-6.1-Sol and High reasoning, selects it before the first message and verifies native SKILL.md
  reading through a one-time read approval. The reviewer identifies both known arithmetic regressions
  in an inline diff; the profile locks after dispatch. The trial exposes and verifies fixes for duplicate
  composer controls and profile notifications overtaking saved timestamps. Both regression tests fail
  before their fixes and pass afterwards; the final full run passes 1,714 tests in 158 files, with lint
  and the static build passing.
- The follow-up selection-race fix passes three deterministic cases: an older profile GET arriving
  before or after its replacement, and an older profile mutation response arriving after a newer model
  event. The browser trial opens one new conversation in two tabs, selects Reviewer in the first and
  GPT-6-Luna in the second, observes matching profile/model/High effort in both without reload, retains
  the draft, and receives TWO_TAB_OK after sending from the first tab. Both views show the response
  and the locked profile with no selection conflict. Network delay is forced in component tests, not
  in the live browser. That full run passes 1,717 tests in 158 files; lint and static build pass.
- Reviewer re-verification confirms the selection-revision fix and identifies a related pending-read
  race with a newer status event. Status and app-context regression cases reproduce the missing profile,
  then pass after pending reads are replaced. A delayed local save also preserves admission locks.
  The final page suite passes 57 tests; the full suite passes 1,720 tests in 158 files, with lint and the
  static build passing. The final browser build synchronizes model changes in both directions across
  the same two tabs, retains the draft and locked profile, and delivers TWO_TAB_FINAL_OK to both views.
  The same reviewer independently rechecks the current handlers and closes both P2 findings with no
  new actionable findings in the fix's scope. Content hashes confirm the reviewer changed no files.
- Version consistency, documentation/link validation and whitespace checks accompany the change.
  Core and CLI builds for the sandbox pass; Core reports four existing warnings, CLI none.

## Testing Expectations

- Preserve one-time initialization without an implicit default, empty collections, explicit defaults and persisted configurations;
  reject malformed storage, duplicate names, unsupported fields and stale concurrent writes.
- Include platform context with and without a profile, while retaining optional development-skill
  choices and showing the base package as included in every profile.
- Reconcile confirmed skill deletion without erasing choices during a catalog outage.
- Reject delayed profile snapshots and mutation responses after a newer model event; refresh the
  full configuration and preserve the draft and latest revision for the next send across two tabs.
- Refresh pending settings when a message, status or app-context event overtakes the read, retain
  newer lifecycle/context state and admission locks, and avoid reads once settings have settled.
- Keep one set of composer execution controls when creating or switching consecutive sessions, and
  apply profile notifications even when their timestamp follows the saved configuration timestamp.
- Validate connection/model/effort references and atomic pre-start switching; reject stale sends and
  profile changes after admission, including concurrent send/switch requests.
- Verify instruction snapshots, native resume and creation replay after profile deletion/restart;
  manual no-profile sessions must not inherit old global skill defaults.
- Enforce current administrator access and session ownership. Preserve drafts on save/discovery errors
  and keep profile lists visible when connection discovery fails.
- Build the static UI before the full Harness suite. Exercise normal Core login, Shell embedding and
  real profile controls in a Core-managed sandbox with separate data, then Finish it through its owner.

# Agent Instructions

## Versioning

Hosty uses semantic versioning `major.minor.patch`, applied per release artifact. See `docs/features/repository-release-model/feature.md` for the full policy. When a change ships in one of these components, bump its version in the same commit:

- **patch** - bug fix or small enhancement to existing functionality.
- **minor** - new functionality, or a large/breaking change (while the project is in `0.x`).
- **major** - reserved until `1.0`; then breaking changes (Core HTTP API, removed/renamed CLI command or flag).

Documentation-only changes (`docs/`, `README.md`, `AGENTS.md`) are the exception - merge them without a version bump. The same goes for Dependabot PRs: merge them as-is, without adding a version bump; the updated dependencies ship with the next versioned change.

Where the version lives:

- **Platform (`apps/core` + `apps/cli`)** share one version in the root `Directory.Build.props`. Bump it there; do not add `<Version>` to individual `.csproj` files.
- **`apps/shell`**, **`apps/marketplace`**, and **`apps/demo-app`** are first-party runtime apps: bump `version` in their respective `manifest.json` (the artifact source of truth) and keep their `package.json` in step. They version independently from the platform.
- **`apps/harness`** (Hosty Harness, including its web UI) continues the former Gateway release line. Bump `version` in `apps/harness/manifest.json`, `apps/harness/package.json` and `apps/harness/web/package.json` together. It versions independently from Core and Shell.
- **`apps/telemetry`** (collector + backend + `apps/telemetry-ui`) ships as one app: bump `version` in `apps/telemetry/manifest.json` and keep the first-party service image tags (`backend`, `ui`) and `apps/telemetry-ui/package.json` in step (`scripts/check-versions.mjs` enforces this). The collector is a third-party image and is exempt.
- **`apps/whisper`** is an independent local speech runtime app: bump `version` in `apps/whisper/manifest.json` and keep `<Version>` in `apps/whisper/Hosty.Whisper/Hosty.Whisper.csproj` in step. `scripts/check-versions.mjs` checks both.
- **`apps/shell-swift`** is the native Apple client, not a runtime app: it is installed on the operator's own device rather than on a host, so it has no `manifest.json`. Bump `MARKETING_VERSION` in `apps/shell-swift/Config/Version.xcconfig`. It versions independently from the platform and from `apps/shell`.
- **`apps/shell-cardputer`** is the native M5Stack Cardputer ADV firmware, not a runtime app. Bump its single version source in `apps/shell-cardputer/version.txt`; ESP-IDF reads that file as `PROJECT_VER`, and `scripts/check-versions.mjs` validates it. It versions independently from every other artifact.
- **SDK packages** (`packages/app-sdk` → npm `@hosty-sdk/app`, `packages/app-sdk-dotnet/HostySdk.App` → NuGet) version independently from the platform and from each other. Every non-documentation change to a package bumps its version in the same commit (patch/minor per the rules above): `version` in `packages/app-sdk/package.json`, `<Version>` in `HostySdk.App.csproj`. Merging to main publishes automatically — the publish workflows skip the run when the version is already in the registry — and dependent repositories pick releases up via Dependabot, or via a hand-written bump inside the PR that needs the new API.
- **Runtime app manifests** (including external apps like project-manager, media-server, torrent-engine) follow the hosty-app-skill rules in `skills/hosty-app-skill/references/app-manifest.md`. Do not bump `schemaVersion` for ordinary changes - it only tracks the manifest contract format.

## Pull Requests

- **Do not squash-merge PRs.** Parallel PRs are common here, and squash merges rewrite the merged branch's history — the other in-flight branches can no longer rebase cleanly onto main. Use a regular merge commit instead.
- **One PR per feature, not per phase.** When a feature plan is split into phases, implement all phases on one branch and open a single PR. Individual phases rarely deliver complete functionality on their own, and under the versioning rules above each per-phase PR would pointlessly bump the version.
- **PR descriptions track the plan.** When the work is driven by a `plan.md`, the
  description lists the deliverables this PR completes by ID (`D3`, `D5`) and
  links the feature folder. Always state the version outcome ("0.4.2 → 0.5.0" or "No version
  change — documentation-only").

## Documentation

Development is document-driven: every non-trivial change starts and ends in `docs/`.

### Layout

```text
docs/
├── root.md              — prose overview + generated status index
├── vision.md            — optional: the direction the project is built toward (living, no status)
├── features/
│   └── <feature-name>/  — kebab-case; the feature's stable, permanent home
│       ├── feature.md   — current reality only
│       └── plan.md      — remaining work only
└── reviews/             — dated review archives, outside the status workflow
```

- `docs/reviews/` holds point-in-time review reports, named
  `YYYY-MM-DD-<name>.md`. A review is an archive, not tracked work: it records
  what was true at its stated baseline commit, is never edited afterwards to
  follow the code, and stays outside the status workflow and the generated
  index. A finding becomes tracked work only once it is triaged into the
  relevant feature's `plan.md` as a deliverable — the review itself never
  carries status. A later review may supersede earlier ones: it re-verifies
  their findings against its own baseline and restates only what is still
  open; the superseded archives are deleted in the same PR (git history keeps
  their full text), so the folder holds only reviews whose findings are still
  current.
- `docs/vision.md`, where a repository has one, holds the direction the project
  is built toward: the thesis, dated owner decisions, open strategic questions,
  and links to the features it spans. It is a living document — edited whenever
  the direction changes, with `created` / `updated` frontmatter and no `status`
  — and it sits outside the status workflow and the generated index, like
  `docs/reviews/`. It authorizes no implementation and owns no deliverables:
  work it names is tracked in the owning feature's `plan.md`. Feature and plan
  documents may cite its decisions by number and date.
- A feature folder holds only `feature.md` and `plan.md`; images and other
  non-Markdown assets may sit beside them.
- Beyond that there are no other documentation folders. A large or cross-cutting
  feature is an ordinary feature whose docs cross-link the features it spans;
  its `plan.md` never duplicates their deliverables — it links to them and keeps
  only the work that belongs to the umbrella itself.
- Two top-level files belong to other tooling and are not workflow documents:
  `docs/store.md` (the Marketplace store page) and `docs/agent.md` (the app's
  agent skill file). Any other Markdown under `docs/` — flat
  `docs/features/*.md`, `docs/ideas/`, `docs/planning/` — is rejected by the
  validator.

### Frontmatter

Every `feature.md`, `plan.md` and `vision.md` starts at its first line with a
frontmatter block, followed by the `# Title` heading:

```markdown
---
status: In Progress
created: 2026-09-24
updated: 2026-10-05
summary: One plain-text sentence saying what this document covers.
components: [apps/core, apps/shell]
---

# Title
```

- `status` — `plan.md` only, and required there; one of the statuses below.
- `created` / `updated` — required, `YYYY-MM-DD`.
- `summary` — required in `feature.md` and `plan.md`: one plain-text sentence of
  at most 200 characters, without Markdown. The index and other tools show it.
- `components` — optional in `feature.md` and `plan.md`: the
  repository-relative directories the document concerns. Each must exist. Omit
  it when the document concerns the whole repository.
- `vision.md` carries only `created` and `updated`.

The block is a strict subset of YAML: one `key: value` per line, plain values or
`[a, b]` lists, no nesting, comments or multi-line values. Wrap a value that
contains `: ` or starts with a YAML indicator character in double quotes.
Unknown keys are rejected. The H1 is the title; there is no `title` key.

### feature.md — reality

- Describes current behavior only: present tense, verifiable against the code.
  Words like "will", "planned", or "future" do not belong here — that content
  goes to `plan.md`.
- Created in the PR that first ships behavior, never earlier. When
  implementation diverges from the plan, this file follows the code.
- Its frontmatter has no `status`. It ends with a `## Testing Expectations`
  section for required coverage.

### plan.md — intent

- The single artifact for unbuilt work, from first idea to last deliverable:
  goal, target behavior (written as a diff against `feature.md` when the
  feature already exists), deliverables checklist, phases, open questions,
  verification steps.
- Its frontmatter `status` is one of:
  - **Draft** — being shaped; open questions allowed.
  - **On Hold** — deliberately parked.
  - **Ready** — no open questions left; set only after explicit user approval
    in chat, never on the agent's own judgment.
  - **In Progress** — implementation started.
  - **Blocked** — cannot proceed; the blocker is recorded in the document.
- Every plan has exactly one `## Deliverables` section with at least one
  deliverable; it may contain `###` subsections such as phases, and
  deliverables are the only checkboxes in a plan. Each
  is a top-level item that starts with a stable ID: `- [ ] D3. Text`. IDs are
  never renumbered or reused: a new deliverable takes the next free number, and
  a removed deliverable's ID stays retired. Use plain bullets, not nested
  checkboxes, for detail.
- Never implement a plan that is not Ready. A plan the user abandons is deleted
  (git history preserves it) — there is no Rejected status.
- Trivial work (bug fixes, small refactors, doc edits) needs no `plan.md`:
  ship it and update `feature.md` in the same PR. If mid-work the change turns
  out to be larger than expected, stop and write the plan.

### Status discipline

Statuses and checkboxes change in the same commit as the work they describe:

- the first implementation commit sets `status: In Progress`;
- the commit that completes a deliverable checks it off;
- the PR that completes the last deliverable also updates `feature.md`, deletes
  `plan.md`, and regenerates the index — completion is never deferred to a
  later PR, and scope is never silently narrowed to force completion.

Unfinished work exists only as unchecked deliverables — never hidden in notes,
"future work" sections, or follow-up remarks. Bump `updated` on every
meaningful change to a document.

### Index and validation

`docs/root.md` holds the prose overview plus a generated index that lists every
feature folder with its summary and, for a plan, its status, deliverable
progress and `updated` date. `node scripts/docs-index.mjs --fix` rewrites the
block between the `docs-index` markers and converts old `Status:` / `Created:` /
`Updated:` header lines into frontmatter. `--check` is the CI mode: it also
validates frontmatter, deliverable IDs and relative links. Never edit the
generated block by hand; run `--fix` after changing any document.

`scripts/docs-index.mjs` is shared by every Hosty repository. The canonical copy
lives in docker-host and the others carry a byte-identical copy, so change it
there first.

## Core Development Feedback Loop

- Identify the intended data root and factual launch mode/project before changing its lifecycle. See [Core development mode](docs/features/core-dev-target/feature.md).
- Finish a coherent batch of edits, successfully build the exact target Core project after the last edit, and run affected tests before restarting. Use a separate artifacts/output directory if an IDE-launched Core still executes the normal build output. A later code edit invalidates the build check.
- CLI `core start/restart --project <absolute-csproj>` prepares an isolated Debug generation before stopping Core, then launches the prepared apphost without rebuilding. A compilation error preserves the active Core and returns .NET diagnostics and a log path. There is no watch/hot reload.
- Always repeat `--project` on CLI source restarts. Without it, Start/Restart select the installed release. Shell and authorized direct Core MCP Restart preserve the factual live target and apply pending Source changes explicitly:
  ```bash
  hosty --data-root <instance-root> core restart --keep-apps --project <absolute-core-csproj-path>
  hosty --data-root <instance-root> core status
  ```
- Verify a new process-start identity, expected mode/project, readiness and changed behavior. A successful build, accepted restart operation or changed worktree does not prove that the replacement started. Diagnose `core logs` and retained operation/build logs; do not silently switch to release.
- `restart_core` requires a direct `hosty:core` grant with `mcp:read` and `mcp:core-restart`, or an administrator session. Call `get_core_development`, supply its instance/source revision and a fresh 32-hex UUID, then reconnect and query `get_core_operation` with that same ID. Never replace an uncertain request with a fresh ID. Gateway's delegated/facade connection does not gain mutation authority; use the authorized local CLI or an explicitly granted direct connection.
- `--keep-apps` preserves and adopts verified live local services as well as eligible Docker containers. Independent runners retain their process tree and console logs. Legacy services still using Core-owned pipes need an explicit app restart to gain the new runner; do not force that migration during active work.
- Managed generation cleanup is automatic. Do not delete active/prepared/previous output or runner-referenced generations manually; age and health are not ownership evidence. Leave source, operator output, data and logs untouched.
- Runtime app edits use the app's own build/lifecycle workflow. Restart Core to apply Core changes, not merely because Core manages the app.

## Hosty Runtime App Development

- Core uses normal email/password authentication even in Development. Never add or rely on a
  user-selector login, unauthenticated session-creation endpoint, seeded administrator or default
  password. For browser QA, use a separate data root and normal setup/recovery followed by password
  login; always include its `--data-root` in CLI setup/recovery commands. Existing passwordless dev
  accounts need explicit recovery. In-process tests may seed only their isolated test stores; do not
  use such sessions as evidence that browser login works.
- Do not validate Hosty identity, Shell embedding, app assignments, or scoped directory behavior by running an app only in standalone mode.
- Use Core-managed runtime app lifecycle for local app work that depends on Hosty identity. Install the app manifest with the local/source runtime profile, then start it through Core:
  ```bash
  hosty core start
  hosty apps install apps/demo-app/manifest.json --runtime dev
  hosty apps start com.haas.demo-app
  ```
- If Core is already running from another terminal or debugger, use normal `hosty apps ...` commands against that Core process instead of starting another Core process.
- For direct API probes against the local app origin, request a real Hosty-signed app identity token through Core:
  ```bash
  TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
  curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
  ```
- Treat `hosty apps identity` as a diagnostic helper for direct endpoint probes only. Gateway and Shell integration still need to be checked through Core/Shell URLs and `hosty apps open`.

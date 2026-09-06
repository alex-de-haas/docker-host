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
- **`apps/telemetry`** (collector + backend + `apps/telemetry-ui`) ships as one app: bump `version` in `apps/telemetry/manifest.json` and keep the first-party service image tags (`backend`, `ui`) and `apps/telemetry-ui/package.json` in step (`scripts/check-versions.mjs` enforces this). The collector is a third-party image and is exempt.
- **`apps/shell-swift`** is the native Apple client, not a runtime app: it is installed on the operator's own device rather than on a host, so it has no `manifest.json`. Bump `MARKETING_VERSION` in `apps/shell-swift/Config/Version.xcconfig`. It versions independently from the platform and from `apps/shell`.
- **`apps/shell-cardputer`** is the native M5Stack Cardputer ADV firmware, not a runtime app. Bump its single version source in `apps/shell-cardputer/version.txt`; ESP-IDF reads that file as `PROJECT_VER`, and `scripts/check-versions.mjs` validates it. It versions independently from every other artifact.
- **SDK packages** (`packages/app-sdk` → npm `@hosty-sdk/app`, `packages/app-sdk-dotnet/HostySdk.App` → NuGet) version independently from the platform and from each other. Every non-documentation change to a package bumps its version in the same commit (patch/minor per the rules above): `version` in `packages/app-sdk/package.json`, `<Version>` in `HostySdk.App.csproj`. Merging to main publishes automatically — the publish workflows skip the run when the version is already in the registry — and dependent repositories pick releases up via Dependabot, or via a hand-written bump inside the PR that needs the new API.
- **Runtime app manifests** (including external apps like project-manager, media-server, torrent-engine) follow the hosty-app-skill rules in `skills/hosty-app-skill/references/app-manifest.md`. Do not bump `schemaVersion` for ordinary changes - it only tracks the manifest contract format.

## Pull Requests

- **Do not squash-merge PRs.** Parallel PRs are common here, and squash merges rewrite the merged branch's history — the other in-flight branches can no longer rebase cleanly onto main. Use a regular merge commit instead.
- **One PR per feature, not per phase.** When a feature plan is split into phases, implement all phases on one branch and open a single PR. Individual phases rarely deliver complete functionality on their own, and under the versioning rules above each per-phase PR would pointlessly bump the version.
- **PR descriptions track the plan.** When the work is driven by a `plan.md`, the
  description lists the deliverables this PR completes and links the feature
  folder. Always state the version outcome ("0.4.2 → 0.5.0" or "No version
  change — documentation-only").

## Documentation

Development is document-driven: every non-trivial change starts and ends in `docs/`.

### Layout

```text
docs/
├── root.md              — prose overview + generated status index
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
- Beyond that there are no other documentation folders. A large or cross-cutting
  feature is an ordinary feature whose docs cross-link the features it spans;
  its `plan.md` never duplicates their deliverables — it links to them and keeps
  only the work that belongs to the umbrella itself.
- Migration is lazy: legacy flat docs (`docs/features/*.md`, `docs/ideas/`,
  `docs/planning/`) move into feature folders with `git mv` whenever work
  touches them; never in bulk.

### feature.md — reality

- Describes current behavior only: present tense, verifiable against the code.
  Words like "will", "planned", or "future" do not belong here — that content
  goes to `plan.md`.
- Created in the PR that first ships behavior, never earlier. When
  implementation diverges from the plan, this file follows the code.
- Starts with `Created:` / `Updated:` lines (no `Status:`), ends with a
  `## Testing Expectations` section for required coverage.

### plan.md — intent

- The single artifact for unbuilt work, from first idea to last deliverable:
  goal, target behavior (written as a diff against `feature.md` when the
  feature already exists), deliverables checklist, phases, open questions,
  verification steps.
- Starts with `Status:` / `Created:` / `Updated:`. Statuses:
  - **Draft** — being shaped; open questions allowed.
  - **On Hold** — deliberately parked.
  - **Ready** — no open questions left; set only after explicit user approval
    in chat, never on the agent's own judgment.
  - **In Progress** — implementation started.
  - **Blocked** — cannot proceed; the blocker is recorded in the document.
- Never implement a plan that is not Ready. A plan the user abandons is deleted
  (git history preserves it) — there is no Rejected status.
- Trivial work (bug fixes, small refactors, doc edits) needs no `plan.md`:
  ship it and update `feature.md` in the same PR. If mid-work the change turns
  out to be larger than expected, stop and write the plan.

### Status discipline

Statuses and checkboxes change in the same commit as the work they describe:

- the first implementation commit sets `Status: In Progress`;
- the commit that completes a deliverable checks it off;
- the PR that completes the last deliverable also updates `feature.md`, deletes
  `plan.md`, and regenerates the index — completion is never deferred to a
  later PR, and scope is never silently narrowed to force completion.

Unfinished work exists only as unchecked deliverables — never hidden in notes,
"future work" sections, or follow-up remarks. Bump `Updated:` on every
meaningful change to a document.

### Index

`docs/root.md` holds the prose overview plus a generated per-feature status
index. `node scripts/docs-index.mjs --fix` rewrites the block between the
`docs-index` markers (and validates headers); `--check` is the CI mode. Never
edit the generated block by hand; regenerate it in any change that adds,
renames, deletes, or changes the status of a doc.

## Hosty Runtime App Development

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

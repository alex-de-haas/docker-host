---
status: In Progress
created: 2026-10-05
updated: 2026-10-05
summary: Structured frontmatter, deliverable IDs and a shared validator for workflow docs, plus migration of every legacy document.
components: [scripts, docs]
---

# Documentation Workflow — Structured Metadata And Legacy Migration

## Goal

Make every workflow document machine-readable without giving up Markdown in Git. Today a document's
metadata is a set of prose lines (`Status:`, `Created:`, `Updated:`) that one regex-based script
reads. Deliverables are untagged checkboxes. Each repository carries its own copy of the rules and
the validator, and those copies have drifted. A further 52 documents across six repositories still
use legacy layouts that no tool can classify.

The direct consumer is a planned plan-tracking app, which reads plans across all repositories and
shows status, dates, progress and the sessions working on them. That app is a non-goal here: this
plan defines the format it reads, migrates every existing document to it, and stops there.

## Owner Direction (2026-10-05)

- Markdown in Git remains the single source of truth for features and plans. External trackers
  and a separate plan database were considered and rejected: plan changes must stay in the same
  commit and pull request as the code they describe, and agents must read and write them as
  ordinary files.
- YAML frontmatter replaces the prose header lines.
- The writing rules live in each repository's `AGENTS.md`.
- All existing documents migrate now, legacy layouts included. This supersedes the rule in
  `AGENTS.md` that legacy documents migrate lazily and never in bulk.
- Approved for implementation on 2026-10-05, with these answers to the Draft's open questions:
  deliverable IDs are introduced now, while every plan is touched anyway; `components` holds
  repository-relative directories, not app ids; `docs/reviews/` stays unchanged.

## Target Format

### Frontmatter

Every `feature.md`, `plan.md` and `vision.md` starts at line 1 with a frontmatter block, followed
by the H1 title. The H1 stays the only title; there is no `title` key.

```markdown
---
status: In Progress
created: 2026-09-24
updated: 2026-10-05
summary: Assistant sessions that own a conversation, its source workspaces and pull requests.
components: [apps/harness, apps/core]
---

# Shared Assistant Development Sessions
```

The block is a strict subset of YAML: one `key: value` per line, scalar values or flow lists
(`[a, b]`), no nesting, multi-line values, anchors or comments. Any YAML parser (Obsidian, the
plan-tracking app) reads it. The validator stays dependency-free and rejects anything outside the
subset.

| Key | `plan.md` | `feature.md` | `vision.md` | Rule |
| --- | --- | --- | --- | --- |
| `status` | required | forbidden | forbidden | `Draft`, `On Hold`, `Ready`, `In Progress` or `Blocked` |
| `created` | required | required | required | `YYYY-MM-DD` |
| `updated` | required | required | required | `YYYY-MM-DD`, not earlier than `created` |
| `summary` | required | required | — | One plain-text sentence, no Markdown, at most 200 characters |
| `components` | optional | optional | — | Repository-relative directories the document concerns; each must exist |

Unknown keys are rejected so a typo cannot silently drop a field. There is no `related` key: links
in the body already express relations, and tools derive the graph from them.

`components` holds directories such as `apps/core` or `packages/app-sdk`, not app ids. The
validator can check that a directory exists, and a tool maps a component to an installed app
through the `manifest.json` it contains. Single-app repositories normally omit the key.

### Deliverable IDs

Every checkbox in a `plan.md` sits under one `## Deliverables` section, which may contain
`###` subsections such as phases. Each checkbox starts with a stable ID:

```markdown
- [x] D1. Validator reads frontmatter.
- [ ] D2. Generated index shows deliverable progress.
```

IDs are unique within the plan and are never renumbered or reused. A new deliverable takes the
next free number, and a removed deliverable's ID stays retired. PR descriptions name the IDs they
complete. Checkboxes elsewhere in a plan are rejected.

### Generated Index

The `docs/root.md` index block lists each feature with its summary, plan status, deliverable
progress (`3/7`) and `updated` date. In docker-host it replaces the hand-maintained
"Current Feature Documents", "Planning" and "Ideas" lists, which duplicate the index and drift from
it. The overview prose stays hand-written.

### Validator

`scripts/docs-index.mjs` in docker-host is the canonical copy. The other repositories carry a
byte-identical copy whose header comment names its origin. In addition to the existing checks
(header validity, index freshness, NUL bytes), it verifies:

- the frontmatter subset and the per-document schema above;
- deliverable ID format and uniqueness, and checkbox placement;
- that relative Markdown links inside `docs/` resolve;
- that no document remains in a legacy location (flat `docs/features/*.md`, `docs/ideas/`,
  `docs/planning/`).

Top-level files that belong to other tooling are allowed and not validated: `store.md` (the
Marketplace store page, see [manifest-level app assets](../manifest-level-app-assets.md)) and
`agent.md` (an app-provided agent skill file). `--fix` upgrades legacy header lines in a
new-style document to frontmatter. An in-flight branch that adds or edits documents in the old
style therefore converts with one command after rebasing.

### Instructions

Each repository's `AGENTS.md` Documentation section is rewritten for the new format. The text is
identical across repositories; only the sections outside Documentation stay repository-specific.
No separate skill is added. The rules apply to every change, so they belong in instructions that
every agent always loads. A skill loads only when its description matches the task. CI enforces
the schema through the validator.

`docs/reviews/` is unchanged: reviews are dated archives outside the status workflow and the
index, and `AGENTS.md` forbids editing them afterwards.

## Legacy Migration

Each legacy document gets exactly one disposition:

1. **Merge** into an existing feature folder's `feature.md` or `plan.md`.
2. **New feature folder.** Shipped behavior becomes `feature.md`, verified against the code; an
   old `Status: Implemented` line is a claim, not evidence. Unbuilt intent that is still wanted
   becomes a `plan.md` in Draft.
3. **Delete** as superseded or retired. Git history keeps the text.

Abandoning intent is the owner's decision, so the disposition table for each repository is
approved by the owner before anything moves. Documents of the "future work" kind are split: each
item becomes a deliverable in its owning plan or is dropped. No such document remains.

Moves break references outside `docs/`: `AGENTS.md`, the shipped `skills/hosty-app-skill`
references, and code comments in Core and Shell point at legacy paths. Every inbound reference is
updated in the same change.

Inventory at the 2026-10-05 baseline:

| Repository | New-style documents | Legacy documents |
| --- | --- | --- |
| docker-host | 46 plans, 81 features, `vision.md` | 16 flat, 15 ideas, 2 planning |
| project-manager | 1 plan, 5 features | 5 flat, 1 idea |
| media-server | 11 plans, 47 features | 4 flat, 3 ideas |
| torrent-engine | 2 plans, 10 features | 1 flat |
| transcode-engine | 1 plan, 14 features | 1 flat |
| solitaire | none; it has no workflow, validator or CI check | 1 flat, 2 ideas, 1 planning |

`hosty-catalog` has no `docs/` and is out of scope.

## Deliverables

### Phase 1 — Format and tooling (docker-host)

- [ ] D1. Validator v2 in `scripts/docs-index.mjs`, as specified under Target Format, including
      `--fix` header upgrade, link resolution, legacy-location rejection and the non-workflow
      allowlist.
- [x] D2. Validator tests (`node:test` fixtures for every rejection and for the header upgrade),
      run in CI.
- [x] D3. Generated index with summary, status, progress and `updated`. The hand-maintained lists
      in `docs/root.md` are removed.
- [x] D4. Every new-style document in docker-host converted: frontmatter, written summaries,
      `components` where a document concerns specific directories, deliverable IDs, and the three
      plans whose checkboxes sit outside a Deliverables section restructured.
- [x] D5. `AGENTS.md` Documentation section rewritten as the canonical cross-repository text; the
      lazy-migration rule is removed.

### Phase 2 — Legacy triage (docker-host)

- [ ] D6. Disposition table for the 33 legacy documents, approved by the owner.
- [ ] D7. Approved dispositions executed, inbound references updated repository-wide, and
      `docs/ideas/` and `docs/planning/` removed.

### Phase 3 — Other repositories (one pull request each)

- [ ] D8. project-manager: validator copy, `AGENTS.md`, conversion, and owner-approved triage of
      its legacy documents.
- [ ] D9. media-server: the same.
- [ ] D10. torrent-engine: the same.
- [ ] D11. transcode-engine: the same.
- [ ] D12. solitaire: adopts the workflow (Documentation section, validator, CI check,
      `docs/root.md` index) and triages its legacy documents.

### Phase 4 — Completion

- [ ] D13. `feature.md` in this folder describes the format and validator, this plan is deleted,
      and the index is regenerated. The docker-host pull request merges after the other
      repositories' pull requests, so completion lands in it.

## Versioning

No version changes. Every repository changes only documentation and repository tooling that no
release artifact ships.

## Interactions

- **`AGENTS.md`, Layout:** the "migration is lazy, never in bulk" rule is superseded by the owner
  direction above and removed in D5.
- **In-flight branches:** branches open during the conversion still carry old headers. `--fix`
  converts them after rebasing, which docker-host's strict up-to-date rule on `main` requires anyway.
- **Drifted copies:** the Documentation sections of project-manager, media-server, torrent-engine
  and transcode-engine already differ from docker-host's, by 39 to 47 changed lines each. D5's
  canonical text and D8–D12 remove that drift.
- **Plan-tracking app:** reads this format through any YAML parser and maps `components` to apps.
  It owns no deliverables here.

## Verification

- `node scripts/docs-index.mjs --check` and the validator tests pass in every repository;
  docker-host CI runs both.
- Parse every frontmatter block once with a standard YAML parser and compare the result with the
  validator's reading.
- No file remains in a legacy location, and no relative link inside `docs/` is broken.
- A repository-wide search finds no reference to a moved or deleted document path.
- Spot-check converted summaries and `components` against their documents.

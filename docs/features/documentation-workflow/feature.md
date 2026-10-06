---
created: 2026-10-05
updated: 2026-10-05
summary: Workflow documents carry YAML frontmatter and stable deliverable IDs, checked by one validator shared by every Hosty repository.
components: [scripts, docs]
---

# Documentation Workflow

Features and plans live as Markdown in Git, next to the code they describe, and change in the same
commit and pull request. Their metadata is structured so tools can read it without parsing prose:
the generated index in `docs/root.md` and any YAML-aware viewer read the same frontmatter. The
writing rules are in the Documentation section of [AGENTS.md](../../../AGENTS.md); this document
describes the tooling that enforces them.

## Repositories

docker-host, project-manager, media-server, torrent-engine, transcode-engine and solitaire follow
the workflow. Each carries the same Documentation section in its `AGENTS.md` and a byte-identical
copy of `scripts/docs-index.mjs`; the canonical copy lives here, so a change lands in docker-host
first and is then copied. CI runs `node scripts/docs-index.mjs --check` in every repository.
`hosty-catalog` has no `docs/`.

## Document Format

- `docs/features/<name>/feature.md` describes current behavior and `plan.md` the remaining work;
  `docs/vision.md` (optional) and the `docs/reviews/` archive sit outside the status workflow.
- `feature.md`, `plan.md` and `vision.md` start with a frontmatter block: `status` (plans only:
  Draft, On Hold, Ready, In Progress, Blocked), `created`, `updated`, a one-sentence plain-text
  `summary` of at most 200 characters (features and plans), and optional `components` — the
  repository-relative directories a document concerns.
- The block is a strict subset of YAML: one `key: value` per line, plain scalars, double-quoted
  strings with only `\"` and `\\` escapes, and `[a, b]` lists. A standard YAML parser reads every
  block exactly as the validator does.
- Every plan has exactly one `## Deliverables` section with at least one deliverable. Its
  deliverables are the only checkboxes in the plan, all top-level items, each starting with a stable
  ID such as `- [ ] D3. Text`.
- Every `feature.md` ends with a `## Testing Expectations` section.

## Validator

`scripts/docs-index.mjs` has three modes: print (the index block and any errors), `--fix` (convert
legacy `Status:` / `Created:` / `Updated:` header lines into frontmatter, then rewrite the index
block) and `--check` (exit 1 on any error or a stale index). It reports:

- missing, unknown, duplicated or malformed frontmatter keys; an invalid status, date or component;
  `updated` earlier than `created`; header lines left beside frontmatter;
- a summary that is longer than 200 characters, contains Markdown or inline HTML, or has more than
  one sentence;
- a missing `# Title` heading after the frontmatter, and a `feature.md` that does not end with
  `## Testing Expectations`;
- a feature folder name that is not kebab-case, and a review not named `YYYY-MM-DD-<name>.md`;
- a plan without a `## Deliverables` section, with a second one or with no deliverable in it,
  checkboxes outside it, nested checkboxes, and deliverables without an ID or with a duplicate ID;
- relative links inside workflow documents and `docs/root.md` that do not resolve, and absolute
  links;
- Markdown in any other location under `docs/` — a flat `docs/features/*.md`, any Markdown in a
  feature folder besides `feature.md` and `plan.md`, `docs/ideas/`, `docs/planning/` or an unknown
  top-level file — except `store.md` and `agent.md`, which belong to other tooling;
- NUL bytes.

Checkboxes and links inside code spans and fenced code blocks are ignored. As in CommonMark, a fence
closes only on a bare run of the same character at least as long as the one that opened it, so a
four-backtick fence can show a three-backtick example.

## Generated Index

The block between the `docs-index` markers in `docs/root.md` lists every feature folder with its
title, summary and, for a plan, its status, deliverable progress (`done/total`) and `updated`
date, preceded by a count of plans per status. It replaces hand-maintained document lists; the
rest of `root.md` stays hand-written prose.

## Testing Expectations

- `node --test scripts/docs-index.test.mjs` covers every rejection, the header upgrade, the index
  content and the allowed tooling files; docker-host CI runs it before the index check.
- `node scripts/docs-index.mjs --check` passes in every repository that follows the workflow, and
  each repository's copy of the script is byte-identical to docker-host's.
- A change to the format updates `AGENTS.md`, the validator, its tests and this document together.

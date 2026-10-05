// Tests for scripts/docs-index.mjs. Each case builds a throwaway repository with a copy of the script,
// because the script resolves the repository from its own location.
//
//   node --test scripts/docs-index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "docs-index.mjs");

const ROOT = "# Documentation\n\n<!-- docs-index:begin -->\n<!-- docs-index:end -->\n";

const feature = (extra = "", body = "") =>
  `---\ncreated: 2026-01-01\nupdated: 2026-01-02\nsummary: A feature.\n${extra}---\n\n# Feature\n\nText.\n${body}`;

const plan = (deliverables = "- [ ] D1. Do it.\n", extra = "", status = "Draft") =>
  `---\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-02\nsummary: A plan.\n${extra}---\n\n# Plan\n\n## Deliverables\n\n${deliverables}`;

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "docs-index-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts", "docs-index.mjs"));
  for (const [path, content] of Object.entries({ "docs/root.md": ROOT, ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    if (content !== null) writeFileSync(join(dir, path), content);
  }
  const run = (flag) => {
    const result = spawnSync(process.execPath, ["scripts/docs-index.mjs", flag], { cwd: dir, encoding: "utf8" });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const read = (path) => readFileSync(join(dir, path), "utf8");
  return { dir, run, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// Runs --fix (which regenerates the index) and returns the --check result.
function check(files) {
  const r = repo(files);
  try {
    r.run("--fix");
    return { ...r.run("--check"), read: r.read };
  } finally {
    r.done();
  }
}

function assertError(files, pattern) {
  const result = check(files);
  assert.equal(result.code, 1, `expected a failure matching ${pattern}`);
  assert.match(result.err, pattern);
}

test("a valid repository passes and the index carries summary, status and progress", () => {
  const r = repo({
    "docs/features/alpha/feature.md": feature("components: [docs]\n"),
    "docs/features/alpha/plan.md": plan("- [x] D1. Done.\n- [ ] D2. Open.\n", "", "In Progress"),
    "docs/features/beta/plan.md": plan(),
    "docs/vision.md": "---\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Vision\n",
  });
  try {
    assert.equal(r.run("--fix").code, 0);
    assert.equal(r.run("--check").code, 0);
    const root = r.read("docs/root.md");
    assert.match(root, /Plans: 1 In Progress · 1 Draft\./);
    assert.match(root, /- \[Feature\]\(features\/alpha\/feature\.md\) — A feature\. · \[plan\]\(features\/alpha\/plan\.md\): In Progress, 1\/2, updated 2026-01-02/);
    assert.match(root, /- \[Plan\]\(features\/beta\/plan\.md\) — A plan\. · Draft, 0\/1, updated 2026-01-02/);
  } finally {
    r.done();
  }
});

test("a stale index fails --check", () => {
  const r = repo({ "docs/features/alpha/feature.md": feature() });
  try {
    const result = r.run("--check");
    assert.equal(result.code, 1);
    assert.match(result.err, /index block is stale/);
  } finally {
    r.done();
  }
});

test("--fix moves legacy header lines into frontmatter", () => {
  const r = repo({
    "docs/features/alpha/plan.md": "# Plan\n\nStatus: Ready\nCreated: 2026-01-01\nUpdated: 2026-01-03\n\n## Deliverables\n\n- [ ] D1. Do it.\n",
  });
  try {
    r.run("--fix");
    assert.equal(
      r.read("docs/features/alpha/plan.md"),
      "---\nstatus: Ready\ncreated: 2026-01-01\nupdated: 2026-01-03\n---\n\n# Plan\n\n## Deliverables\n\n- [ ] D1. Do it.\n",
    );
    const result = r.run("--check");
    assert.equal(result.code, 1);
    assert.match(result.err, /missing frontmatter key "summary"/);
  } finally {
    r.done();
  }
});

test("a document without frontmatter is rejected", () => {
  assertError({ "docs/features/alpha/feature.md": "# Feature\n" }, /alpha\/feature\.md: missing frontmatter/);
});

test("header lines alongside frontmatter are rejected", () => {
  assertError({ "docs/features/alpha/feature.md": feature("", "Updated: 2026-01-05\n") }, /header lines alongside frontmatter/);
});

test("frontmatter schema", async (t) => {
  await t.test("unknown key", () => assertError({ "docs/features/a/feature.md": feature("owner: me\n") }, /unknown frontmatter key "owner"/));
  await t.test("status on a feature", () =>
    assertError({ "docs/features/a/feature.md": feature("status: Draft\n") }, /feature\.md must not carry status/));
  await t.test("missing status on a plan", () =>
    assertError({ "docs/features/a/plan.md": plan().replace("status: Draft\n", "") }, /missing frontmatter key "status"/));
  await t.test("unknown status", () => assertError({ "docs/features/a/plan.md": plan(undefined, "", "Done") }, /status "Done" is not one of/));
  await t.test("bad date", () =>
    assertError({ "docs/features/a/feature.md": feature().replace("2026-01-02", "2026-02-30") }, /updated: "2026-02-30" is not a YYYY-MM-DD date/));
  await t.test("updated before created", () =>
    assertError({ "docs/features/a/feature.md": feature().replace("2026-01-02", "2025-12-31") }, /is earlier than created/));
  await t.test("duplicate key", () => assertError({ "docs/features/a/feature.md": feature("summary: Again.\n") }, /duplicate key "summary"/));
  await t.test("nested value", () => assertError({ "docs/features/a/feature.md": feature("components:\n  - docs\n") }, /is not "key: value"/));
  await t.test("summary too long", () =>
    assertError({ "docs/features/a/feature.md": feature().replace("A feature.", "x".repeat(201)) }, /summary is 201 characters/));
  await t.test("markdown in summary", () =>
    assertError({ "docs/features/a/feature.md": feature().replace("A feature.", "Uses `code` here.") }, /summary must be plain text/));
  await t.test("unquoted colon in summary", () =>
    assertError({ "docs/features/a/feature.md": feature().replace("A feature.", "Core API: endpoints") }, /wrap it in double quotes/));
  await t.test("quoted colon in summary is fine", () => {
    assert.equal(check({ "docs/features/a/feature.md": feature().replace("A feature.", '"Core API: endpoints"') }).code, 0);
  });
  await t.test("missing component directory", () =>
    assertError({ "docs/features/a/feature.md": feature("components: [apps/nowhere]\n") }, /component "apps\/nowhere" is not a directory/));
  await t.test("component outside the repository", () =>
    assertError({ "docs/features/a/feature.md": feature("components: [../docs]\n") }, /is not a repository-relative directory/));
  await t.test("empty list", () => assertError({ "docs/features/a/feature.md": feature("components: []\n") }, /empty list/));
});

test("deliverables", async (t) => {
  await t.test("missing ID names the rule", () => assertError({ "docs/features/a/plan.md": plan("- [ ] Do it.\n") }, /deliverable without an ID/));
  await t.test("duplicate ID", () =>
    assertError({ "docs/features/a/plan.md": plan("- [ ] D1. One.\n- [ ] D1. Two.\n") }, /duplicate deliverable ID D1/));
  await t.test("checkbox outside Deliverables", () =>
    assertError({ "docs/features/a/plan.md": plan().replace("## Deliverables", "## Phases\n\n- [ ] D9. Elsewhere.\n\n## Deliverables") }, /checkbox outside "## Deliverables"/));
  await t.test("nested checkbox", () => assertError({ "docs/features/a/plan.md": plan("- [ ] D1. Parent.\n  - [ ] Child.\n") }, /nested checkbox/));
  await t.test("second Deliverables section", () =>
    assertError({ "docs/features/a/plan.md": plan("- [ ] D1. One.\n\n## Deliverables\n\n- [ ] D2. Two.\n") }, /one "## Deliverables" section/));
  await t.test("subsections and code fences are fine", () => {
    const deliverables = "### Phase 1\n\n- [ ] D1. One.\n\n```markdown\n- [ ] Example only.\n```\n\n### Phase 2\n\n- [x] D3. Three.\n";
    assert.equal(check({ "docs/features/a/plan.md": plan(deliverables) }).code, 0);
  });
});

test("links", async (t) => {
  await t.test("broken relative link", () =>
    assertError({ "docs/features/a/feature.md": feature("", "See [b](../b/feature.md).\n") }, /broken link "\.\.\/b\/feature\.md"/));
  await t.test("absolute link", () =>
    assertError({ "docs/features/a/feature.md": feature("", "See [b](/docs/root.md).\n") }, /is absolute/));
  await t.test("existing links, anchors, URLs and code are fine", () => {
    const body = "See [root](../../root.md#documents), [web](https://example.com), [here](#x) and `[x](missing.md)`.\n\n```\n[y](missing.md)\n```\n";
    assert.equal(check({ "docs/features/a/feature.md": feature("", body) }).code, 0);
  });
  await t.test("root.md prose links are checked", () =>
    assertError({ "docs/root.md": `# Documentation\n\n[gone](features/gone/feature.md)\n\n<!-- docs-index:begin -->\n<!-- docs-index:end -->\n` }, /root\.md:3: broken link/));
});

test("a NUL byte is reported", () => {
  assertError({ "docs/features/a/feature.md": feature("", "bad\u0000byte\n") }, /contains a NUL byte/);
});

test("a feature folder needs a document", () => {
  const r = repo({ "docs/features/empty/notes.txt": "x" });
  try {
    r.run("--fix");
    const result = r.run("--check");
    assert.equal(result.code, 1);
    assert.match(result.err, /contains neither feature\.md nor plan\.md/);
  } finally {
    r.done();
  }
});

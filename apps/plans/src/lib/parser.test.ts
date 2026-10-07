import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseSourceDocument } from "./parser";

const root = resolve(__dirname, "../../../..");
const validatorSource = readFileSync(join(root, "scripts/docs-index.mjs"), "utf8");
// Execute the actual validator's readDoc(), avoiding its unrelated index-writing CLI. This is
// deliberately source-backed: changed validator rules alter these verdicts without test mirrors.
function canonicalVerdict(repositoryRoot: string, path: string, kind: string): string[] {
  const errors: string[] = [];
  const functions = validatorSource.slice(validatorSource.indexOf("function checkPrintable"), validatorSource.indexOf("// Walk docs/ and build the index."));
  const schemas = { plan: { required: ["status", "created", "updated", "summary"], optional: ["components"] }, feature: { required: ["created", "updated", "summary"], optional: ["components"] }, vision: { required: ["created", "updated"], optional: [] } };
  const run = new Function("repoRoot", "errors", "rel", "existsSync", "readFileSync", "statSync", "writeFileSync", "join", "dirname", "mode", "PLAN_STATUSES", "SUMMARY_MAX", "SCHEMAS", `${functions}\nreturn readDoc;`);
  const readDoc = run(repositoryRoot, errors, (file: string) => file.slice(repositoryRoot.length + 1), existsSync, readFileSync, statSync, writeFileSync, join, dirname, "print", ["In Progress", "Ready", "Blocked", "Draft", "On Hold"], 200, schemas);
  readDoc(join(repositoryRoot, path), kind);
  return errors;
}
function appVerdict(repositoryRoot: string, path: string) {
  return parseSourceDocument(path, readFileSync(join(repositoryRoot, path), "utf8"), {
    componentExists: component => existsSync(join(repositoryRoot, component)) && statSync(join(repositoryRoot, component)).isDirectory(),
    linkExists: target => existsSync(join(repositoryRoot, target)),
  });
}
const plan = `---\nstatus: In Progress\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: A plan for the application.\ncomponents: [apps/core]\n---\n\n# Example Plan\n\n## Deliverables\n\n- [x] D1. First item\n- [ ] D3. Second item\n`;

describe("canonical documentation contract", () => {
  it("agrees with the real validator on every repository feature, plan and vision", () => {
    const paths = readdirSync(join(root, "docs/features")).flatMap(name => ["feature.md", "plan.md"].map(file => `docs/features/${name}/${file}`)).filter(path => existsSync(join(root, path)));
    if (existsSync(join(root, "docs/vision.md"))) paths.push("docs/vision.md");
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths) {
      const kind = path.endsWith("/plan.md") ? "plan" : path.endsWith("/feature.md") ? "feature" : "vision";
      const canonical = canonicalVerdict(root, path, kind);
      const parsed = appVerdict(root, path);
      expect(parsed.errors.length === 0, `${path}\napp: ${parsed.errors.join("; ")}\nvalidator: ${canonical.join("; ")}`).toBe(canonical.length === 0);
      if (parsed.created) expect(typeof parsed.created).toBe("string");
      if (parsed.updated) expect(typeof parsed.updated).toBe("string");
    }
  });
  it("agrees on invalid documents and fenced, quoted and nonsequential-ID edge cases", () => {
    const directory = mkdtempSync(join(tmpdir(), "hosty-plans-contract-"));
    const path = "docs/features/example/plan.md";
    mkdirSync(join(directory, dirname(path)), { recursive: true });
    mkdirSync(join(directory, "apps/core"), { recursive: true });
    writeFileSync(join(directory, "README.md"), "source file");
    const fixtures: [string, string, boolean][] = [
      ["valid", plan, true],
      ["quoted colon", plan.replace("A plan for the application.", '"A plan: for the application."'), true],
      ["fenced checkboxes", plan + "\n## Example\n\n````md\n- [ ] This is not a deliverable\n```\n- [X] D1. Nor is this\n````\n", true],
      ["tilde fence", plan + "\n~~~md\n- [ ] example\n~~~\n", true],
      ["source link", plan + "\n[Source](../../../README.md)\n", true],
      ["unterminated frontmatter", plan.replace("\n---\n\n#", "\n#"), false],
      ["unknown status", plan.replace("In Progress", "Cancelled"), false],
      ["duplicate ID", plan.replace("D3.", "D1."), false],
      ["outside checkbox", plan + "\n## Other\n- [ ] D5. Wrong place\n", false],
      ["invalid date", plan.replace("2026-10-07", "2026-02-30"), false],
      ["duplicate key", plan.replace("status: In Progress", "status: In Progress\nstatus: Ready"), false],
      ["nested yaml", plan.replace("summary: A plan for the application.", "summary:\n  body: No"), false],
      ["yaml alias", plan.replace("A plan for the application.", "*summary"), false],
      ["yaml tag", plan.replace("A plan for the application.", "!!str summary"), false],
      ["unknown field", plan.replace("summary:", "title:"), false],
      ["empty list", plan.replace("[apps/core]", "[]"), false],
      ["missing component", plan.replace("apps/core", "apps/missing"), false],
      ["broken link", plan + "\n[Missing](missing.md)\n", false],
      ["absolute link", plan + "\n[Readme](/README.md)\n", false],
      ["nested checkbox", plan.replace("- [ ] D3", "  - [ ] D3"), false],
      ["uppercase checkbox", plan.replace("[x]", "[X]"), false],
      ["bad bullet", plan.replace("- [x]", "* [x]"), false],
      ["duplicate section", plan + "\n## Deliverables\n- [ ] D4. Another\n", false],
      ["binary NUL", plan + "\0", false],
    ];
    try {
      for (const [name, content, valid] of fixtures) {
        writeFileSync(join(directory, path), content);
        expect(canonicalVerdict(directory, path, "plan").length === 0, name).toBe(valid);
        expect(appVerdict(directory, path).errors.length === 0, name).toBe(valid);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps dates as strings and computes progress using stable IDs", () => {
    const document = parseSourceDocument("docs/features/example/plan.md", plan);
    expect(document.created).toBe("2026-10-06");
    expect(document.updated).toBe("2026-10-07");
    expect(document.deliverables.map(item => item.id)).toEqual(["D1", "D3"]);
    expect(document.progress).toEqual({ done: 1, total: 2 });
    expect(document.deliverables[0].text).toBe("First item");
  });
});

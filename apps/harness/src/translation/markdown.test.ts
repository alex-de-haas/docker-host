import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markdownParts, validateMarkdownTranslation } from "./markdown.js";

export const PLAN = `---
status: In Progress
summary: Keep machine metadata unchanged.
---

# Reading plan

- [ ] D1. Read **one book** using the [guide](https://example.com/a?q=1#top).
- [x] D2. Keep \`book_id\` intact.
  - Save notes.

1. First step.
2. Second step.

| Task | Result |
| --- | --- |
| Read | Finished |

\`\`\`json
{"book_id": "123"}
\`\`\`

![cover](https://example.com/cover.png)

<!-- marker -->
`;
export const TRANSLATED = PLAN.replace("Reading plan", "План чтения").replace("Read **one book** using the", "Прочитать **одну книгу** по")
  .replace("guide]", "руководству]").replace("Keep `book_id` intact.", "Сохранить `book_id` без изменений.")
  .replace("Save notes.", "Сохранить заметки.").replace("First step.", "Первый шаг.").replace("Second step.", "Второй шаг.")
  .replace("Task | Result", "Задача | Результат").replace("Read | Finished", "Прочитать | Завершено");

describe("Markdown plan integrity", () => {
  it("accepts translated prose while preserving metadata, tasks, links, code and tables", () => {
    expect(() => validateMarkdownTranslation(PLAN, TRANSLATED)).not.toThrow();
  });
  it.each([
    ["status: In Progress", "status: Ready"], ["[ ] D1", "[x] D1"], ["D2.", "D3."],
    ["# Reading", "## Reading"], ["2. Second", "3. Second"], ["q=1", "q=2"],
    ["`book_id`", "`id`"], ["\"123\"", "\"124\""], ["<!-- marker -->", "<!-- changed -->"],
    ["![cover]", "![обложка]"], ["| --- | --- |", "| :--- | --- |"],
  ])("rejects a changed protected element: %s", (before, after) => {
    expect(() => validateMarkdownTranslation(PLAN, PLAN.replace(before, after))).toThrow(/protected Markdown/);
  });
  it("reconstructs every repository plan exactly with bounded translatable segments", () => {
    const root = path.resolve("../..");
    const files = globSync("docs/features/*/plan.md", { cwd: root });
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      const parts = markdownParts(source);
      expect(parts.map(p => p.text).join(""), file).toBe(source);
      for (const part of parts.filter(p => p.translate)) expect([...part.text].length, file).toBeLessThanOrEqual(16_000);
    }
  });
  it("copies very large code blocks and frontmatter without model calls", () => {
    const source = "---\nsummary: example\n---\n\n```\n" + "x".repeat(30_000) + "\n```\n";
    expect(markdownParts(source).every(p => !p.translate)).toBe(true);
  });
  it("splits long lists at item boundaries and refuses an indivisible oversized block", () => {
    const source = Array.from({ length: 20 }, (_, i) => `- [ ] D${i + 1}. ${"word ".repeat(400)}\n`).join("");
    const parts = markdownParts(source);
    expect(parts.map(p => p.text).join("")).toBe(source);
    expect(parts.filter(p => p.translate).length).toBeGreaterThan(1);
    expect(() => markdownParts("word ".repeat(4000))).toThrow(/single Markdown block/);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { markdownParts, validateMarkdownTranslation } from "./local-contract.mjs";

test("fixed evidence inputs remain byte-complete with bounded local diagnostic segments", async () => {
  const evidence = JSON.parse(await readFile("docs/features/translation-provider/benchmark-evidence.json", "utf8"));
  for (const sample of evidence.samples) for (const limit of [4000, 16_000]) {
    const parts = markdownParts(sample.inputText, limit);
    assert.equal(parts.map(part => part.text).join(""), sample.inputText);
    assert.ok(parts.filter(part => part.translate).every(part => [...part.text].length <= limit));
    validateMarkdownTranslation(sample.inputText, sample.inputText);
  }
});
test("protected syntax mutations fail while translated prose succeeds", () => {
  const source = "---\nid: fixed\n---\n# Plan\n\n- [ ] D1. Task with [link](https://example.test).\n\n```sh\necho safe\n```\n";
  validateMarkdownTranslation(source, source.replace("Plan", "План").replace("Task with", "Задача с"));
  for (const [before, after] of [["id: fixed", "id: changed"], ["# Plan", "## Plan"], ["[ ]", "[x]"], ["D1", "D2"], ["example.test", "other.test"], ["echo safe", "echo changed"]])
    assert.throws(() => validateMarkdownTranslation(source, source.replace(before!, after!)), /protected Markdown/);
});
test("code and metadata are copied even beyond a prompt limit; indivisible prose is refused", () => {
  const source = "---\nid: " + "x".repeat(100) + "\n---\n\n```text\n" + "x".repeat(200) + "\n```\n";
  const parts = markdownParts(source, 40);
  assert.equal(parts.map(part => part.text).join(""), source);
  assert.ok(parts.every(part => !part.translate));
  assert.throws(() => markdownParts("word ".repeat(100), 40), /indivisible/);
});
test("retained local benchmark validates its imports and fixtures without model access", async () => {
  for (const kind of ["opus", "hymt"]) {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "scripts/experiments/translation/local-benchmark.mts", "--kind", kind, "--validate-only"]);
    const result = JSON.parse(stdout);
    assert.equal(result.experimentVersion, 2); assert.equal(result.validationOnly, true);
    assert.equal(result.samples.length, 2);
  }
});

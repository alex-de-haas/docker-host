import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { proseSpans, restoreProse } from "./local-markdown.mjs";
import { validateMarkdownTranslation } from "../../../apps/harness/src/translation/markdown.js";

test("both fixed benchmark plans retain protected Markdown through prose replacement", async () => {
  const evidence = JSON.parse(await readFile("docs/features/translation-provider/benchmark-evidence.json", "utf8"));
  for (const sample of evidence.samples) {
    const spans = proseSpans(sample.inputText);
    assert.ok(spans.length > 20);
    assert.ok(spans.every((span: any) => !/book_id|https:|D\d+\b/.test(span.text)));
    validateMarkdownTranslation(sample.inputText, restoreProse(sample.inputText, spans, spans.map(() => "Перевод текста.")));
  }
});
test("model-generated punctuation stays literal instead of becoming Markdown", () => {
  const source = "# Source\n\nText.\n";
  const output = restoreProse(source, proseSpans(source), ["*Title*", "[Text](url) | `code` <b> &copy;"]);
  validateMarkdownTranslation(source, output);
  const tree = fromMarkdown(output);
  assert.equal((tree.children[0] as any).children[0].value, "*Title*");
  assert.equal((tree.children[1] as any).children[0].value, "[Text](url) | `code` <b> &copy;");
});
test("partial, empty and multiline output is rejected", () => {
  const source = "Text.", spans = proseSpans(source);
  for (const translations of [[], [""], ["one\ntwo"]]) assert.throws(() => restoreProse(source, spans, translations));
});
test("unsupported escaped input is explicit instead of silently mistranslated", () => {
  assert.throws(() => proseSpans("A &amp; B"), /requires plain text/);
});
test("sentence segmentation does not discard text or inter-sentence whitespace", () => {
  const source = "# Plan\n\nFirst sentence.  Second sentence.\n";
  const spans = proseSpans(source);
  assert.deepEqual(spans.map(s => s.text), ["Plan", "First sentence.", "Second sentence."]);
  assert.equal(restoreProse(source, spans, ["План", "Первое", "Второе"]), "# План\n\nПервое  Второе\n");
  assert.deepEqual(proseSpans(source, false).map(s => s.text), ["Plan", "First sentence.  Second sentence."]);
});

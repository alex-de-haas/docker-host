import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { prepareDocument, restoreDocument } from '../src/markdown.js';
import { validateMarkdownTranslation } from '../../harness/src/translation/markdown.js';

const source = '---\nstatus: Draft\nsummary: Keep &amp; metadata.\n---\n\n# A &amp; B\n\n- [ ] D1. Keep **bold** and `code` with [a link](https://example.test/a?q=1#x).\n  Continue \\*literal\\* prose.\n- [x] D2. Done.\n\n> Quoted text\n> on a second line.\n\n| A | B |\n| :--- | ---: |\n| One | Two |\n\n```js\nconst x = "original";\n```\n\n![keep alt](cover.png)\n\n<!-- keep -->\n';

test('decoded entities, escapes and continuations preserve protected Markdown under arbitrary output punctuation', () => {
  const prepared = prepareDocument(source, true);
  assert.ok(prepared.fragments.includes('A & B'));
  assert.ok(prepared.fragments.some(t => t.includes('*literal*')));
  const result = restoreDocument(prepared, prepared.fragments.map(() => '[Перевод] | *текст* <b> `x` &copy;.'));
  validateMarkdownTranslation(source, result);
  for (const protectedText of ['status: Draft', '[ ] D1', '[x] D2', '`code`', 'https://example.test/a?q=1#x', 'const x = "original";', '![keep alt](cover.png)', '<!-- keep -->']) assert.ok(result.includes(protectedText), protectedText);
});

test('all repository plans survive prose replacement with the unchanged production validator', () => {
  const root = resolve('../..');
  const files = globSync('docs/features/*/plan.md', { cwd: root });
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8');
    const doc = prepareDocument(text, true);
    let result = '';
    assert.doesNotThrow(() => { result = restoreDocument(doc, doc.fragments.map(() => 'Перевод текста.')); }, file);
    assert.doesNotThrow(() => validateMarkdownTranslation(text, result), file);
  }
});

test('plain text preserves line breaks, IDs and literal punctuation', () => {
  const doc = prepareDocument('  First. Second.\r\n\nD1. [literal] text.  ', false);
  assert.deepEqual(doc.fragments, ['First.', 'Second.', '[literal] text.']);
  assert.equal(restoreDocument(doc, ['Первое.', 'Второе.', '[текст].']), '  Первое. Второе.\r\n\nD1. [текст].  ');
});

test('code-only documents need no model calls; incomplete and multiline output is refused', () => {
  const code = '```\n' + 'value'.repeat(5000) + '\n```\n';
  assert.equal(prepareDocument(code, true).fragments.length, 0);
  assert.equal(restoreDocument(prepareDocument(code, true), []), code);
  for (const output of [[], [''], ['line\nbreak']]) assert.throws(() => restoreDocument(prepareDocument('Text.', true), output), /incomplete/);
});

test('autolinks and implicit reference labels remain literal while ordinary link labels translate', () => {
  const source = '<https://example.test> and https://example.test/path and [label][id].\n\n[shortcut] and [collapsed][].\n\n[id]: https://example.test/a\n[shortcut]: https://example.test/b\n[collapsed]: https://example.test/c\n';
  const doc = prepareDocument(source, true);
  const result = restoreDocument(doc, doc.fragments.map(() => 'Перевод.'));
  validateMarkdownTranslation(source, result);
  for (const value of ['<https://example.test>', 'https://example.test/path', '[shortcut]', '[collapsed][]']) assert.ok(result.includes(value));
});

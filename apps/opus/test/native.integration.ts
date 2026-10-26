import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OpusWorker } from '../src/worker.js';
import { TranslationService } from '../src/service.js';
import { validateMarkdownTranslation } from '../../harness/src/translation/markdown.js';

// Native model inference is explicitly selected locally; ordinary CI never downloads model weights.
test('real OPUS model, protected documents, refusal, cancellation and verified cache reuse', {
  skip: process.env.HOSTY_OPUS_INTEGRATION !== '1', timeout: 1_800_000,
}, async t => {
  const cache = process.env.HOSTY_OPUS_TEST_CACHE ?? await mkdtemp(join(tmpdir(), 'hosty-opus-integration-'));
  const app = fileURLToPath(new URL('../', import.meta.url));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let worker: OpusWorker | undefined;
  try {
    execFileSync(process.execPath, [join(app, 'scripts/setup.mjs')], { env: { ...process.env, HOSTY_APP_CACHE_DIR: cache }, stdio: 'inherit', timeout: 1_200_000 });
    const create = () => new OpusWorker(join(cache, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [join(app, 'runtime/worker.py'), join(cache, 'models'), '8'], message => t.diagnostic(message));
    worker = create();
    let start = performance.now(); await worker.start();
    t.diagnostic('Initial model readiness: ' + Math.round(performance.now() - start) + ' ms');
    const service = new TranslationService(worker);
    const translate = (text: string, format: 'text' | 'markdown') => service.translate({ text, format, sourceLanguage: 'en', targetLanguage: 'ru' }, AbortSignal.timeout(120_000));
    const plain = await translate('The local application translates documents without sending their contents to a remote service.', 'text');
    assert.match(plain.text, /[А-Яа-яЁё]/); assert.notEqual(plain.text, '');
    const fixture = '---\nstatus: Draft\nsummary: Original metadata.\n---\n\n# Local translation\n\n- [ ] D1. Translate **the document** and preserve `sourceCode` with [a link](https://example.test).\n- [x] D2. Keep the original file unchanged.\n\n```js\nconst original = true;\n```\n';
    const real = await readFile(join(root, 'docs/features/ci-feedback-loop/feature.md'), 'utf8');
    for (const source of [fixture, real]) {
      start = performance.now();
      const result = await translate(source, 'markdown');
      validateMarkdownTranslation(source, result.text);
      assert.match(result.text, /[А-Яа-яЁё]/);
      t.diagnostic(source.length + '-character Markdown: ' + Math.round(performance.now() - start) + ' ms; protected structure preserved');
    }
    await assert.rejects(translate('uninterrupted '.repeat(800), 'text'), { code: 'translation_segment_too_large' });
    assert.equal(worker.ready, true);
    const cancel = new AbortController();
    const pending = worker.translate(Array(32).fill('The application must keep every document unchanged and protect its original source. '.repeat(10)), cancel.signal);
    const timer = setTimeout(() => cancel.abort(), 25);
    try { await assert.rejects(pending); } finally { clearTimeout(timer); }
    for (let attempt = 0; attempt < 600 && !worker.ready; attempt++) await sleep(100);
    assert.equal(worker.ready, true, 'cancelled inference must recover a worker');
    assert.match((await translate('The application is ready again.', 'text')).text, /[А-Яа-яЁё]/);
    const spec = JSON.parse(await readFile(join(app, 'runtime/model.json'), 'utf8')) as { id: string };
    const receipt = join(cache, 'models', spec.id, 'receipt.json');
    const before = await stat(receipt);
    await worker.stop(); worker = create();
    start = performance.now(); await worker.start();
    assert.equal((await stat(receipt)).mtimeMs, before.mtimeMs, 'valid cache must be reused without conversion');
    t.diagnostic('Verified cache restart: ' + Math.round(performance.now() - start) + ' ms');
    assert.match((await worker.translate(['Keep the original file.'], AbortSignal.timeout(30_000)))[0]!, /[А-Яа-яЁё]/);
    await worker.stop();
    await appendFile(join(cache, 'models', spec.id, 'source.spm'), Buffer.from([0]));
    worker = create(); await worker.start();
    assert.notEqual((await stat(receipt)).mtimeMs, before.mtimeMs, 'corrupt cache must be rebuilt from the verified archive');
    assert.match((await worker.translate(['Keep the original file.'], AbortSignal.timeout(30_000)))[0]!, /[А-Яа-яЁё]/);
    t.diagnostic('Corrupted model cache rebuilt successfully; inference recovered.');
  } finally {
    await worker?.stop();
    if (!process.env.HOSTY_OPUS_TEST_CACHE) await rm(cache, { recursive: true, force: true });
  }
});

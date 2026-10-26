import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '@hosty-sdk/app/providers';
import { TranslationService, parseTranslation, MAX_BYTES } from '../src/service.js';
import type { TranslationEngine } from '../src/worker.js';
const signal = () => AbortSignal.timeout(5000);
const request = { text: 'Translate this.', targetLanguage: 'ru' };

test('the fixed language pair, defaults and limits are explicit', () => {
  assert.equal(parseTranslation(request).sourceLanguage, 'auto');
  assert.equal(parseTranslation({ ...request, sourceLanguage: 'en-US', targetLanguage: 'ru-RU' }).targetLanguage, 'ru-RU');
  for (const input of [{ ...request, format: ['markdown'] }, { ...request, targetLanguage: 'en' }, { ...request, sourceLanguage: 'ru' }, { ...request, text: '' }, { ...request, extra: true }, { ...request, text: 'x'.repeat(16_001) }]) assert.throws(() => parseTranslation(input), ProviderError);
  const service = new TranslationService({ ready: false, reason: 'Model loading.', translate: async () => [] });
  assert.deepEqual(service.capabilities().targetLanguages, ['ru']);
  assert.equal(service.capabilities().reason, 'Model loading.');
});

test('one request owns all batches; busy and failures release the gate', async () => {
  let release!: (texts: string[]) => void;
  const engine: TranslationEngine = { ready: true, reason: undefined, translate: () => new Promise(resolve => { release = resolve; }) };
  const service = new TranslationService(engine);
  const first = service.translate(request, signal());
  await assert.rejects(service.translate(request, signal()), e => e instanceof ProviderError && e.status === 429);
  release(['Перевод.']);
  assert.equal((await first).text, 'Перевод.');
  engine.translate = async () => { throw new ProviderError('translation_segment_too_large', 'Too long.', 413); };
  await assert.rejects(service.translate(request, signal()), /Too long/);
  engine.translate = async texts => texts.map(() => 'Перевод.');
  assert.equal((await service.translate(request, signal())).text, 'Перевод.');
});

test('batched translation preserves all sentences and refuses output overflow', async () => {
  const batches: number[] = [];
  const engine: TranslationEngine = { ready: true, reason: undefined, translate: async texts => { batches.push(texts.length); return texts.map(() => 'Текст.'); } };
  const service = new TranslationService(engine);
  const result = await service.translate({ ...request, text: Array(70).fill('A sentence.').join(' ') }, signal());
  assert.deepEqual(batches, [32, 32, 6]);
  assert.equal(result.text.match(/Текст/g)?.length, 70);
  engine.translate = async () => ['x'.repeat(MAX_BYTES + 1)];
  await assert.rejects(service.translate(request, signal()), /output exceeded/);
});

test('an already cancelled request does not enter inference', async () => {
  const service = new TranslationService({ ready: true, reason: undefined, translate: async () => assert.fail('Unexpected inference') });
  await assert.rejects(service.translate(request, AbortSignal.abort()));
});

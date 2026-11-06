import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { networkInterfaces } from 'node:os';
import { ProviderError } from '@hosty-sdk/app/providers';
import { createApp, listenApp } from '../src/server.js';
import { TranslationService } from '../src/service.js';

test('provider authority is checked on every API request before processing document content', async () => {
  let revoked = false, checks = 0, calls = 0;
  const service = new TranslationService({ ready: true, reason: undefined, translate: async texts => { calls++; return texts.map(() => 'Перевод.'); } });
  const server = createApp(service, async token => { checks++; if (token !== 'fixture-provider' || revoked) throw new ProviderError('permission_denied', 'Provider grant denied.', 403); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer fixture-provider', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/api/translation/v1/capabilities')).status, 401);
    assert.equal((await fetch(url + '/api/translation/v1/capabilities', { headers })).status, 200);
    const valid = await fetch(url + '/api/translation/v1/translations', { method: 'POST', headers, body: JSON.stringify({ text: 'Text.', targetLanguage: 'ru', format: 'markdown' }) });
    assert.equal(valid.status, 200); assert.equal(((await valid.json()) as { sourceLanguage: string }).sourceLanguage, 'auto');
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    revoked = true;
    const rejected = await fetch(url + '/api/translation/v1/translations', { method: 'POST', headers, body: '{invalid JSON' });
    assert.equal(rejected.status, 403); assert.equal(calls, 1); assert.equal(checks, 3);
    revoked = false;
    assert.equal((await fetch(url + '/api/translation/v1/translations', { method: 'POST', headers, body: '{invalid JSON' })).status, 400);
    assert.equal((await fetch(url + '/api/translation/v1/translations', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(1_048_576), targetLanguage: 'ru' }) })).status, 413);
    assert.equal((await fetch(url + '/api/translation/v1/translations', { method: 'PUT', headers })).status, 405);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('closing the HTTP client cancels active model work', { timeout: 5000 }, async () => {
  let began!: () => void, cancelled!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const service = new TranslationService({ ready: true, reason: undefined, translate: async (_texts, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true }); began();
  }) });
  const server = createApp(service, async () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/translation/v1/translations`;
  const request = fetch(url, { method: 'POST', signal: controller.signal,
    headers: { authorization: 'Bearer fixture-provider', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Translate.', targetLanguage: 'ru' }) });
  try {
    await started; controller.abort(); await assert.rejects(request); await stopped;
  } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


const hostAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
test('native provider accepts host-interface traffic while enforcing provider authority', { skip: !hostAddress, timeout: 5000 }, async () => {
  let revoked = false;
  const service = new TranslationService({ ready: true, reason: undefined, translate: async texts => texts.map(() => 'Перевод.') });
  const server = createApp(service, async token => {
    if (revoked || token !== 'fixture-provider') throw new ProviderError('permission_denied', 'Provider grant denied.', 403);
  });
  listenApp(server, 0); await once(server, 'listening');
  const url = `http://${hostAddress}:${(server.address() as AddressInfo).port}/api/translation/v1`;
  const headers = { authorization: 'Bearer fixture-provider', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(url + '/capabilities')).status, 401);
    assert.equal((await fetch(url + '/capabilities', { headers })).status, 200);
    const result = await fetch(url + '/translations', { method: 'POST', headers, body: JSON.stringify({ text: 'Translate.', targetLanguage: 'ru' }) });
    assert.equal(result.status, 200); assert.equal((await result.json() as { text: string }).text, 'Перевод.');
    revoked = true;
    assert.equal((await fetch(url + '/capabilities', { headers })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OpusWorker, workerEnvironment } from '../src/worker.js';
const worker = () => new OpusWorker(process.execPath, [fileURLToPath(new URL('./fake-worker.mjs', import.meta.url))], () => {});

test('cancellation kills inference, waits for its exit, and recovers a clean resident worker', async () => {
  const engine = worker(); await engine.start();
  try {
    const controller = new AbortController();
    const request = engine.translate(['slow'], controller.signal);
    controller.abort(); await assert.rejects(request);
    for (let i = 0; i < 100 && !engine.ready; i++) await sleep(10);
    assert.equal(engine.ready, true);
    assert.deepEqual(await engine.translate(['hello'], AbortSignal.timeout(2000)), ['Перевод.']);
  } finally { await engine.stop(); }
});

test('unexpected worker exit rejects the request and exposes unavailable readiness', async () => {
  const engine = worker(); await engine.start();
  try { await assert.rejects(engine.translate(['exit'], AbortSignal.timeout(2000))); assert.equal(engine.ready, false); }
  finally { await engine.stop(); }
});

test('worker environment excludes provider credentials and Python path overrides', () => {
  process.env.HOSTY_OPUS_TEST_SECRET = 'test-only';
  try { const env = workerEnvironment(); assert.equal(env.HOSTY_OPUS_TEST_SECRET, undefined); assert.equal(env.HOSTY_APP_SERVICE_TOKEN, undefined); assert.equal(env.PYTHONPATH, undefined); }
  finally { delete process.env.HOSTY_OPUS_TEST_SECRET; }
});

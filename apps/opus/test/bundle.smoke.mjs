import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

test('the shipped OPUS entry point serves its health check', { timeout: 15_000 }, async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));

  const cache = await mkdtemp(join(tmpdir(), 'hosty-opus-bundle-'));
  const entry = fileURLToPath(new URL('../dist/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HOSTY_APP_CACHE_DIR: cache,
      HOSTY_APP_ID: 'hosty.opus',
      HOSTY_APP_SERVICE_TOKEN: 'bundle-test',
      HOSTY_CORE_ORIGIN: 'http://127.0.0.1:1',
      HOSTY_PORT_HTTP: String(port),
      OPUS_THREADS: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic += chunk; });
  child.on('error', error => { diagnostic += error.message; });
  let exited = false;
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));

  try {
    const deadline = AbortSignal.timeout(10_000);
    let response;
    while (!exited && !deadline.aborted) {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(500)]);
      response = await fetch('http://127.0.0.1:' + port + '/healthz', { signal }).catch(() => undefined);
      if (response) break;
      await delay(25);
    }
    assert.ok(response, 'The bundled service did not answer /healthz.\n' + diagnostic);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'running' });
  } finally {
    child.kill('SIGKILL');
    await closed;
    await rm(cache, { recursive: true, force: true });
  }
});

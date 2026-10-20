import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { startDockerFaultProxy } from './docker-fault-proxy.mjs';

async function fixture(t, handler) {
  const root = await mkdtemp('/tmp/hpf-');
  const upstreamPath = path.join(root, 'up.sock'), socketPath = path.join(root, 'proxy.sock');
  const sockets = new Set();
  const upstream = http.createServer(handler);
  upstream.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise(resolve => upstream.listen(upstreamPath, resolve));
  const proxy = await startDockerFaultProxy(socketPath, upstreamPath);
  t.after(async () => { await proxy.close(); for (const s of sockets) s.destroy(); await new Promise(r => upstream.close(r)); await rm(root, { recursive: true, force: true }); });
  const fault = async mode => {
    const r = await fetch(proxy.origin + '/fault', { method: 'PUT', headers: { authorization: 'Bearer ' + proxy.token, 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    assert(r.ok); return r.json();
  };
  const request = (method, pathname, socket = socketPath) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: pathname }, resolve);
    req.setTimeout(2000, () => req.destroy(new Error('test request timed out')));
    req.once('error', reject); req.end();
  });
  return { proxy, fault, request, upstreamPath };
}
async function body(response) { let text = ''; for await (const b of response) text += b; return text; }

test('forwards wait headers before a later request completes its body', async t => {
  let pending;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/wait') { pending = res; res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }
    else { pending.end('{"StatusCode":0}'); res.end('started'); }
  });
  const waiting = await f.request('POST', '/wait');
  assert.equal(await body(await f.request('POST', '/start')), 'started');
  assert.equal(JSON.parse(await body(waiting)).StatusCode, 0);
});

test('scopes image and connection faults to proxy clients and recovers', async t => {
  const f = await fixture(t, (_req, res) => res.end('upstream'));
  await f.fault('worker-image');
  const refused = await f.request('GET', '/v1.52/images/ghcr.io%2Fexample%2Fhosty-agent-worker%3A0.62.0/json');
  assert.equal(refused.statusCode, 404); await body(refused);
  assert.equal(await body(await f.request('GET', '/info')), 'upstream');
  await f.fault('offline');
  await assert.rejects(f.request('GET', '/info'));
  assert.equal(await body(await f.request('GET', '/info', f.upstreamPath)), 'upstream');
  await f.fault('none'); assert.equal(await body(await f.request('GET', '/info')), 'upstream');
});

test('loses only the reply after upstream worker removal completes', async t => {
  let removed = 0;
  const f = await fixture(t, (_req, res) => { removed++; res.writeHead(204); res.end(); });
  await f.fault('lose-remove-reply');
  await assert.rejects(f.request('DELETE', '/v1.52/containers/hosty-agent-owned'));
  assert.equal(removed, 1);
  assert.equal(f.proxy.hits[0].upstreamStatus, 204);
  await f.fault('none');
  assert.equal((await f.request('DELETE', '/v1.52/containers/hosty-agent-owned')).statusCode, 204);
});

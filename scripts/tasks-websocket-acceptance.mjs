// Called only by the disposable task integration fixture; app credentials arrive on stdin.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/harness/package.json', import.meta.url));
const WebSocket = require('ws');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
assert.equal(config.admission.protocol, 'hosty-events-v1');
assert.equal(config.admission.path, '/api/event-stream');
const origin = new URL(config.origin);
const url = new URL(config.admission.path, origin); url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url, [config.admission.protocol, `ticket.${config.admission.ticket}`], { origin: origin.origin });
let frames = '', changed = 0, failure;
const watchers = new Set();
const notify = () => { for (const watcher of watchers) watcher(); };
socket.on('message', (data, binary) => {
  if (binary) failure = new Error('Task events must use text frames.');
  else {
    frames += data.toString('utf8');
    if (Buffer.byteLength(frames) > 1_048_576) failure = new Error('Task event fixture exceeded its bounded receive buffer.');
    changed = [...frames.matchAll(/^event: changed\r?\n/gm)].length;
  }
  notify();
});
socket.on('error', error => { failure = error; notify(); });
socket.on('close', () => { failure ??= new Error('Task events closed before fixture completion.'); notify(); });
const observed = target => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error('Task change did not arrive through WebSocket.')), 15_000);
  const check = () => { if (failure) finish(failure); else if (changed >= target) finish(); };
  const finish = error => { clearTimeout(timer); watchers.delete(check); if (error) reject(error); else resolve(); };
  watchers.add(check); check();
});
try {
  await once(socket, 'open', { signal: AbortSignal.timeout(15_000) });
  assert.equal(socket.protocol, config.admission.protocol);
  await observed(1);
  assert.match(frames, /^event: stream\.ready\r?\n/m);
  assert.ok(frames.indexOf("event: stream.ready") < frames.indexOf("event: changed"), "Readiness must precede task hints.");
  const before = changed;
  const response = await fetch(new URL('/api/tasks/v1/tasks', origin), {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Origin: origin.origin, Cookie: config.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), input: {
      title: 'WebSocket task-history acceptance', markdown: 'Synthetic live update without execution.',
      assignee: null, review: { mode: 'none' }, resources: [], parentTaskRef: null, dependsOn: [],
    } }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, 'Draft');
  await observed(before + 1);
  console.log('PASS: authenticated task-event ticket, WebSocket initial snapshot and live task-history change');
} finally {
  config.cookie = ''; config.admission.ticket = '';
  socket.close();
  await Promise.race([once(socket, 'close').catch(() => {}), new Promise(resolve => setTimeout(() => { socket.terminate(); resolve(); }, 1000))]);
}

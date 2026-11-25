import { it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { inputSnapshot, prepare, repository } from './local-runtime.mjs';
import { acknowledgeAgentHistory, readAgentHistoryRange, readAgentHistoryStates } from '@hosty-sdk/app/agent/client';
import { ProviderStore } from '../src/store.ts';
import { commonAssets } from './build-config.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
async function write(root, relative, bytes) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
}

// Feed the same atomic publication path as the supervisor. The consumer stays offline until
// after Stop, and the real native inference is still connected throughout this write.
async function fillHistory(data, provider, runId) {
  const store = new ProviderStore(path.join(data, 'agent-sessions'), provider, 4096);
  const hash = createHash('sha256');
  try {
    await store.initialize();
    await store.exclusive(async () => {
      const { session, record } = await store.run(runId);
      for (let i = 0; i < 65; i++) {
        const text = i + ' ' + 'x'.repeat(1024 * 1024 - 8192);
        store.emit(record, 'message.completed', { messageId: 'offline-' + i, text });
        hash.update(text);
      }
      await store.save(session);
    });
  } finally { store.history.close(); }
  return hash.digest('hex');
}

async function replayAndAcknowledge(options, sessionId, expectedHash) {
  const state = await readAgentHistoryStates(options);
  const chat = state.sessions.find(item => item.sessionId === sessionId);
  expect(chat.snapshot.stopConfirmed).toBe(true);
  let from = 1, count = 0;
  const received = createHash('sha256');
  while (from <= chat.head) {
    const page = await readAgentHistoryRange({ ...options, through: state.through, sessionId, epoch: chat.epoch, from, to: chat.head, limit: 10 });
    for (const { item } of page.observations) {
      if (item.event?.type === 'message.completed' && item.event.data.messageId.startsWith('offline-')) {
        expect(item.event.data.messageId).toBe('offline-' + count++);
        received.update(item.event.data.text);
      }
    }
    if (page.nextPosition === null) break;
    from = page.nextPosition;
  }
  expect(count).toBe(65);
  expect(received.digest('hex')).toBe(expectedHash);
  const receipt = { sessionId, epoch: chat.epoch, through: chat.head };
  await acknowledgeAgentHistory(options, receipt);
  await acknowledgeAgentHistory(options, receipt);
}

// Exercise the actual Core Local launcher and production Ollama adapter. The HTTP peers stand in
// for Core admission and an Ollama server whose one inference stream stays open until cancelled.
it('stops the original native attempt after an HTTP restart with a full delivery backlog, then admits the next run after durable ACK', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosty-attempt-restart-')));
  const root = path.join(directory, 'source'), cache = path.join(directory, 'cache'), data = path.join(directory, 'data');
  const slug = 'ollama-provider', installationId = randomUUID(), appId = 'test.provider', account = randomUUID();
  const sessionId = randomUUID(), runId = randomUUID(), stopId = randomUUID();
  const provider = { appId, installationId, key: 'default' };
  let activeRun = runId, activeStop = stopId;
  let chats = 0, stopped = 0, releases = 0, admitted = 0, service;
  const peers = createServer(async (request, response) => {
    if (request.url === '/api/chat') {
      chats++; response.on('close', () => { stopped++; });
      response.writeHead(200, { 'content-type': 'application/x-ndjson' }); response.flushHeaders();
      return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    let result;
    if (request.url.endsWith('/history/introspect')) result = {
      provider, callerAppId: 'test.consumer', callerInstallation: 'consumer-installation',
      expiresAt: new Date(Date.now() + 60000).toISOString(), acknowledge: true,
    };
    else if (request.url.endsWith('/introspect')) result = {
      provider, operation: input.operation, sessionId, runId: input.path?.match(/\/runs\/([^/]+)/)?.[1] ?? runId,
      principalId: 'principal', userId: 'user', callerAppId: 'test.consumer', callerInstallation: 'consumer-installation', admissionRef: 'admission',
    };
    else if (request.url.endsWith('/admit')) {
      admitted++;
      if (admitted === 1) { response.writeHead(503); response.end(JSON.stringify({ code: 'temporarily_unavailable' })); return; }
      result = { expiresAt: new Date(Date.now() + 60000).toISOString() };
    } else if (request.url.endsWith('/renew')) result = { expiresAt: new Date(Date.now() + 60000).toISOString() };
    else if (request.url.endsWith('/workspace')) { releases++; result = { state: 'released' }; }
    else if (request.url === '/api/version') result = { version: 'test' };
    else if (request.url === '/api/tags') result = { models: [{ name: 'fixture' }] };
    else if (request.url === '/api/show') result = { capabilities: ['completion', 'tools'] };
    if (!result) response.writeHead(404);
    response.end(JSON.stringify(result ?? {}));
  });
  const portReservation = createServer();
  const port = await listen(portReservation); await new Promise(resolve => portReservation.close(resolve));
  const peer = 'http://127.0.0.1:' + await listen(peers), origin = 'http://127.0.0.1:' + port;
  const env = { ...process.env, HOSTY_APP_DATA_DIR: data, HOSTY_APP_CACHE_DIR: cache, HOSTY_CORE_ORIGIN: peer,
    HOSTY_APP_SERVICE_TOKEN: 'fixture-identity', HOSTY_APP_ID: appId, HOSTY_APP_INSTALLATION_ID: installationId, HOSTY_PORT_HTTP: String(port) };
  let output = '';
  async function startService() {
    service = spawn(process.execPath, [path.join(root, 'packages/agent-provider-runtime/scripts/local-runtime.mjs'), 'start', slug], { env, stdio: ['ignore','pipe','pipe'] });
    for (const pipe of [service.stdout, service.stderr]) pipe.on('data', chunk => { output = (output + chunk).slice(-4000); });
    await vi.waitFor(async () => {
      if (service.exitCode !== null) throw new Error('Provider exited: ' + output);
      expect((await fetch(origin + '/healthz')).status).toBe(200);
    }, { timeout: 10000 });
  }
  async function call(route, input) {
    const response = await fetch(origin + '/api/agent/v2/' + route, { method: input ? 'PUT' : 'GET',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  }
  async function killService() {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    const exited = once(service, 'exit'); service.kill('SIGKILL'); await exited;
  }
  try {
    for (const file of await inputSnapshot(repository, slug)) await write(root, file.path, file.bytes);
    await prepare({ root, cache, slug, log() {}, buildBundle: async generation => {
      const dist = path.join(generation, 'apps', slug, 'dist'); await mkdir(dist, { recursive: true });
      await build({ entryPoints: [path.join(repository, 'apps', slug, 'src/main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24',
        outfile: path.join(dist,'main.mjs'), banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" } });
      for (const file of commonAssets) await copyFile(path.join(repository,'packages/agent-provider-runtime/src',file),path.join(dist,file));
      for (const file of ['settings-browser.mjs','hosty-theme.css','settings-bootstrap.js','settings.css',
        ...['plex-sans','jetbrains-mono'].flatMap(family => [...['latin','latin-ext','cyrillic'].map(subset => 'fonts/'+family+'-'+subset+'.woff2'),'fonts/'+family+'-LICENSE.txt'])]) await write(dist,file,'');
    } });
    await write(data,'connections.json',JSON.stringify({ version:1, defaultId:account, connections:[{ id:account, name:'Local', kind:'ollama', auth:'none', revision:1, secretKey:'', baseUrl:peer }] }));
    const legacySession = randomUUID(), legacyRun = randomUUID();
    const legacyFile = path.join('agent-sessions',legacySession+'.json');
    await write(data,legacyFile,JSON.stringify({ version:1, id:legacySession, runs:{ [legacyRun]:{ snapshot:{ ref:{ id:legacyRun },generation:randomUUID(),stopConfirmed:false } } } }));
    const blocked = spawn(process.execPath,[path.join(root,'packages/agent-provider-runtime/scripts/local-runtime.mjs'),'start',slug],{env,stdio:['ignore','ignore','pipe']});
    service = blocked;
    let why = ''; blocked.stderr.on('data', chunk => { why += chunk; });
    expect((await once(blocked,'close',{ signal:AbortSignal.timeout(10000) }))[0]).toBe(1);
    expect(why).toContain('previous provider has an unclosed execution');
    await rm(path.join(data,legacyFile));
    await startService();
    await call('sessions/'+sessionId, { configuration: { connection: { id:account, revision:'1' }, nativeTools:'none' } });
    if (!(await call('capabilities')).capabilities.includes('scope.workspace-writers')) {
      await expect(call('sessions/'+sessionId+'/runs/'+runId, { expectedSessionRevision:'1', configurationRevision:'1', continuation:'start',
        resources:[{ kind:'worktree', id:randomUUID(), revision:'1' }], input:{ text:'Needs a writer.' } })).rejects.toThrow('unsupported_capability');
      expect(admitted).toBe(0);
    }
    const first = await call('sessions/'+sessionId+'/runs/'+runId, { expectedSessionRevision:'1',configurationRevision:'1',continuation:'start',input:{ text:'Please wait.' } });
    await vi.waitFor(async () => { const run = await call('runs/'+runId); expect({ chats, state:run.state, result:run.result }).toMatchObject({ chats:1,state:'running' }); }, { timeout:12000 });
    await killService();
    const expectedHash = await fillHistory(data, provider, runId);
    await delay(250); expect(stopped).toBe(0);
    await startService();
    expect(await call('runs/'+runId)).toMatchObject({ generation:first.generation, state:'running', stopConfirmed:false });
    await call('runs/'+runId+'/stop', { requestId:stopId });
    await vi.waitFor(async () => {
      expect(await call('runs/'+runId)).toMatchObject({ generation:first.generation, state:'cancelled', stopConfirmed:true, pending:[] });
      expect(stopped).toBe(1); expect(releases).toBe(1);
    }, { timeout:10000 });
    expect(await call('runs/'+runId+'/stop', { requestId:stopId })).toMatchObject({ state:'applied' });
    expect(chats).toBe(1); expect(admitted).toBe(2);
    activeRun = randomUUID(); activeStop = randomUUID();
    const nextRoute = 'sessions/' + sessionId + '/runs/' + activeRun;
    const session = await call('sessions/' + sessionId);
    const next = { expectedSessionRevision: session.revision, configurationRevision: '1', continuation: 'resume', input: { text: 'Continue.' } };
    await expect(call(nextRoute, next)).rejects.toThrow('history_backpressure');
    expect(admitted).toBe(2);
    await replayAndAcknowledge({ url: origin + '/api/agent/v2/history/events', token: 'fixture', provider }, sessionId, expectedHash);
    await call(nextRoute, next);
    await vi.waitFor(() => expect(chats).toBe(2), { timeout: 10000 });
    await call('runs/' + activeRun + '/stop', { requestId: activeStop });
    await vi.waitFor(async () => {
      expect(await call('runs/' + activeRun)).toMatchObject({ state: 'cancelled', stopConfirmed: true });
      expect(stopped).toBe(2); expect(releases).toBe(2);
    }, { timeout: 10000 });
  } finally {
    if (service?.exitCode === null && service.signalCode === null && chats > stopped) {
      await call('runs/'+activeRun+'/stop', { requestId:activeStop }).catch(() => {});
      await vi.waitFor(() => expect(stopped).toBe(chats), { timeout:4000 }).catch(() => {});
    }
    await killService(); peers.closeAllConnections(); await new Promise(resolve => peers.close(resolve));
    await rm(directory,{ recursive:true,force:true });
  }
}, 45000);

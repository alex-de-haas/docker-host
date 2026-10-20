import assert from 'node:assert/strict';
import { readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
const execFile = promisify(execFileCallback);
const root = process.env.HOSTY_TEST_APP_ROOT;
const dataRoot = path.resolve(root, '../..');
assert(dataRoot.includes('/hosty-core-lifecycle-tests-') && dataRoot.includes('/environments/'));
const stage = process.env.HOSTY_TEST_STAGE;
const coreOrigin = process.env.HOSTY_TEST_CORE_ORIGIN;
const origin = process.env.HOSTY_TEST_APP_ORIGIN;
const stateFile = path.join(root, 'cache', 'production-failure-state.json');
const reportFile = process.env.HOSTY_TEST_HARNESS_FAILURE_REPORT;
assert(reportFile && path.isAbsolute(reportFile), 'Supply an external evidence path.');
const control = JSON.parse(await readFile(process.env.HOSTY_TEST_DOCKER_FAULT_CONTROL, 'utf8'));
const realDockerEnv = { ...process.env, DOCKER_HOST: process.env.HOSTY_TEST_DOCKER_UPSTREAM };
delete realDockerEnv.DOCKER_CONTEXT;
let token = process.env.HOSTY_TEST_APP_TOKEN;
let state = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{"rows":[],"sessions":[]}'));
const hash = value => createHash('sha256').update(value).digest('hex');
const save = async () => {
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  await writeFile(reportFile, JSON.stringify({ dataRoot, stage, rows: state.rows, status: state.status }), { mode: 0o600 });
};
const passed = async (scenario, details = {}) => { state.rows.push({ stage, scenario, status: 'passed', ...details }); await save(); console.log(`${stage}: ${scenario} passed.`); };
async function fault(mode) {
  const r = await fetch(control.origin + '/fault', { method: 'PUT', headers: { authorization: 'Bearer ' + control.token, 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
  assert(r.ok); return r.json();
}
async function core(method, url, body) {
  const parent = JSON.parse(await readFile(path.join(dataRoot, 'core', 'parent-session.json'), 'utf8'));
  const response = await fetch(new URL(url, coreOrigin), { method, headers: { cookie: parent.cookie, 'X-Hosty-CSRF': parent.csrf, origin: coreOrigin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const value = await response.json(); assert(response.ok, `Core ${method} ${url}: ${response.status} ${value.code ?? ''} ${value.message ?? ''}`); return value;
}
async function raw(method, url, body) {
  const response = await fetch(new URL(url, origin), { method, headers: { authorization: 'Bearer ' + token, origin: new URL(origin).origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  return { status: response.status, body: await response.json() };
}
async function api(method, url, body) { const r = await raw(method, url, body); assert(r.status < 400, `Harness ${method} ${url}: ${r.status} ${r.body.code ?? ''} ${r.body.message ?? ''}`); return r.body; }
async function refresh() {
  const verifier = randomBytes(32).toString('hex');
  const code = await core('POST', '/api/apps/hosty.harness/launch-code', { redirectUri: origin, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' });
  const response = await fetch(new URL('/api/app-code', origin), { method: 'POST', headers: { origin: new URL(origin).origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, codeVerifier: verifier }) });
  assert(response.ok); token = (await response.json()).accessToken;
}
async function cli(...args) {
  try { return (await execFile('hosty', ['--data-root', dataRoot, 'apps', ...args], { timeout: 240000, maxBuffer: 100000 })).stdout; }
  catch (error) { throw new Error(`Core lifecycle ${args[0]} failed: ${error.stdout ?? ''} ${error.stderr ?? ''}`); }
}
const docker = async (...args) => (await execFile('docker', args, { env: realDockerEnv, timeout: 30000, maxBuffer: 200000 })).stdout.trim();
const record = id => api('GET', '/api/sessions/' + id);
async function events(id) {
  return (await readFile(path.join(root, 'data', 'sessions', id, 'events.ndjson'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function newSession(title, extra = {}) {
  const s = await api('POST', '/api/sessions', { title, connectionId: state.connection?.id ?? null, ...extra }); state.sessions.push(s.id); await save(); return s;
}
async function send(id, text) { const s = await record(id); return api('POST', `/api/sessions/${id}/messages`, { text, appContextRevision: s.appContextRevision }); }
async function settle(id, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await record(id);
    if (!['running', 'awaiting_approval', 'awaiting_question'].includes(r.status)) return r;
    assert(Date.now() < deadline, 'Model turn timed out.'); await new Promise(resolve => setTimeout(resolve, 400));
  }
}
async function reply(id, text, expected) {
  await send(id, text); const r = await settle(id);
  assert.equal(r.status, 'idle', `Turn ended ${r.status}: ${(await events(id)).filter(e => e.type === 'error').map(e => e.message).join('; ')}`);
  assert((await events(id)).filter(e => e.type === 'assistant_text').at(-1)?.text.includes(expected), 'Provider reply was not preserved.');
  return r;
}
async function stateOnDisk() { return JSON.parse(await readFile(path.join(root, 'data', 'worker', 'state.json'), 'utf8').catch(() => 'null')); }
async function activeLease(generation) { return JSON.parse(await readFile(path.join(dataRoot, 'core/development/worker-leases', generation + '.json'), 'utf8')); }
async function noWorker() { assert.equal(await stateOnDisk(), null); assert.equal(await docker('ps', '-a', '--filter', 'label=hosty.instance=' + path.basename(dataRoot), '--filter', 'label=hosty.app.service=agent-worker', '--format', '{{.Names}}'), ''); }
async function assertRejectedBeforeTranscript(session, text) {
  const r = await raw('POST', `/api/sessions/${session.id}/messages`, { text, appContextRevision: (await record(session.id)).appContextRevision });
  assert(r.status >= 400, 'Fault was unexpectedly admitted.');
  assert.equal((await events(session.id)).filter(e => e.type === 'user_message' && e.text === text).length, 0);
  return r;
}
async function longTurn(label, attach = false) {
  const s = await newSession('Failure acceptance ' + label, { appIds: attach ? ['hosty.harness'] : [] });
  if (attach) {
    state.tree = await api('POST', `/api/sessions/${s.id}/workspaces`, { action: 'prepare', appId: 'hosty.harness', targetBranch: 'main', requestId: randomUUID() }); await save();
  }
  await api('PUT', `/api/sessions/${s.id}/autonomy`, { autonomy: 'autonomous' });
  const cwd = path.join(root, 'cache/sessions', s.id, 'workspace');
  const ticks = path.join(cwd, 'failure-ticks');
  const pid = path.join(cwd, 'failure-pid');
  const program = `const f=require('fs');f.writeFileSync(${JSON.stringify(pid)},String(process.pid));let n=0;const t=setInterval(()=>{f.appendFileSync(${JSON.stringify(ticks)},'x');if(++n===1500)clearInterval(t)},200)`;
  const command = 'node -e ' + "'" + program.replaceAll("'", "'\\''") + "'";
  await send(s.id, `This is an authorized isolated runtime failure test. Run this exact terminal command in the foreground, wait for it, and do not modify source or call other tools: ${command}`);
  const deadline = Date.now() + 90000;
  while (!(await stat(ticks).catch(() => null))?.size) {
    assert(Date.now() < deadline, 'The bounded writer did not start.');
    const r = await record(s.id); assert(['running', 'awaiting_approval'].includes(r.status), `Writer turn ended ${r.status}.`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const worker = await stateOnDisk();
  let detachedTicks;
  if (worker) {
    detachedTicks = ticks + '-detached';
    const detached = `const f=require('fs');let n=0;const t=setInterval(()=>{f.appendFileSync(${JSON.stringify(detachedTicks)},'x');if(++n===1500)clearInterval(t)},200)`;
    await docker('exec', '-d', worker.name, 'node', '-e', detached);
    const deadline = Date.now() + 10000;
    while (!(await stat(detachedTicks).catch(() => null))?.size) {
      assert(Date.now() < deadline, 'Detached Docker writer did not start.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return { id: s.id, ticks, detachedTicks, pid, worker };
}
async function stable(ticks) { const first = (await stat(ticks)).size; await new Promise(resolve => setTimeout(resolve, 650)); assert.equal((await stat(ticks)).size, first, 'Writer survived verified Docker Stop.'); }
async function recover(w) {
  await api('POST', '/api/runtime/stop', {}); await stable(w.ticks); if (w.detachedTicks) await stable(w.detachedTicks); await noWorker();
  assert.equal((await activeLease(w.worker.generation)).active, false);
}
async function importAuthorizedConnection() {
  const source = process.env.HOSTY_TEST_HARNESS_PROVIDER_SOURCE;
  const id = process.env.HOSTY_TEST_HARNESS_PROVIDER_CONNECTION;
  assert(source && id, 'Explicitly select the already-authorized source Core and Codex connection.');
  const sourceApp = path.join(source, 'apps/hosty.harness');
  const metadata = JSON.parse(await readFile(path.join(sourceApp, 'data/connections.json'), 'utf8'));
  const selected = metadata.connections.find(c => c.id === id);
  assert(selected?.kind === 'codex' && selected.auth === 'chatgpt', 'Select the authorized managed Codex login.');
  const secrets = JSON.parse(await readFile(path.join(sourceApp, 'secrets.json'), 'utf8'));
  const value = secrets.secrets[selected.secretKey]?.value; assert(value, 'Selected authorization is missing.');
  const connection = await api('POST', '/api/connections', { name: 'Production failure acceptance', kind: selected.kind, auth: selected.auth });
  const program = `let t='';for await(const b of process.stdin)t+=b;const x=JSON.parse(t);const r=await fetch(process.env.HOSTY_CORE_ORIGIN+'/api/internal/apps/'+process.env.HOSTY_APP_ID+'/secrets/'+x.key,{method:'PUT',headers:{authorization:'Bearer '+process.env.HOSTY_APP_SERVICE_TOKEN,'content-type':'application/json'},body:JSON.stringify({value:x.value})});if(!r.ok)process.exit(1);`;
  const child = (await import('node:child_process')).spawn('docker', ['exec', '-i', process.env.HOSTY_TEST_COORDINATOR, 'node', '--input-type=module', '-e', program], { env: realDockerEnv, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify({ key: connection.secretKey, value }));
  assert.equal(await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }), 0, 'Authorized credential import failed.');
  state.connection = { id: connection.id, secretKey: connection.secretKey, sourceApp, sourceKey: selected.secretKey, originalHash: hash(value) }; await save();
}
async function cleanupAuthorization() {
  if (!state.connection) return;
  const c = state.connection;
  const sourceFile = path.join(c.sourceApp, 'secrets.json');
  const target = JSON.parse(await readFile(path.join(root, 'secrets.json'), 'utf8'));
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  const renewed = target.secrets[c.secretKey];
  if (!renewed || hash(renewed.value) === c.originalHash || hash(source.secrets[c.sourceKey]?.value ?? '') !== c.originalHash) return;
  source.secrets[c.sourceKey] = renewed;
  const temporary = sourceFile + '.failure-test-' + process.pid;
  await writeFile(temporary, JSON.stringify(source), { mode: 0o600 }); await rename(temporary, sourceFile);
  console.log('Returned renewed authorization to its unchanged source.');
}
async function providerAndScopeChecks() {
  const absent = await newSession('No selected provider', { connectionId: null });
  assert.equal((await assertRejectedBeforeTranscript(absent, 'provider must be configured')).body.code, 'provider_required');
  const unconfigured = await api('POST', '/api/connections', { name: 'Deliberately unsigned test provider', kind: 'codex', auth: 'chatgpt' });
  const invalid = await newSession('Unsigned provider', { connectionId: unconfigured.id });
  assert.equal((await assertRejectedBeforeTranscript(invalid, 'must refuse absent authorization')).body.code, 'provider_reconnect_required');
  const scope = await raw('POST', `/api/sessions/${absent.id}/workspaces`, { action: 'prepare', appId: 'hosty.harness', targetBranch: 'main', requestId: randomUUID() });
  assert.equal(scope.status, 409); assert.equal(scope.body.code, 'workspace_app_required');
  await passed('provider setup and unattached workspace refusal', { noUserMessagePersisted: true });
}
async function budgetCheck() {
  const ids = [];
  try {
    for (let n = 0; n < 3; n++) {
      const id = `hosty.failure-budget-${n}`;
      const manifest = { schemaVersion: 'app.0.1', id, name: 'Disposable failure budget ' + n, version: '0.0.1', runtimeProfiles: [{ key: 'docker', type: 'docker', default: true }], defaultRuntime: 'docker', services: [{ key: 'hold', runtimes: { docker: { type: 'docker', image: 'ghcr.io/alex-de-haas/hosty-agent-worker:0.62.0' } } }] };
      const file = path.join(root, 'cache', 'failure-budget-' + n + '.json'); await writeFile(file, JSON.stringify(manifest));
      await cli('install', file, '--no-autostart'); ids.push(id); await cli('start', id);
    }
    const s = await newSession('Exhausted child budget');
    const rejected = await assertRejectedBeforeTranscript(s, 'must refuse exhausted worker allocation');
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'worker_operation_failed');
    assert.match(rejected.body.message, /environment container resource budget is exhausted/i);
    await noWorker();
    for (const file of await readdir(path.join(dataRoot, 'core/development/worker-leases'))) {
      if (file.endsWith('.json')) assert.equal(JSON.parse(await readFile(path.join(dataRoot, 'core/development/worker-leases', file), 'utf8')).active, false);
    }
    await passed('Core child budget refusal and verified preparation cleanup');
  } finally { for (const id of ids.reverse()) await cli('remove', id, '--delete-data', '--delete-backups'); }
}
async function retainedNativeActivity(w) {
  const workspaces = await api('POST', `/api/sessions/${w.id}/workspaces`, { action: 'list' });
  assert(workspaces.workspaces.some(tree => tree.leases?.length), 'Native stop must retain source activity without descendant proof.');
  // Stop only the bounded test process, after verifying its unique command marker.
  // Source leases stay with Core because this observation is not an adapter acknowledgement.
  const pid = Number(await readFile(w.pid, 'utf8'));
  const command = await execFile('ps', ['-p', String(pid), '-o', 'command=']).then(r => r.stdout, () => '');
  if (command) { assert(command.includes(w.ticks), 'Native test PID identity changed.'); process.kill(pid, 'SIGTERM'); }
  await stable(w.ticks);
}
async function crashLocalCoordinator() {
  const saved = JSON.parse(await readFile(path.join(root, 'run/api.json'), 'utf8'));
  assert.equal(saved.appId, 'hosty.harness'); assert.equal(saved.instanceId, path.basename(dataRoot));
  const port = new URL(origin).port;
  const listeners = (await execFile('lsof', ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'])).stdout.trim().split(/\s+/).map(Number);
  assert.equal(listeners.length, 1); const pid = listeners[0];
  const table = (await execFile('ps', ['-axo', 'pid=,ppid='])).stdout.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  const parents = new Map(table); let current = pid, owned = false;
  for (let n = 0; n < 30 && current > 1; n++) { if (current === saved.pid) { owned = true; break; } current = parents.get(current) ?? 0; }
  assert(owned, 'Listening process is not owned by the test local runner.');
  process.kill(pid, 'SIGKILL');
}
try {
  await fault('none');
  if (stage === 'cleanup') { await cleanupAuthorization(); process.exit(0); }
  state.status = 'running'; await save();
  await providerAndScopeChecks();
  if (stage === 'initial-docker') {
    await importAuthorizedConnection();
    const initial = await newSession('Failure recovery continuity'); state.continuity = initial.id; state.marker = 'FAILURE_' + randomBytes(8).toString('hex'); await save();
    for (const mode of ['worker-image', 'offline']) {
      try {
        await fault(mode);
        const health = await api('GET', '/api/runtime'); assert.equal(health.defaultMode, 'docker'); assert.equal(health.docker.available, false); assert(health.docker.reason);
        await assertRejectedBeforeTranscript(initial, 'must refuse ' + mode);
        if (mode === 'worker-image') assert((await raw('POST', '/api/runtime/image', {})).status >= 400);
        assert.equal(await stateOnDisk(), null);
      } finally { await fault('none'); }
      await passed(mode === 'worker-image' ? 'missing worker image and failed pull' : 'Docker connection loss before dispatch');
    }
    state.providerSession = (await reply(initial.id, `Reply exactly ${state.marker} and remember it. Do not call tools.`, state.marker)).harnessSessionId; await save();
    await budgetCheck();
    const w = await longTurn('busy-and-cancel', true);
    const second = await newSession('Simultaneous refused turn');
    assert.equal((await assertRejectedBeforeTranscript(second, 'must not queue')).body.code, 'worker_busy');
    const actual = JSON.parse(await docker('inspect', w.worker.name))[0];
    assert.equal(actual.HostConfig.Memory, 2147483648); assert.equal(actual.HostConfig.PidsLimit, 256);
    await recover(w);
    await passed('shared admission, bounded resources and cancellation', { noSecondTranscript: true, detachedWriterStopped: true });
    for (const mode of ['offline', 'deny-remove', 'lose-remove-reply']) {
      const current = await longTurn(mode);
      try {
        await fault(mode);
        const stopped = await raw('POST', '/api/runtime/stop', {});
        assert(stopped.status >= 400, 'Uncertain cleanup was reported successful.');
        assert.equal(stopped.body.code, 'worker_operation_failed'); assert(stopped.body.message);
        assert.equal((await stateOnDisk()).generation, current.worker.generation);
        assert.equal((await activeLease(current.worker.generation)).active, true);
        if (mode === 'lose-remove-reply') assert.equal(await docker('ps', '-a', '--filter', 'name=^/' + current.worker.name + '$', '--format', '{{.ID}}'), '');
        if (mode === 'offline') {
          const before = (await stat(current.detachedTicks)).size; await new Promise(resolve => setTimeout(resolve, 650)); assert((await stat(current.detachedTicks)).size > before, 'The upstream writer should survive connection loss.');
        }
      } finally { await fault('none'); }
      await recover(current); await passed('reconcile ' + mode, { retainedGeneration: true, leaseReleasedAfterVerifiedRemoval: true });
    }
  } else if (stage === 'resumed-local') {
    assert.equal((await api('GET', '/api/runtime')).defaultMode, 'native');
    await fault('offline');
    try {
      const r = await reply(state.continuity, 'Reply exactly the FAILURE_ marker from earlier. Do not call tools.', state.marker);
      assert.equal(r.harnessSessionId, state.providerSession);
      await passed('Local provider operation with Docker connection unavailable', { sameProviderSession: true });
    } finally { await fault('none'); }
    const probe = `import {CodexHarnessAdapter} from './apps/harness/src/harness/codex.ts';const r=await new CodexHarnessAdapter({isolated:true}).probe();if(r.available||!r.reason?.includes('could not be started'))process.exit(1);console.log('Missing CLI diagnosed.');`;
    await execFile('node', ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd: process.env.HOSTY_TEST_HARNESS_REPOSITORY, env: { ...process.env, HOSTY_HARNESS_CODEX_COMMAND: path.join(root, 'cache/does-not-exist') }, timeout: 15000 });
    await passed('Local missing provider executable diagnosis');
    const w = await longTurn('native-cancel', true);
    const busy = await assertRejectedBeforeTranscript({id:w.id}, 'must not overlap this conversation');
    assert.equal(busy.status, 409);
    await reply(state.continuity, 'Reply exactly the FAILURE_ marker from earlier. Do not call tools.', state.marker);
    await passed('Local per-conversation admission and independent concurrent chat');
    await api('POST', `/api/sessions/${w.id}/cancel`, {});
    assert.equal((await record(w.id)).status, 'cancelled');
    await retainedNativeActivity(w); await passed('Local cancellation retains unverified source lease');
    const crashed = await longTurn('native-coordinator-crash', true);
    const messages = (await events(crashed.id)).filter(e => e.type === 'user_message').length;
    await crashLocalCoordinator(); await cli('restart', 'hosty.harness'); await refresh();
    assert.equal((await events(crashed.id)).filter(e => e.type === 'user_message').length, messages, 'An uncertain native message was replayed.');
    await retainedNativeActivity(crashed);
    assert.equal((await api('GET', '/api/runtime')).defaultMode, 'native');
    const r = await reply(state.continuity, 'Reply exactly the FAILURE_ marker from earlier. Do not call tools.', state.marker);
    assert.equal(r.harnessSessionId, state.providerSession); await passed('Local coordinator crash during active turn and explicit restart preserve history', { noMessageReplay: true, unverifiedSourceLeaseRetained: true });
  } else if (stage === 'resumed-docker') {
    const before = await reply(state.continuity, 'Reply exactly the FAILURE_ marker from earlier. Do not call tools.', state.marker);
    assert.equal(before.harnessSessionId, state.providerSession);
    const w = await longTurn('coordinator-crash');
    const count = (await events(w.id)).filter(e => e.type === 'user_message').length;
    await docker('kill', process.env.HOSTY_TEST_COORDINATOR);
    const size = (await stat(w.detachedTicks)).size; await new Promise(resolve => setTimeout(resolve, 650)); assert((await stat(w.detachedTicks)).size > size);
    assert.equal((await stateOnDisk()).generation, w.worker.generation);
    await cli('restart', 'hosty.harness'); await refresh();
    assert.equal((await events(w.id)).filter(e => e.type === 'user_message').length, count, 'An uncertain message was replayed.');
    await recover(w); await passed('Docker coordinator crash and explicit recovery', { sameGeneration: true, noMessageReplay: true });
    for (const mode of ['offline', 'worker-image', 'coordinator-image']) {
      await cli('stop', 'hosty.harness');
      try {
        await fault(mode); let failed = false;
        try { await cli('start', 'hosty.harness'); } catch { failed = true; }
        assert(failed, 'Application start unexpectedly succeeded during ' + mode);
        const app = (await core('GET', '/api/apps')).apps.find(a => a.id === 'hosty.harness'); assert.equal(app.selectedRuntime, 'docker');
      } finally { await fault('none'); }
      await cli('start', 'hosty.harness'); await refresh();
      assert.equal((await api('GET', '/api/runtime')).defaultMode, 'docker'); await passed('Core Docker start diagnosis and retry: ' + mode);
    }
    const after = await reply(state.continuity, 'Reply exactly the FAILURE_ marker from earlier. Do not call tools.', state.marker);
    assert.equal(after.harnessSessionId, state.providerSession); await passed('history and authorization survive complete failure matrix');
    state.status = 'passed'; await save();
  }
} catch (error) {
  state.status = 'failed'; state.rows.push({ stage, scenario: 'acceptance', status: 'failed', message: error.message }); await save(); throw error;
} finally { await fault('none'); }

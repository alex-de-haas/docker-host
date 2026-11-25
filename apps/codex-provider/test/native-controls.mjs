import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { zstdDecompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexConnections } from '../src/connections.ts';
import { CodexHarnessAdapter } from '../src/adapter/codex.ts';
import { CodexLogin } from '../src/connections/codex-login.ts';
import { checkContextProtocol } from './codex-context-native.mjs';
import { checkPredictionProtocol } from './codex-prediction-native.mjs';

const installed = process.env.HOSTY_TEST_PROVIDER_INSTALLED_CLI === '1';
test(`${installed ? 'installed' : 'injected fake'} Codex metadata/context/prediction controls submit no model turn`, { timeout: 60000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-controls-'));
  const previous = process.env.HOSTY_HARNESS_CODEX_COMMAND;
  let client;
  try {
    if (!installed) process.env.HOSTY_HARNESS_CODEX_COMMAND = fileURLToPath(new URL('./fake-codex-native-controls.mjs', import.meta.url));
    client = new CodexLogin(home); await client.initialize();
    assert.ok(Array.isArray((await client.request('model/list', { limit: 100, includeHidden: false })).data));
    assert.equal(await client.request('account/rateLimits/read', {}).then(() => 'unexpected', () => 'unavailable'), 'unavailable');
    await client.closeAndWait(); client = undefined;
    await checkPredictionProtocol(home, { fake: !installed });
    await checkContextProtocol(home, { fake: !installed });
    if (!installed) {
      const methods = (await readFile(path.join(home, 'native-control-methods.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
      assert.ok(methods.includes('model/list')); assert.ok(methods.includes('thread/prediction/request'));
      assert.equal(methods.some(method => method === 'turn/start' || method.startsWith('account/login')), false);
    }
  } finally {
    await client?.closeAndWait(); await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.HOSTY_HARNESS_CODEX_COMMAND; else process.env.HOSTY_HARNESS_CODEX_COMMAND = previous;
  }
});


test('installed Codex resumes the exact persisted thread and supplies its retained input to a local model fixture', { skip: !installed, timeout: 20000 }, async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'provider-resume-')), sessionId = randomUUID();
  const home = path.join(data, 'native-sessions', sessionId);
  const marker = 'retained-' + randomUUID(), next = 'new-' + randomUUID();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url?.endsWith('/responses')) {
      const body = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes;
      requests.push(JSON.parse(body.toString()));
    }
    // The local fixture observes the real native model payload; no inference or model account is needed.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'End of local fixture.' } }));
  });
  let seed, resumed;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await mkdir(home, { recursive: true });
    const port = server.address().port;
    await writeFile(path.join(home, 'config.toml'), [
      'model = "fixture-model"', 'model_provider = "fixture"', '[analytics]', 'enabled = false', '[feedback]', 'enabled = false',
      '[model_providers.fixture]', 'name = "Local fixture"', 'wire_api = "responses"',
      'base_url = "http://127.0.0.1:' + port + '/v1"', 'request_max_retries = 0', 'stream_max_retries = 0',
    ].join('\n'));
    seed = new CodexLogin(home); await seed.initialize();
    const started = await seed.request('thread/start', { cwd: home, model: 'fixture-model', sandbox: 'read-only', approvalPolicy: 'never' });
    const id = started.thread.id;
    await seed.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }] });
    await seed.closeAndWait(); seed = undefined;
    const connections = new CodexConnections(data, null, {});
    assert.equal(await connections.inspectNativeContext(sessionId, id), 'available');
    assert.equal(await connections.inspectNativeContext(sessionId, randomUUID()), 'missing');
    const events = [];
    resumed = new CodexHarnessAdapter({ dataDir: data, codexHome: home, isolated: true }).start({
      sessionId, cwd: home, nativeConfigHome: home, nativeHome: home, restrictedHost: true, model: 'fixture-model', reasoningEffort: 'low', requireNativeResume: true,
      resumeHarnessSessionId: id, onEvent: event => events.push(event),
    });
    resumed.send(next);
    const deadline = Date.now() + 8000;
    while (!requests.length && !events.some(e => e.type === 'error') && Date.now() < deadline) await delay(25);
    assert.ok(events.some(e => e.type === 'harness_session' && e.harnessSessionId === id), 'exact native session resumed');
    const toolNames = requests.flatMap(request => (request.tools ?? []).flatMap(tool =>
      [tool.name ?? tool.type, ...(tool.tools ?? []).map(member => member.name)]));
    assert.ok(toolNames.length, 'inspected the actual restricted tool catalog sent to the model');
    assert.ok(!toolNames.some(name => /^(exec_command|write_stdin|shell|local_shell|computer|computer_use|spawn_agent|node_repl|code_mode)$/.test(name)),
      'The restricted catalog contains an unrestricted native tool: ' + toolNames.join(', '));
    assert.ok(requests.some(r => JSON.stringify(r.input).includes(marker) && JSON.stringify(r.input).includes(next)), 'both saved and new input reached local model');
  } finally {
    await seed?.closeAndWait(); await resumed?.stopAndWait();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(data, { recursive: true, force: true });
  }
});

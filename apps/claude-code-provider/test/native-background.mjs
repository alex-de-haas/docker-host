import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerEngine } from '@hosty/agent-provider-runtime/worker/engine';
import { WorkerJournal } from '@hosty/agent-provider-runtime/worker/journal';
import { ClaudeHarnessAdapter } from '../src/adapter/claude.ts';

const installed = process.env.HOSTY_TEST_PROVIDER_INSTALLED_CLI === '1';
const text = value => ({ type: 'text', text: value });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
async function until(check, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail(message);
}
function respond(response, request, content) {
  if (response.destroyed || response.writableEnded) return;
  const stop_reason = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: request.model,
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 20 } };
  if (!request.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 0 } } });
  content.forEach((block, index) => {
    event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {}); response.end();
}

for (const outcome of ['complete', 'cancel']) test(`installed Claude SDK background lifecycle: ${outcome} after prediction disable against local inference fixture`,
  { skip: !installed, timeout: 90000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'provider-claude-background-'));
    const childResponses = new Map(), native = [], stderr = [], requests = [];
    let engine, processClosed = false, rootTurns = 0;
    const server = createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const payload = body ? JSON.parse(body) : {};
        if (!request.url?.startsWith('/v1/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
        const messages = JSON.stringify(payload.messages ?? []);
        const firstUser = payload.messages?.find(message => message.role === 'user');
        const child = JSON.stringify(firstUser?.content ?? '').match(/CHILD_FIXTURE_(one|two|three)/)?.[1];
        requests.push({ child, hasReadResult: child ? messages.includes(`read-${child}`) : undefined, rootTurns });
        if (child) {
          if (!messages.includes(`read-${child}`)) childResponses.set(child, () => respond(response, payload, [call(`read-${child}`, 'Read', { file_path: path.join(home, 'input.txt') })]));
          else respond(response, payload, [text(`child-summary-${child}`)]);
          return;
        }
        if (messages.includes('[SUGGESTION MODE:')) { respond(response, payload, [text('Review the results')]); return; }
        rootTurns++;
        if (rootTurns === 1) {
          respond(response, payload, ['one', 'two', 'three'].map(id => call(`spawn-${id}`, 'Agent', {
            description: `Fixture child ${id}`, subagent_type: 'general-purpose', prompt: `CHILD_FIXTURE_${id}: Read input.txt and summarize.`, run_in_background: true,
          })));
        } else if (['one', 'two', 'three'].every(id => messages.includes(`child-summary-${id}`))) {
          respond(response, payload, [text('Final synthesis after all three children.')]);
        } else respond(response, payload, [text('Waiting for the three research children.')]);
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
    try {
      await writeFile(path.join(home, 'input.txt'), 'Isolated native lifecycle fixture.\n');
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TMPDIR: home,
        ANTHROPIC_API_KEY: 'isolated-local-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
      const transport = { spawn(command, args, options) {
        // The SDK receives only the isolated environment above; retain its added protocol flags.
        const child = spawn(command, args, { cwd: home, env: options.env, stdio: 'pipe', signal: options.signal });
        let pending = '';
        child.stdout.on('data', chunk => { pending += chunk.toString(); let end;
          while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { native.push(JSON.parse(line)); } catch {} }
        });
        child.stderr.on('data', chunk => stderr.push(chunk.toString()));
        child.once('close', () => { processClosed = true; }); return child;
      } };
      const adapter = new ClaudeHarnessAdapter(environment);
      const journal = new WorkerJournal(path.join(home, 'journal')); await journal.initialize();
      engine = new WorkerEngine(journal, { adapter: async () => ({ capabilities: adapter.capabilities, probe: () => adapter.probe(),
        start: options => adapter.start({ ...options, nativeHome: home, processTransport: transport }) }), cwd: async () => home,
        reserve: async () => () => {}, validateSelection: async () => {} }, 1);
      await engine.submit('run', { conversationId: 'chat', operation: 'chat', binding: { connectionId: 'fixture', connectionRevision: 1, harnessKind: 'claude' },
        selection: { model: 'claude-sonnet-4-5', reasoningEffort: null }, resource: { kind: 'conversation', id: 'chat' },
        input: 'Run the isolated fixture.', options: { autonomy: 'autonomous', promptSuggestions: true }, autoAllowedPrefixes: [] });
      await until(() => childResponses.size === 3 && native.some(message => message.type === 'result'),
        'SDK did not yield a root result with three active children');
      await engine.disableSuggestions('run', 'disable-predictions');
      assert.equal(processClosed, false);
      assert.equal((await journal.load('run')).receipt.state, 'running');
      assert.equal((await journal.load('run')).events.some(frame => frame.event.type === 'answer_complete'), false);
      if (outcome === 'cancel') {
        const receipt = await engine.cancel('run', 'explicit-stop');
        assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.exitConfirmed, true); assert.deepEqual(receipt.effects, {});
        assert.equal(processClosed, true);
        assert.equal(native.filter(message => message.type === 'system' && message.subtype === 'task_notification' && message.status === 'stopped').length, 3);
        assert.equal(requests.some(request => request.hasReadResult), false);
        return;
      }
      const releases = [...childResponses.values()]; childResponses.clear(); for (const release of releases) release();
      await until(async () => (await journal.load('run')).receipt.state === 'completed', 'SDK did not complete parent synthesis');
      const record = await journal.load('run');
      assert.equal(processClosed, true); assert.equal(record.receipt.exitConfirmed, true); assert.deepEqual(record.receipt.effects, {});
      assert.equal(native.filter(message => message.type === 'system' && message.subtype === 'task_started' && message.task_type === 'local_agent').length, 3);
      const nativeHome = await realpath(home);
      assert.ok(native.filter(message => message.subtype === 'task_notification').every(message => message.output_file.startsWith(nativeHome + path.sep)));
      assert.equal(record.events.filter(frame => frame.event.type === 'agent_status' && frame.event.state === 'succeeded').length, 3);
      assert.ok(native.some(message => message.type === 'result' && message.result === 'Final synthesis after all three children.'));
      // The CLI sends this only for the SDK host; the public SDK iterator filters it.
      assert.ok(native.some(message => message.subtype === 'session_state_changed' && message.state === 'idle' && message.sdk_host_only === true));
      assert.equal(record.events.filter(frame => frame.event.type === 'result' && !frame.event.source).length, 1);
      assert.ok(record.events.some(frame => frame.event.type === 'assistant_text' && frame.event.text === 'Final synthesis after all three children.'));
      assert.equal(record.events.filter(frame => frame.event.type === 'tool_result' && frame.event.source && frame.event.status === 'completed').length, 3);
    } catch (error) {
      console.error(JSON.stringify({ requests, native: native.map(({ type, subtype, state, status, task_id, task_type, parent_tool_use_id, result }) => ({ type, subtype, state, status, task_id, task_type, parent_tool_use_id, result })), stderr }));
      throw error;
    } finally {
      const releases = [...childResponses.values()]; childResponses.clear(); for (const release of releases) release();
      await engine?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });

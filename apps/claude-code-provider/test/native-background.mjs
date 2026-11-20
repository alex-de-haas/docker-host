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

for (const outcome of ['complete', 'cancel', 'queued-disabled', 'queued-enabled', 'queued-cancel-disabled', 'queued-cancel-enabled']) test(`installed Claude SDK background lifecycle: ${outcome} against local inference fixture`,
  { skip: !installed, timeout: 90000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'provider-claude-background-'));
    const childResponses = new Map(), native = [], stderr = [], requests = [], completionBoundaries = [];
    const queuedContinuation = outcome.startsWith('queued-');
    const finalText = queuedContinuation ? 'FINAL_QUEUED_PARENT_SYNTHESIS: one; two; three.' : 'Final synthesis after all three children.';
    const intermediateText = 'Intermediate parent answer before queued child notifications.';
    let engine, processClosed = false, rootTurns = 0, intermediateResponse, finalResponse;
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
          if (queuedContinuation) finalResponse = () => respond(response, payload, [text(finalText)]);
          else respond(response, payload, [text(finalText)]);
        } else if (queuedContinuation && messages.includes('child-summary-one')) {
          // Keep one parent model request in flight while the other children finish. Their
          // notifications enter the native queue after this request's input was assembled.
          intermediateResponse = () => respond(response, payload, [text(intermediateText)]);
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
      const update = journal.update.bind(journal);
      journal.update = async (...args) => {
        if (args[1] === 'completed') completionBoundaries.push(native.length);
        return update(...args);
      };
      engine = new WorkerEngine(journal, { adapter: async () => ({ capabilities: adapter.capabilities, probe: () => adapter.probe(),
        start: options => adapter.start({ ...options, nativeHome: home, processTransport: transport }) }), cwd: async () => home,
        reserve: async () => () => {}, validateSelection: async () => {} }, 1);
      await engine.submit('run', { conversationId: 'chat', operation: 'chat', binding: { connectionId: 'fixture', connectionRevision: 1, harnessKind: 'claude' },
        selection: { model: 'claude-sonnet-4-5', reasoningEffort: null }, resource: { kind: 'conversation', id: 'chat' },
        input: 'Run the isolated fixture.', options: { autonomy: 'autonomous', promptSuggestions: true }, autoAllowedPrefixes: [] });
      await until(() => childResponses.size === 3 && native.some(message => message.type === 'result'),
        'SDK did not yield a root result with three active children');
      if (!outcome.endsWith('-enabled')) await engine.disableSuggestions('run', 'disable-predictions');
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
      if (queuedContinuation) {
        const first = childResponses.get('one'); childResponses.delete('one'); first();
        await until(() => intermediateResponse, 'SDK did not start the first child-notification parent turn');
        const remaining = [...childResponses.values()]; childResponses.clear(); for (const release of remaining) release();
        await until(() => native.filter(message => message.subtype === 'task_notification' && message.status === 'completed').length === 3
          && native.findLast(message => message.subtype === 'background_tasks_changed')?.tasks.length === 0,
        'SDK did not finish the children while the parent request remained in flight');
        intermediateResponse(); intermediateResponse = undefined;
        await until(async () => finalResponse || ['suggesting', 'completed', 'failed', 'interrupted'].includes((await journal.load('run')).receipt.state),
          'SDK did not request synthesis from the queued child notifications');
        const pending = await journal.load('run');
        assert.equal(pending.receipt.state, 'running', 'An interim result completed the provider before queued parent notifications were synthesized');
        assert.equal(processClosed, false);
        assert.equal(pending.events.some(frame => frame.event.type === 'answer_complete' || frame.event.type === 'result' && !frame.event.source), false);
        assert.ok(finalResponse, 'The final synthesis request must remain live after the interim result');
        assert.ok(native.some(message => message.type === 'result' && message.result === intermediateText && message.num_turns > 0),
          'The race must include a substantive interim root result after the agent inventory drains');
        if (outcome.startsWith('queued-cancel-')) {
          const receipt = await engine.cancel('run', 'stop-queued-parent');
          const stopped = await journal.load('run');
          assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.exitConfirmed, true); assert.deepEqual(receipt.effects, {});
          assert.equal(processClosed, true);
          assert.equal(stopped.events.filter(frame => frame.event.type === 'agent_status' && frame.event.state === 'succeeded').length, 3);
          assert.equal(stopped.events.some(frame => frame.event.type === 'assistant_text' && frame.event.text === finalText), false);
          assert.equal(stopped.events.some(frame => frame.event.type === 'answer_complete' || frame.event.type === 'result' && !frame.event.source), false);
          assert.deepEqual(completionBoundaries, []);
          return;
        }
        finalResponse(); finalResponse = undefined;
      } else {
        const releases = [...childResponses.values()]; childResponses.clear(); for (const release of releases) release();
      }
      await until(async () => (await journal.load('run')).receipt.state === 'completed', 'SDK did not complete parent synthesis');
      const record = await journal.load('run');
      assert.equal(processClosed, true); assert.equal(record.receipt.exitConfirmed, true); assert.deepEqual(record.receipt.effects, {});
      assert.equal(native.filter(message => message.type === 'system' && message.subtype === 'task_started' && message.task_type === 'local_agent').length, 3);
      const nativeHome = await realpath(home);
      assert.ok(native.filter(message => message.subtype === 'task_notification').every(message => message.output_file.startsWith(nativeHome + path.sep)));
      assert.equal(record.events.filter(frame => frame.event.type === 'agent_status' && frame.event.state === 'succeeded').length, 3);
      const finalIndex = native.findIndex(message => message.type === 'result' && message.result === finalText);
      assert.ok(finalIndex >= 0, 'Native final synthesis was not delivered');
      // The CLI sends this only for the SDK host; the public SDK iterator filters it.
      const idleIndex = native.findIndex((message, index) => index > finalIndex && message.subtype === 'session_state_changed'
        && message.state === 'idle' && message.sdk_host_only === true);
      assert.ok(idleIndex > finalIndex, 'The real SDK must emit its hidden idle boundary after final synthesis');
      assert.equal(completionBoundaries.length, 1);
      assert.ok(completionBoundaries[0] > idleIndex, 'Provider completion must follow the native final-result/idle boundary');
      assert.equal(record.events.filter(frame => frame.event.type === 'result' && !frame.event.source).length, 1);
      const finalFrames = record.events.filter(frame => frame.event.type === 'assistant_text' && frame.event.text === finalText);
      assert.equal(finalFrames.length, 1, 'The public transcript must retain exactly one final parent synthesis');
      assert.ok(record.events.find(frame => frame.event.type === 'result' && !frame.event.source).sequence > finalFrames[0].sequence,
        'The public terminal result must follow the final parent synthesis');
      assert.equal(record.events.filter(frame => frame.event.type === 'tool_result' && frame.event.source && frame.event.status === 'completed').length, 3);
    } catch (error) {
      console.error(JSON.stringify({ requests, native: native.filter(message => message.type === 'result' || message.type === 'system'
        && ['session_state_changed', 'task_started', 'task_notification', 'background_tasks_changed'].includes(message.subtype))
        .map(({ type, subtype, state, status, task_id, task_type, parent_tool_use_id, result, num_turns, sdk_host_only, uuid, tasks }) =>
          ({ type, subtype, state, status, task_id, task_type, parent_tool_use_id, result, num_turns, sdk_host_only, uuid, backgroundCount: tasks?.length })), stderr }));
      throw error;
    } finally {
      const releases = [...childResponses.values()]; childResponses.clear(); for (const release of releases) release();
      intermediateResponse?.(); finalResponse?.();
      await engine?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });

for (const outcome of ['nested-disabled', 'nested-enabled', 'nested-cancel-disabled', 'nested-cancel-enabled'])
  test(`installed Claude SDK background lifecycle: ${outcome} against local inference fixture`,
    { skip: !installed, timeout: 90000 }, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'provider-claude-nested-'));
      const native = [], stderr = [], completionBoundaries = [], requests = [];
      const commandResponses = new Map(), childResponses = new Map(), expectedReads = new Map(), verified = new Set(), disconnectedCommands = new Set();
      const finalText = 'FINAL_NESTED_SYNTHESIS: COMMAND-one; COMMAND-two; COMMAND-three.';
      const waitingText = 'WAITING_FOR_NESTED_COMMAND_OUTPUT';
      let engine, journal, processClosed = false, rootTurns = 0, finalResponse;
      const server = createServer(async (request, response) => {
        try {
          const command = request.url?.match(/^\/command\/(one|two|three)$/)?.[1];
          if (command) {
            response.once('close', () => disconnectedCommands.add(command));
            commandResponses.set(command, () => response.end(`COMMAND-${command}\n`)); return;
          }
          let body = ''; for await (const chunk of request) body += chunk;
          const payload = body ? JSON.parse(body) : {};
          if (!request.url?.startsWith('/v1/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
          const messages = JSON.stringify(payload.messages ?? []);
          const firstUser = payload.messages?.find(message => message.role === 'user');
          const child = JSON.stringify(firstUser?.content ?? '').match(/CHILD_FIXTURE_(one|two|three)/)?.[1];
          const results = (payload.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
          requests.push({ child: child ?? 'root', rootTurns });
          for (const result of results) if (expectedReads.has(result.tool_use_id)) {
            assert.notEqual(result.is_error, true, 'The native output Read must succeed');
            const markers = JSON.stringify(result.content).match(/COMMAND-(one|two|three)/g) ?? [];
            assert.equal(new Set(markers).size, 1, 'The real command output must contain exactly its own marker');
            verified.add(markers[0].slice('COMMAND-'.length));
          }
          // Read only a native completed Bash notification that reached this model request.
          // Agent transcript paths can contain command text and do not prove execution.
          const bashTasks = new Set(native.filter(message => message.subtype === 'task_started' && message.task_type === 'local_bash').map(message => message.task_id));
          const notifications = native.filter(message => message.subtype === 'task_notification' && message.status === 'completed'
            && bashTasks.has(message.task_id) && typeof message.output_file === 'string' && messages.includes(message.output_file));
          const reads = [];
          for (const notification of notifications) {
            const id = `read-output-${notification.task_id}`;
            if (results.some(result => result.tool_use_id === id)) continue;
            assert.ok(notification.output_file.startsWith(await realpath(home) + path.sep), 'Native output must stay in isolated HOME');
            expectedReads.set(id, notification.output_file);
            reads.push(call(id, 'Read', { file_path: notification.output_file, limit: 10 }));
          }
          if (reads.length) { respond(response, payload, reads); return; }
          if (child) {
            if (verified.has(child)) { respond(response, payload, [text(`VERIFIED_CHILD_${child}`)]); return; }
            if (!results.some(result => result.tool_use_id === `bash-${child}`)) {
              const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
              respond(response, payload, [call(`bash-${child}`, 'Bash', { command: `${quote(process.execPath)} ${quote(path.join(home, 'command.mjs'))} ${child}`,
                run_in_background: true, description: `Fixture command ${child} waits for the explicit release gate` })]);
            } else childResponses.set(child, () => respond(response, payload, [text(`CHILD_WAIT_${child}`)]));
            return;
          }
          if (messages.includes('[SUGGESTION MODE:')) { respond(response, payload, [text('Review the verified results')]); return; }
          if (++rootTurns === 1) {
            respond(response, payload, ['one', 'two', 'three'].map(id => call(`spawn-${id}`, 'Agent', { description: `Nested fixture ${id}`,
              subagent_type: 'general-purpose', run_in_background: true,
              prompt: `CHILD_FIXTURE_${id}: Start the background command, wait for its notification, and Read its exact output file before returning a verified marker.` })));
          } else if (verified.size === 3 && ['one', 'two', 'three'].every(id => messages.includes(`VERIFIED_CHILD_${id}`))) finalResponse = () => respond(response, payload, [text(finalText)]);
          else respond(response, payload, [text(waitingText)]);
        } catch (error) { response.writeHead(500); response.end(String(error)); }
      });
      try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        // A real command owns each HTTP request. Keeping its response open holds the Bash
        // process without relying on sleep duration or model/network scheduling.
        await writeFile(path.join(home, 'command.mjs'), `const response = await fetch('http://127.0.0.1:${server.address().port}/command/' + process.argv[2], { signal: AbortSignal.timeout(45000) });\nprocess.stdout.write(await response.text());\n`);
        const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TMPDIR: home,
          ANTHROPIC_API_KEY: 'isolated-local-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
        const transport = { spawn(command, args, options) {
          const child = spawn(command, args, { cwd: home, env: options.env, stdio: 'pipe', signal: options.signal });
          let pending = '';
          child.stdout.on('data', chunk => { pending += chunk.toString(); let end;
            while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { native.push(JSON.parse(line)); } catch {} }
          });
          child.stderr.on('data', chunk => stderr.push(chunk.toString()));
          child.once('close', () => { processClosed = true; }); return child;
        } };
        const adapter = new ClaudeHarnessAdapter(environment);
        journal = new WorkerJournal(path.join(home, 'journal')); await journal.initialize();
        const update = journal.update.bind(journal);
        journal.update = async (...args) => { if (args[1] === 'completed') completionBoundaries.push(native.length); return update(...args); };
        engine = new WorkerEngine(journal, { adapter: async () => ({ capabilities: adapter.capabilities, probe: () => adapter.probe(),
          start: options => adapter.start({ ...options, nativeHome: home, processTransport: transport }) }), cwd: async () => home,
          reserve: async () => () => {}, validateSelection: async () => {} }, 1);
        await engine.submit('run', { conversationId: 'chat', operation: 'chat', binding: { connectionId: 'fixture', connectionRevision: 1, harnessKind: 'claude' },
          selection: { model: 'claude-sonnet-4-5', reasoningEffort: null }, resource: { kind: 'conversation', id: 'chat' },
          input: 'Run the isolated nested fixture.', options: { autonomy: 'autonomous', promptSuggestions: true }, autoAllowedPrefixes: [] });
        await until(() => commandResponses.size === 3 && childResponses.size === 3 && native.some(message => message.type === 'result'),
          'Three children did not start their actual background commands');
        if (!outcome.endsWith('-enabled')) await engine.disableSuggestions('run', 'disable-predictions');
        const bashTasks = native.filter(message => message.subtype === 'task_started' && message.task_type === 'local_bash');
        const agentTasks = native.filter(message => message.subtype === 'task_started' && message.task_type === 'local_agent');
        const bashOutcomes = (record, status) => {
          const calls = record.events.filter(({ event }) => event.type === 'tool_use' && event.toolName === 'Bash');
          assert.equal(calls.length, 3);
          for (const { event: call } of calls) {
            assert.ok(call.source?.parentToolCallId, 'The command must belong to its exact native subagent');
            const results = record.events.flatMap(({ event }) => event.type === 'command_result' && event.toolUseId === call.toolUseId ? [event] : []);
            assert.equal(results.length, status ? 1 : 0, 'The background launch must not be recorded as a command terminal');
            if (status) {
              assert.deepEqual(results[0].source, call.source);
              assert.equal(results[0].status, status);
            }
            assert.ok(!record.events.some(({ event }) => event.type === 'tool_result' && event.toolUseId === call.toolUseId),
              'The background launch receipt and notification are not command output');
          }
        };
        assert.equal(bashTasks.length, 3); assert.equal(agentTasks.length, 3);
        assert.ok(bashTasks.every(task => agentTasks.some(agent => agent.task_id === task.parent_task_id)), 'Bash tasks must retain their actual native agent parents');
        if (outcome.startsWith('nested-cancel-')) {
          const receipt = await engine.cancel('run', 'stop-active-descendants');
          const stopped = await journal.load('run');
          assert.equal(receipt.state, 'cancelled'); assert.equal(receipt.exitConfirmed, true); assert.deepEqual(receipt.effects, {});
          assert.equal(processClosed, true); assert.equal(verified.size, 0);
          await until(() => disconnectedCommands.size === 3, 'Cancelled command processes must close their actual unreleased HTTP requests');
          for (const task of [...agentTasks, ...bashTasks]) assert.ok(native.some(message => message.subtype === 'task_notification'
            && message.task_id === task.task_id && message.status === 'stopped'), 'Cancellation must stop every actual child and command');
          assert.equal(stopped.events.some(frame => frame.event.type === 'assistant_text' && frame.event.text === finalText), false);
          assert.equal(stopped.events.some(frame => frame.event.type === 'answer_complete' || frame.event.type === 'result' && !frame.event.source), false);
          assert.deepEqual(completionBoundaries, []);
          bashOutcomes(stopped, 'cancelled');
          return;
        }
        for (const release of childResponses.values()) release(); childResponses.clear();
        await until(async () => native.some(message => message.subtype === 'session_state_changed' && message.state === 'idle')
          && native.some(message => message.subtype === 'background_tasks_changed' && message.tasks.length === 3
            && message.tasks.every(task => task.task_type === 'local_bash'))
          && agentTasks.every(task => native.some(message => message.subtype === 'task_notification' && message.task_id === task.task_id && message.status === 'completed'))
          && (await journal.load('run')).events.filter(frame => frame.event.type === 'agent_status' && frame.event.state === 'succeeded').length === 3,
        'The fixture must expose native idle after agents finish while their Bash descendants remain active');
        const earlyIdleIndex = native.findIndex(message => message.subtype === 'session_state_changed' && message.state === 'idle');
        const withDescendants = await journal.load('run');
        assert.equal(withDescendants.receipt.state, 'running', 'Native idle must not complete the provider while descendant commands remain active');
        assert.equal(processClosed, false);
        bashOutcomes(withDescendants);
        assert.ok(withDescendants.events.filter(frame => frame.event.type === 'agent_status' && frame.event.state === 'succeeded')
          .every(frame => frame.event.stopConfirmed === false), 'Native agent completion does not confirm its descendant commands stopped');
        assert.equal(withDescendants.events.some(frame => frame.event.type === 'answer_complete' || frame.event.type === 'result' && !frame.event.source), false);
        for (const release of commandResponses.values()) release(); commandResponses.clear();
        await until(async () => finalResponse || ['suggesting', 'completed', 'failed', 'interrupted'].includes((await journal.load('run')).receipt.state),
          'SDK did not request synthesis after the actual descendant output was read');
        const awaitingSynthesis = await journal.load('run');
        assert.equal(awaitingSynthesis.receipt.state, 'running', 'The earlier idle/result must not become completion when descendant inventory drains');
        assert.equal(processClosed, false); assert.ok(finalResponse);
        assert.deepEqual([...verified].sort(), ['one', 'three', 'two']);
        assert.equal(native.findLast(message => message.subtype === 'background_tasks_changed').tasks.length, 0);
        assert.equal(awaitingSynthesis.events.some(frame => frame.event.type === 'answer_complete' || frame.event.type === 'result' && !frame.event.source), false);
        finalResponse(); finalResponse = undefined;
        await until(async () => ['completed', 'failed', 'interrupted'].includes((await journal.load('run')).receipt.state), 'Nested continuation did not terminate');
        const record = await journal.load('run');
        assert.deepEqual([...verified].sort(), ['one', 'three', 'two'], 'All three real command markers must be read before completion');
        assert.equal(record.receipt.state, 'completed'); assert.equal(record.receipt.exitConfirmed, true); assert.deepEqual(record.receipt.effects, {});
        assert.equal(processClosed, true);
        for (const task of bashTasks) assert.ok(native.some(message => message.subtype === 'task_notification' && message.task_id === task.task_id && message.status === 'completed'));
        bashOutcomes(record, 'completed');
        const finalFrames = record.events.filter(frame => frame.event.type === 'assistant_text' && frame.event.text === finalText);
        const results = record.events.filter(frame => frame.event.type === 'result' && !frame.event.source);
        assert.equal(finalFrames.length, 1, 'The public nested final synthesis must appear exactly once'); assert.equal(results.length, 1);
        assert.ok(results[0].sequence > finalFrames[0].sequence, 'Public completion must follow verified final synthesis');
        const finalIndex = native.findIndex(message => message.type === 'result' && message.result === finalText);
        const finalIdleIndex = native.findIndex((message, index) => index > finalIndex && message.subtype === 'session_state_changed' && message.state === 'idle');
        assert.ok(finalIndex > earlyIdleIndex); assert.ok(finalIdleIndex > finalIndex);
        assert.equal(completionBoundaries.length, 1); assert.ok(completionBoundaries[0] > finalIdleIndex);
      } catch (error) {
        console.error(JSON.stringify({ outcome, verified: [...verified], requests, native: native.filter(message => message.type === 'result'
          || message.type === 'system' && ['session_state_changed', 'task_started', 'task_notification', 'background_tasks_changed'].includes(message.subtype))
          .map(({ type, subtype, state, status, task_id, task_type, parent_task_id, result, tasks }) => ({ type, subtype, state, status, task_id, task_type,
            parent_task_id, result, tasks: tasks?.map(({ task_id, task_type, parent_task_id }) => ({ task_id, task_type, parent_task_id })) })), stderr }));
        throw error;
      } finally {
        for (const release of childResponses.values()) release();
        for (const release of commandResponses.values()) release();
        finalResponse?.();
        await engine?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await rm(home, { recursive: true, force: true });
      }
    });

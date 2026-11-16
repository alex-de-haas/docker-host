// Disposable native process/tool fixture; no provider account or model inference is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { TrackedNativeProcesses } from '@hosty/agent-provider-runtime/tracked-process';
import { trackedAdapter } from '@hosty/agent-provider-runtime/tracked-adapter';
const processGroups = process.platform !== 'win32';
const wait = async predicate => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Native fixture condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
test('runs Ollama tools through provider-owned native processes without provider credentials', { skip: !processGroups, timeout: 20000 }, async () => {
  const { OllamaExecutor } = await import('../src/adapter/executor.ts');
  const { OllamaHarnessAdapter } = await import('../src/adapter/index.ts');
  const { OllamaClient } = await import('../src/adapter/client.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-ollama-'));
  let processes, executor, run;
  try {
    const cwd = path.join(root, 'work'); await mkdir(cwd);
    processes = await TrackedNativeProcesses.create(root, randomUUID(), randomUUID());
    executor = new OllamaExecutor(cwd, processes.transport);
    const result = await executor.execute('run_command', { command: 'id -u; test -z "$HOSTY_CORE_TOKEN$OPENAI_API_KEY$ANTHROPIC_API_KEY"' }, new AbortController().signal);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.exitCode, 0);
    assert.equal(Number(result.result.output.trim()), process.getuid());
    assert.equal((await executor.execute('apply_patch', { path: 'owned.txt', old_text: '', new_text: 'owned' }, new AbortController().signal, 'missing')).ok, true);
    assert.equal((await stat(path.join(cwd, 'owned.txt'))).uid, process.getuid());
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    let step = 0;
    const client = new OllamaClient('http://fixture.invalid', async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture:latest' }] });
      if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools'], model_info: { 'fixture.context_length': 32768 } });
      const message = step++ === 0 ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'id -u; git status --porcelain' } } }] }
        : { role: 'assistant', content: 'Observed fixture execution' };
      return new Response(JSON.stringify({ model: 'fixture:latest', message, done: true }) + '\n');
    });
    const adapter = trackedAdapter(new OllamaHarnessAdapter({ url: 'http://fixture.invalid', directory: path.join(root, 'state'), client }), processes);
    const events = []; run = adapter.start({ cwd, sessionId: 'native-fixture', autonomy: 'autonomous', nativeHome: root, onEvent: event => events.push(event) });
    run.send('Run the fixture command'); await wait(() => events.some(event => event.type === 'result' || event.type === 'error'));
    assert.ok(events.some(event => event.type === 'result'), JSON.stringify(events));
    assert.ok(events.some(event => event.type === 'command_result' && event.exitCode === 0));
    assert.ok(events.some(event => event.type === 'tool_result' && event.output.includes(String(process.getuid()))));
    await run.stopAndWait(); run = undefined;
    assert.equal((await processes.evidence()).stopped, true);
  } finally { await run?.stopAndWait(); await executor?.close(); await processes?.stop(); await rm(root, { recursive: true, force: true }); }
});

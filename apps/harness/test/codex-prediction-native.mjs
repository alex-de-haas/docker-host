import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolveCodexCommand, isNodeEntry } from '../src/harness/codex-binary.ts';
import { cleanAgentEnvironment } from '../src/connections/codex-login.ts';

/** Check negotiation against the installed binary without credentials, a thread, or inference. */
export async function checkPredictionProtocol(home) {
  const command = resolveCodexCommand();
  const child = spawn(isNodeEntry(command) ? process.execPath : command, [...(isNodeEntry(command) ? [command] : []), 'app-server'],
    { env: { ...cleanAgentEnvironment(), CODEX_HOME: home }, stdio: 'pipe' });
  child.stderr.resume(); let buffer = '', sequence = 0; const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const value = JSON.parse(line); const callback = pending.get(value.id); if (callback) { pending.delete(value.id); callback(value); } } catch { /* Native diagnostics are not protocol responses. */ }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native prediction contract probe timed out')); }, 10000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'hosty-native-prediction-check', version: '1' }, capabilities: { experimentalApi: true } });
    assert.ok(initialized.result?.userAgent); assert.equal(initialized.error, undefined);
    const result = await request('thread/prediction/request', { threadId: randomUUID(), sourceTurnId: randomUUID() });
    assert.ok(result.error, 'A nonexistent source thread must not generate a prediction');
    assert.notEqual(result.error.code, -32700, 'Prediction request must be valid JSON-RPC');
    console.log(result.error.code === -32601 ? 'Codex native prediction method currently unavailable; automatic detection receives -32601.'
      : 'Codex native prediction method responded for a nonexistent source; account eligibility remains untested.');
  } finally {
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer);
  }
}

// A credential-free control-only Codex peer. Model turn admission is deliberately rejected.
import readline from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (process.argv[2] !== 'app-server' || !process.env.CODEX_HOME) throw new Error('The control fixture requires an isolated CODEX_HOME.');
const children = new Set();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
readline.createInterface({ input: process.stdin }).on('line', line => { void handle(JSON.parse(line)).catch(() => { process.exitCode = 1; process.stdin.destroy(); }); });
async function handle(request) {
  appendFileSync(path.join(process.env.CODEX_HOME, 'native-control-methods.ndjson'), JSON.stringify({ method: request.method }) + '\n');
  if (request.id === undefined) return;
  if (request.method === 'initialize') return reply(request.id, { userAgent: 'hosty-control-only-fixture' });
  if (request.method === 'model/list') return reply(request.id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [] }], nextCursor: null });
  if (request.method === 'account/read') return reply(request.id, { account: null });
  if (request.method === 'account/rateLimits/read') return failure(request.id, -32000, 'No fixture account is configured.');
  if (request.method === 'thread/prediction/request') return failure(request.id, -32000, 'The fixture source thread does not exist.');
  if (request.method === 'thread/start') {
    if (request.params?.ephemeral !== true || request.params?.sandbox !== 'read-only' || request.params?.approvalPolicy !== 'never')
      return failure(request.id, -32602, 'The control fixture permits only an ephemeral read-only metadata thread.');
    return reply(request.id, { thread: { id: 'metadata-thread' } });
  }
  if (request.method === 'mcpServerStatus/list') {
    const configuration = readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    const command = JSON.parse(/^command = (.+)$/m.exec(configuration)[1]), args = JSON.parse(/^args = (.+)$/m.exec(configuration)[1]);
    const child = spawn(command, args, { cwd: process.env.CODEX_HOME, env: { PATH: process.env.PATH, HOME: process.env.CODEX_HOME }, stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    let sequence = 0, buffer = ''; const pending = new Map();
    child.stdout.on('data', data => { buffer += data; for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); const accept = pending.get(value.id);
      if (accept) { pending.delete(value.id); accept(value.result); }
    } });
    const call = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      const catalog = await call('tools/list', {});
      reply(request.id, { data: [{ name: 'context_fixture', runtimeStatus: 'connected', tools: Object.fromEntries(catalog.tools.map(tool => [tool.name, tool])) }], nextCursor: null });
    } finally { const exited = once(child, 'close'); child.kill('SIGTERM'); await exited; children.delete(child); }
    return;
  }
  return failure(request.id, -32601, 'Model inference and unsupported controls are unavailable in this fixture.');
}
process.on('SIGTERM', () => { for (const child of children) child.kill('SIGTERM'); process.exit(0); });

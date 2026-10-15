// Experimental Core-managed Harness launcher. Production source is imported unchanged.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const [root, repo] = process.argv.slice(2);
if (!root || !repo) throw new Error('Supply the experiment root and source repository.');
const coordinator = path.join(root, 'coordinator');
const cache = path.join(root, 'agent-data/cache');
await mkdir(cache, { recursive: true });
await writeFile(path.join(coordinator, 'harness.json'), JSON.stringify({ port: Number(process.env.HOSTY_PORT_HTTP), launcherPid: process.pid }), { mode: 0o600 });
const allowed = new Set(['prepare', 'list', 'status', 'diff']);
const bridge = createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const config = JSON.parse(await readFile(path.join(coordinator, 'bridge.json'), 'utf8'));
    const expected = `Bearer ${config.token}`;
    const actual = req.headers.authorization ?? '';
    if (req.method !== 'POST' || req.url !== config.path || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return send(403, { error: 'Experiment route denied' });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) return send(413, {}); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks));
    if (!['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(body.method)) return send(403, {});
    if (body.method === 'tools/call') {
      const input = body.params?.arguments ?? {};
      const runtime = JSON.parse(await readFile(path.join(coordinator, 'runtime.json'), 'utf8'));
      if (!allowed.has(body.params?.name) || (input.appId && input.appId !== 'com.haas.demo-app') || (input.workspaceId && input.workspaceId !== runtime.workspaceId)) return send(403, { error: 'Experiment operation denied' });
    }
    const response = await fetch(`http://127.0.0.1:${process.env.HOSTY_PORT_HTTP}${config.path}`, {
      method: 'POST', headers: { authorization: expected, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    if (response.status === 202) { res.writeHead(202); res.end(); return; }
    const result = await response.json();
    if (body.method === 'tools/list' && result.result?.tools) result.result.tools = result.result.tools.filter(t => allowed.has(t.name));
    send(response.status, result);
  } catch { send(503, { error: 'Experiment bridge unavailable' }); }
});
bridge.listen(37072, '0.0.0.0');
const child = spawn(process.execPath, [path.join(repo, 'node_modules/tsx/dist/cli.mjs'), path.join(repo, 'apps/harness/src/main.ts')], {
  cwd: path.join(repo, 'apps/harness'), stdio: 'inherit',
  env: { ...process.env, HOSTY_APP_CACHE_DIR: cache, HOSTY_HARNESS_HARNESS: 'codex', CODEX_HOME: path.join(root, 'agent-data/codex'), HOSTY_HARNESS_CODEX_COMMAND: path.join(coordinator, 'codex-command') },
});
await writeFile(path.join(coordinator, 'processes.json'), JSON.stringify({ launcherPid: process.pid, harnessPid: child.pid }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { bridge.close(); child.kill(signal); });
child.on('exit', code => { bridge.close(); process.exit(code ?? 1); });

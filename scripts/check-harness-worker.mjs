// Run with: node --import tsx scripts/check-harness-worker.mjs
// Requires the locally built release-matching image. No credentials or model turns are used.
import { mkdir, writeFile, rm, stat, mkdtemp, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SharedDockerWorker } from '../apps/harness/src/runtime/worker.ts';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hosty-worker-check-')));
const trees = path.join(root, 'development/trees');
const repositories = path.join(root, 'development/repositories');
const cwd = path.join(root, 'session');
for (const dir of [trees, repositories, cwd]) await mkdir(dir, { recursive: true });
await writeFile(path.join(repositories, 'metadata'), 'unchanged');
const makeWorker = () => new SharedDockerWorker(path.join(root, 'data'), path.join(root, 'cache'));
let worker = makeWorker();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const output = {};
try {
  worker.claim('transport-probe');
  const started = Date.now();
  const transport = await worker.prepare('transport-probe', randomUUID(), {
    instanceId: '1'.repeat(64), installationId: '2'.repeat(64),
    treesRoot: trees, repositoriesRoot: repositories, worktreePaths: [],
  }, cwd, [], async () => {});
  output.workerStartMs = Date.now() - started;
  for (const provider of ['codex', 'claude']) {
    output[provider] = await new Promise((resolve, reject) => {
      const child = transport.spawn(provider, ['--version'], { cwd, env: {} });
      let result = '';
      child.stdout.on('data', bytes => { result += bytes; });
      child.stderr.on('data', bytes => { result += bytes; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(result.trim()) : reject(new Error(result)));
      child.stdin.end();
    });
  }
  // Exercise the actual SDK control protocol without submitting a prompt or spending tokens.
  let finishInput, timeout;
  const input = (async function* () { await new Promise(resolve => { finishInput = resolve; }); })();
  const sdk = query({ prompt: input, options: {
    cwd, env: { CLAUDE_CONFIG_DIR: path.join(cwd, 'claude') }, settingSources: [],
    pathToClaudeCodeExecutable: '/opt/hosty-worker/claude',
    spawnClaudeCodeProcess: args => transport.spawn('claude', args.args, { cwd: args.cwd ?? cwd, env: args.env }),
  } });
  try {
    const initialized = await Promise.race([sdk.initializationResult(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Claude SDK initialization timed out')), 30_000);
    })]);
    assert.ok(initialized);
    output.claudeSdkInitialized = true;
  } finally { clearTimeout(timeout); finishInput?.(); sdk.close(); }

  const name = worker.current.name;
  output.metadataReadOnly = docker('exec', name, 'sh', '-c',
    'if (echo damage > "$1") 2>/dev/null; then exit 1; else echo refused; fi', 'probe', path.join(repositories, 'metadata'));
  output.dockerSocketAbsent = docker('exec', name, 'sh', '-c', 'test ! -S /var/run/docker.sock && echo absent');
  output.diskBytes = await worker.diskUsage();
  output.resources = await worker.sample();
  docker('exec', '-d', name, 'sh', '-c', 'while true; do date +%s >> "$1"; sleep .2; done', 'probe', path.join(cwd, 'writer'));
  await new Promise(resolve => setTimeout(resolve, 600));
  // A fresh coordinator must recover the persisted identity and terminate existing detached work.
  worker = makeWorker();
  await worker.load();
  assert.equal(worker.current.name, name);
  await worker.stop();
  const after = (await stat(path.join(cwd, 'writer'))).size;
  await new Promise(resolve => setTimeout(resolve, 600));
  output.detachedWriterStopped = after === (await stat(path.join(cwd, 'writer'))).size;
  output.containerAbsent = !docker('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}');
  assert.equal(output.detachedWriterStopped, true, 'Stop must terminate detached writers');
  assert.equal(output.containerAbsent, true, 'Stop must remove the owned container');
  await worker.finish();
  worker.releaseClaim('transport-probe');
  console.log(JSON.stringify(output));
} finally {
  try { await worker.stop(); if (worker.current) await worker.finish(); }
  catch (error) { console.error(`Worker recovery data preserved at ${root}`); throw error; }
  if (!worker.current) await rm(root, { recursive: true, force: true });
}

// Disposable native process/tool fixtures. No provider account or model inference is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { TrackedNativeProcesses } from '../src/tracked-process.ts';

const wait = async predicate => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Native fixture condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const processGroups = process.platform !== 'win32';

test('native transport passes only the selected home and stops its known descendant', { skip: !processGroups, timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-native-'));
  let processes;
  try {
    const home = path.join(root, 'selected'); await mkdir(home, { mode: 0o700 });
    await writeFile(path.join(home, 'auth.json'), '{"fixture":"selected-only"}', { mode: 0o600 });
    const other = path.join(root, 'other-account'); await mkdir(other, { mode: 0o700 });
    await writeFile(path.join(other, 'auth.json'), '{"fixture":"unselected"}', { mode: 0o600 });
    const cwd = path.join(root, 'work'); await mkdir(cwd);
    const fake = path.join(root, 'native.mjs');
    await writeFile(fake, `import { readFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', 'setInterval(()=>require("fs").writeFileSync("ticks",String(Date.now())),20)'], {stdio:'ignore'});
      const home = process.env.HOME;
      console.log(JSON.stringify({home,auth:JSON.parse(readFileSync(home+'/auth.json')),keys:Object.keys(process.env).filter(k=>/^(HOSTY_|CORE_|DOCKER_HOST_)/.test(k))}));
      setInterval(()=>{},1000);`);
    const runId = randomUUID(), generation = randomUUID();
    processes = await TrackedNativeProcesses.create(root, runId, generation);
    const child = processes.transport.spawnCommand(process.execPath, [fake], { cwd,
      env: { PATH: process.env.PATH, HOME: home,
        HOSTY_CORE_TOKEN: 'synthetic-control', CORE_TOKEN: 'synthetic-control', DOCKER_HOST_TOKEN: 'synthetic-control' } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    await wait(() => output.includes('\n'));
    const observation = JSON.parse(output.trim());
    assert.equal(observation.home, home); assert.deepEqual(observation.auth, { fixture: 'selected-only' }); assert.deepEqual(observation.keys, []);
    await wait(async () => Boolean(await readFile(path.join(cwd, 'ticks'), 'utf8').catch(() => null)));
    await processes.transport.stopProcess(child);
    const proof = await processes.stop();
    assert.equal(proof.allClosed, true); assert.equal(proof.spawnCount, 1);
    assert.equal(proof.stopped, false, 'process receipts alone cannot attest to an SDK stop');
    const ticks = await readFile(path.join(cwd, 'ticks'), 'utf8'); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(path.join(cwd, 'ticks'), 'utf8'), ticks);
    assert.deepEqual(await TrackedNativeProcesses.readEvidence(root, runId, generation), proof);
    assert.equal(await readFile(path.join(other, 'auth.json'), 'utf8'), '{"fixture":"unselected"}');
  } finally { await processes?.stop(); await rm(root, { recursive: true, force: true }); }
});

test('supports relative Git worktree pointers under the selected native process transport', { skip: !processGroups, timeout: 20000 }, async () => {
  const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)\./);
  assert.ok(version && (Number(version[1]) > 2 || Number(version[1]) === 2 && Number(version[2]) >= 48), 'relative worktree pointers require Git 2.48 or later');
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-git-'));
  let processes;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', 'repositories/repository'); git('-C', 'repositories/repository', 'config', 'worktree.useRelativePaths', 'true');
    git('-C', 'repositories/repository', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
    await mkdir(path.join(root, 'trees')); git('-C', 'repositories/repository', 'worktree', 'add', '../../trees/tree', '-b', 'fixture');
    assert.match(await readFile(path.join(root, 'trees/tree/.git'), 'utf8'), /^gitdir: \.\.\//);
    processes = await TrackedNativeProcesses.create(root, randomUUID(), randomUUID());
    const child = processes.transport.spawnCommand('git', ['status', '--porcelain'], { cwd: path.join(root, 'trees/tree'), env: { PATH: process.env.PATH, HOME: root } });
    let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, error); assert.equal(output.trim(), '');
    assert.equal((await processes.stop()).allClosed, true);
  } finally { await processes?.stop(); await rm(root, { recursive: true, force: true }); }
});

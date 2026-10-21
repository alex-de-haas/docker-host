// Run only in a disposable Worker image: node --import tsx --test test/worker-native.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, chown } from 'node:fs/promises';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { prepareNativeProfile } from '../src/worker/native.ts';

test('isolates selected credentials, observes known child exit and supports relative Git worktrees', {
  skip: process.env.HOSTY_TEST_WORKER_NATIVE !== '1' || process.getuid?.() !== 0,
}, async () => {
  const root = await mkdtemp('/tmp/worker-native-');
  let profile;
  try {
    await chmod(root, 0o755);
    const home = path.join(root, 'control'); await mkdir(home, { mode: 0o700 });
    await writeFile(path.join(home, 'auth.json'), '{"fixture":"selected-only"}');
    await writeFile(path.join(home, 'other-account'), 'never-expose');
    const cwd = path.join(root, 'work'); await mkdir(cwd); await chown(cwd, 1000, 1000);
    const fake = path.join(root, 'native.mjs');
    await writeFile(fake, `import { readFileSync, writeFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      let protectedControl = false; try { readFileSync(${JSON.stringify(path.join(home, 'other-account'))}); } catch(e) { protectedControl = e.code === 'EACCES'; }
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>require("fs").writeFileSync("ticks",String(Date.now())),20)'], {stdio:'ignore'});
      console.log(JSON.stringify({uid:process.getuid(), auth:JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json')), protectedControl, keys:Object.keys(process.env).filter(k=>k.startsWith('HOSTY_')), child:child.pid}));
      setInterval(()=>{}, 1000);`);
    process.env.HOSTY_HARNESS_CODEX_COMMAND = fake;
    profile = await prepareNativeProfile(home, 'codex', 1000);
    const child = profile.transport.spawn('codex', [], {cwd, env:{...process.env, HOSTY_CORE_TOKEN:'fixture-never-expose'}});
    const [chunk] = await once(child.stdout, 'data'); const observation = JSON.parse(String(chunk));
    assert.equal(observation.uid, 1000); assert.equal(observation.protectedControl, true);
    assert.deepEqual(observation.auth, {fixture:'selected-only'}); assert.deepEqual(observation.keys, []);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(path.join(cwd, 'ticks'), 'utf8').catch(()=>null)) break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(await readFile(path.join(cwd, 'ticks'), 'utf8'), 'background child must be running before cleanup');
    await profile.close(); profile = undefined;
    const ticks = await readFile(path.join(cwd, 'ticks'), 'utf8'); await new Promise(r=>setTimeout(r,100));
    assert.equal(await readFile(path.join(cwd, 'ticks'), 'utf8'), ticks);
    const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
    assert.match(git('--version'), /^git version 2\.56\./);
    git('init', 'repositories/repository');
    git('-C', 'repositories/repository', 'config', 'worktree.useRelativePaths', 'true');
    git('-C', 'repositories/repository', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
    await mkdir(path.join(cwd, 'trees'));
    git('-C', 'repositories/repository', 'worktree', 'add', '../../trees/tree', '-b', 'fixture');
    const pointer = await readFile(path.join(cwd, 'trees/tree/.git'), 'utf8');
    assert.match(pointer, /^gitdir: \.\.\//);
    assert.equal(git('-C', 'trees/tree', 'status', '--porcelain'), '');
    assert.equal(git('-C', 'trees/tree', 'branch', '--show-current'), 'fixture');
    // Desktop can report root-owned binds while the agent must remain unprivileged.
    await writeFile(fake, `import {execFileSync} from 'node:child_process'; console.log(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}));`);
    profile = await prepareNativeProfile(home, 'codex', 1000);
    const gitChild = profile.transport.spawn('codex', [], {cwd:path.join(cwd,'trees/tree'),env:{...process.env}});
    let gitError = ''; gitChild.stderr.on('data', chunk=>{gitError+=chunk;});
    const [code] = await once(gitChild,'close'); assert.equal(code,0,gitError);
    await profile.close(); profile = undefined;
  } finally { await profile?.close(); await rm(root, {recursive:true,force:true}); delete process.env.HOSTY_HARNESS_CODEX_COMMAND; }
});

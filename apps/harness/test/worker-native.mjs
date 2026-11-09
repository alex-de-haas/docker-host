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

test('runs Ollama tools as the selected unprivileged identity without provider credentials', {
  skip: process.env.HOSTY_TEST_WORKER_NATIVE !== '1' || process.getuid?.() !== 0,
}, async () => {
  const { OllamaExecutor } = await import('../src/harness/ollama/executor.ts');
  const root = await mkdtemp('/tmp/worker-ollama-');
  let profile, executor;
  try {
    await chmod(root, 0o755);
    const home = path.join(root, 'control'); await mkdir(home, {mode:0o700});
    await writeFile(path.join(home, 'auth.json'), '{"never":"copy"}');
    const cwd = path.join(root, 'work'); await mkdir(cwd); await chown(cwd, 1000, 1000);
    profile = await prepareNativeProfile(home, 'ollama', 1000);
    await assert.rejects(readFile(path.join(profile.root, 'auth.json')), {code:'ENOENT'});
    executor = new OllamaExecutor(cwd, profile.transport);
    const result = await executor.execute('run_command', {command:'id -u; test ! -r '+home+'/auth.json'}, new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(result.result.exitCode, 0);
    assert.match(result.result.output, /^1000\n/);
    assert.equal((await executor.execute('apply_patch', {path:'owned.txt',old_text:'',new_text:'owned'}, new AbortController().signal, 'missing')).ok, true);
    const {stat} = await import('node:fs/promises');
    assert.equal((await stat(path.join(cwd,'owned.txt'))).uid, 1000);
    const { OllamaHarnessAdapter } = await import('../src/harness/ollama/index.ts');
    const { OllamaClient } = await import('../src/harness/ollama/client.ts');
    execFileSync('git', ['init'], {cwd,stdio:'ignore'});
    let step = 0;
    const client = new OllamaClient('http://fixture', async (url) => {
      if (String(url).endsWith('/api/tags')) return Response.json({models:[{name:'fixture:latest'}]});
      if (String(url).endsWith('/api/show')) return Response.json({capabilities:['completion','tools'],model_info:{'fixture.context_length':32768}});
      const message = step++ === 0 ? {role:'assistant',content:'',tool_calls:[{function:{name:'run_command',arguments:{command:'id -u; git status --porcelain'}}}]} : {role:'assistant',content:'Observed execution'};
      return new Response(JSON.stringify({model:'fixture:latest',message,done:true})+'\n');
    });
    const adapter = new OllamaHarnessAdapter({url:'http://fixture',directory:path.join(home,'state'),client});
    const events=[];
    const run=adapter.start({cwd,sessionId:'docker-fixture',autonomy:'autonomous',nativeHome:profile.root,processTransport:profile.transport,onEvent:event=>events.push(event)});
    try {
      run.send('Run the command');
      for(let attempt=0;attempt<200&&!events.some(e=>e.type==='result'||e.type==='error');attempt++) await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(events.some(e=>e.type==='result'),JSON.stringify(events));
      assert.ok(events.some(e=>e.type==='command_result'&&e.exitCode===0));
      assert.ok(events.some(e=>e.type==='tool_result'&&e.output.includes('1000')));
    } finally { await run.stopAndWait(); }
  } finally { await executor?.close(); await profile?.close(); await rm(root,{recursive:true,force:true}); }
});

// Real OS qualification. Native descendants hold an independent SQLite writer while their
// supervising process is killed. A positive receipt must imply release of that kernel lock.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commonAssets } from './build-config.mjs';

const format = process.argv[2], input = fileURLToPath(new URL('../src/',import.meta.url));
if (!['required','unavailable'].includes(format)) throw new Error('Select required or unavailable.');
const temp = await mkdtemp(path.join(tmpdir(),'hosty-writer-qualification-'));
const entry = path.join(temp,'scope.mjs'), run = randomUUID(), generation = randomUUID();
const database = path.join(temp,'resource.sqlite'), ready = path.join(temp,'writer-started');
let owner, lock;
try {
  await build({ stdin:{ contents:"export {TrackedNativeProcesses} from './tracked-process.ts'; export {probeWriterScope} from './writer-scope.ts';",resolveDir:input }, bundle:true,platform:'node',target:'node24',format:'esm',outfile:entry });
  for (const file of commonAssets) await copyFile(path.join(input,file),path.join(temp,file));
  const {probeWriterScope, TrackedNativeProcesses} = await import(pathToFileURL(entry).href);
  const scope = await probeWriterScope(temp, message => console.error(message));
  if (format === 'unavailable') {
    assert.equal(scope, undefined, 'This host must not advertise verified closure of detached workspace writers.');
  } else {
    assert.ok(scope,'The native writer boundary is unavailable on this runner.');
    if (scope.kind === 'windows-job') {
      const { prepareWindowsJob } = await import('../src/windows-job-cache.mjs');
      const executable = await prepareWindowsJob(temp);
      const invoke = args => promisify(execFile)(executable, args, { timeout: 10000, windowsHide: true });
      let deep = temp;
      while (deep.length < 265) deep = path.join(deep, 'deep-workspace-segment');
      await mkdir(deep, { recursive: true });
      const nonce = randomUUID(), pipe = 'hosty-native-' + nonce, receipt = path.join(deep, nonce + '.json');
      assert.equal((await invoke(['--version'])).stdout.trimEnd(), 'hosty-windows-job/1');
      await assert.rejects(invoke([]), { code: 70 });
      await assert.rejects(invoke([pipe, path.join(temp, 'wrong-receipt.json')]), { code: 70 });
      await writeFile(receipt, '{}');
      for (let delivery = 0; delivery < 2; delivery++) {
        await invoke([pipe, receipt]);
        assert.deepEqual(await readFile(receipt + '.guard'), Buffer.from([1]));
      }
      // The probe above uses ordinary short paths. Exercise the actual per-attempt guard,
      // temporary receipt, atomic replacement and independent read under a long data root.
      const unit = await TrackedNativeProcesses.create(deep, randomUUID(), randomUUID(), scope);
      try {
        const child = unit.transport.spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: temp, env: process.env });
        child.stdout.resume(); child.stderr.pipe(process.stderr); child.stdin.end();
        assert.equal((await once(child, 'close', { signal: AbortSignal.timeout(30000) }))[0], 0);
        await unit.confirmSdkStop();
        assert.equal((await unit.stop()).stopped, true);
      } finally { await unit.stop(); }
    }
    // A qualified scope also runs ordinary successful turns. Exercise the shipped bridge and
    // retain primary exit, complete output and verified exclusive release independently.
    const outputRun = randomUUID(), outputGeneration = randomUUID();
    const outputUnit = await TrackedNativeProcesses.create(temp, outputRun, outputGeneration, scope);
    try {
      const expected = Buffer.from('agent🙂'.repeat(32768));
      const child = outputUnit.transport.spawn(process.execPath, ['-e', "process.stdout.write('agent🙂'.repeat(32768))"], { cwd: temp, env: process.env });
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stderr.pipe(process.stderr);
      child.stdin.end();
      const [code] = await once(child, 'close', { signal: AbortSignal.timeout(45000) });
      assert.equal(code, 0, 'A successful native command must exit successfully after its output drains.');
      assert.ok(Buffer.concat(chunks).equals(expected), 'The native bridge lost or duplicated output before closure.');
      const directory = path.join(temp, 'native-processes', outputRun, outputGeneration);
      const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
      assert.equal(manifest.targets.length, 1);
      const [nonce] = manifest.targets;
      const receipt = JSON.parse(await readFile(path.join(directory, nonce + '.json.target'), 'utf8'));
      assert.deepEqual([receipt.runId, receipt.generation, receipt.nonce, receipt.targetExited, receipt.code],
        [outputRun, outputGeneration, nonce, true, 0], 'Native primary exit lost its identity or result.');
      await outputUnit.confirmSdkStop();
      const proof = await outputUnit.stop();
      assert.equal(proof.writerScopeClosed, true, 'Exclusive reuse needs a separate scope receipt.');
    } finally { await outputUnit.stop(); }
    const descendant = "const db=new (require('node:sqlite').DatabaseSync)(process.argv[1]);db.exec('BEGIN EXCLUSIVE; CREATE TABLE held(id)');require('node:fs').writeFileSync(process.argv[2], 'running');setInterval(()=>{},1000)";
    const parent = "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)";
    const fixture = path.join(temp,'owner.mjs');
    await writeFile(fixture, [
      "import {TrackedNativeProcesses} from './scope.mjs';",
      "const [data,id,gen,scope,parent,child,db,ready]=process.argv.slice(2);",
      "const unit=await TrackedNativeProcesses.create(data,id,gen,JSON.parse(scope));",
      "const runner=unit.transport.spawn(process.execPath,['-e',parent,child,db,ready],{cwd:data,env:process.env});",
      "runner.stderr.pipe(process.stderr);runner.stdout.resume();",
      "process.on('message', command=>{ if(command==='lose-native-runner') process.kill(runner.pid,'SIGKILL'); });",
    ].join('\n'));
    lock = new DatabaseSync(database); lock.exec('PRAGMA busy_timeout=0');
    owner = spawn(process.execPath,[fixture,temp,run,generation,JSON.stringify(scope),parent,descendant,database,ready],{stdio:['ignore','ignore','inherit','ipc']});
    const deadline = Date.now()+45000;
    while (!await readFile(ready).catch(()=>null) && Date.now()<deadline) await delay(100);
    assert.equal(await readFile(ready,'utf8'),'running');
    assert.throws(()=>lock.exec('BEGIN EXCLUSIVE'), error=>error.errcode===5);
    // Lose the writer protocol process too. A delegated cgroup or named Windows Job must be
    // discoverable even if its original output recorder cannot write a terminal packet.
    owner.send('lose-native-runner'); await delay(100);
    const ended = once(owner,'exit'); owner.kill('SIGKILL'); await ended;
    const stopDeadline=Date.now()+45000;
    let result;
    do { result=await TrackedNativeProcesses.readEvidence(temp,run,generation,true); if(!result.stopped)await delay(200); } while (!result.stopped && Date.now()<stopDeadline);
    assert.equal(result.stopped,true,JSON.stringify(result)); assert.equal(result.allClosed,true);
    lock.exec('BEGIN EXCLUSIVE; ROLLBACK');
    console.log('Confirmed closure after producer and receipt writer death:',scope.kind);
  }
} finally {
  if(owner && owner.exitCode===null && owner.signalCode===null)owner.kill('SIGKILL');
  lock?.close(); await rm(temp,{recursive:true,force:true});
}

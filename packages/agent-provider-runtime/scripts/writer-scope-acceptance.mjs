// Real OS qualification. Native descendants hold an independent SQLite writer while their
// supervising process is killed. A positive receipt must imply release of that kernel lock.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(scope, undefined, 'This host must refuse unrestricted worktree writers.');
  } else {
    assert.ok(scope,'The native writer boundary is unavailable on this runner.');
    if (scope.kind === 'windows-job') {
      const { prepareWindowsJob } = await import('../src/windows-job-cache.mjs');
      const executable = await prepareWindowsJob(temp);
      const invoke = args => promisify(execFile)(executable, args, { timeout: 10000, windowsHide: true });
      const nonce = randomUUID(), pipe = 'hosty-native-' + nonce, receipt = path.join(temp, nonce + '.json');
      assert.equal((await invoke(['--version'])).stdout.trimEnd(), 'hosty-windows-job/1');
      await assert.rejects(invoke([]), { code: 70 });
      await assert.rejects(invoke([pipe, path.join(temp, 'wrong-receipt.json')]), { code: 70 });
      await writeFile(receipt, '{}');
      for (let delivery = 0; delivery < 2; delivery++) {
        await invoke([pipe, receipt]);
        assert.deepEqual(await readFile(receipt + '.guard'), Buffer.from([1]));
      }
    }
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

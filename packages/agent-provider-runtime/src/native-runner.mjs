import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const anchorMode = process.argv[2] === '--anchor';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeSend = message => { if (process.connected) process.send(message); };
async function drainOutput() {
  return (await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => {
    if (stream.destroyed || stream.writableEnded) { resolve(false); return; }
    try { stream.write('', error => resolve(!error)); } catch { resolve(false); }
  })))).every(Boolean);
}
function forwardOutput(source, destination) {
  return new Promise(resolve => {
    const fail = () => resolve(false);
    source.once('end', () => resolve(true)); source.once('error', fail);
    source.once('close', () => { if (!source.readableEnded) fail(); });
    destination.once('error', fail);
    // The native child gets a fresh blocking pipe. Node owns backpressure on the other end.
    source.pipe(destination, { end: false });
  });
}
if (process.platform === 'win32') {
  if (anchorMode) throw new Error('The POSIX native anchor is unavailable on Windows.');
  const { runWindowsWriter } = await import('./native-windows.mjs');
  await runWindowsWriter();
} else if (anchorMode) {
  let child, configured = false, exiting = false, nativeOutput = Promise.resolve(true);
  async function exitAnchor() {
    if (exiting) return; exiting = true;
    const drained = await nativeOutput;
    process.exit(drained && await drainOutput() ? 0 : 70);
  }
  // Stay alive as the group identity until the external writer has completed group verification.
  process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});
  process.on('message', message => {
    if (message?.exit === true) { void exitAnchor(); return; }
    if (configured || message?.version !== 1) return; configured = true;
    try {
      child = spawn(message.command, message.args, { cwd: message.cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_CHANNEL_'))), detached: false, stdio: ['pipe','pipe','pipe'] });
      nativeOutput = Promise.all([forwardOutput(child.stdout, process.stdout), forwardOutput(child.stderr, process.stderr)]).then(results => results.every(Boolean));
      process.stdin.pipe(child.stdin); child.stdin.on('error', () => {});
      child.on('spawn', () => safeSend({ nativeStarted: true, pid: child.pid }));
      child.once('error', () => safeSend({ nativeExit: true, code: 127, spawnFailed: true }));
      // Exit starts descendant cleanup: descendants may still hold the native pipes open.
      // Anchor exit and the authoritative writer receipt separately wait for output drainage.
      child.once('exit', (code, signal) => safeSend({ nativeExit: true, code, signal }));
    } catch { safeSend({ nativeExit: true, code: 127, spawnFailed: true }); }
  });
  process.on('disconnect', () => {
    // The writer itself was lost: stop the anchored group, but do not manufacture a receipt.
    if (process.platform !== 'win32') {
      try { process.kill(-process.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }, 2000);
    } else { if (child) child.kill('SIGTERM'); process.exit(1); }
  });
} else {
  let config, anchor, closing = false, stoppingRequested = false, outputAvailable = true, exitCode = 0, nativePid, anchorClosed = Promise.resolve();
  function persist(state, treeStopped, outputDrained) {
    if (!config) return;
    const value = { version: 1, runId: config.runId, generation: config.generation, nonce: config.nonce, state, treeStopped,
      writerPid: process.pid, groupPid: anchor?.pid, nativePid, observedAt: new Date().toISOString(),
      ...(outputDrained === undefined ? {} : { outputDrained }) };
    const temporary = config.file + '.' + randomUUID() + '.tmp'; const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, config.file);
    if (process.platform !== 'win32') { const directory = openSync(path.dirname(config.file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
  }
  async function members(group) {
    const child = spawn('/bin/ps', ['-axo','pid=,pgid=,stat='], { detached: true, stdio: ['ignore','pipe','ignore'] });
    let output = ''; child.stdout.on('data', value => { output += value; if (output.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
    const code = await new Promise(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)); });
    if (code !== 0 || output.length > 8 * 1024 * 1024) throw new Error('Process-group observation unavailable');
    return output.split('\n').map(line => line.trim().split(/\s+/)).filter(row => Number(row[1]) === group && !row[2]?.startsWith('Z')).map(row => Number(row[0]));
  }
  const alive = () => anchor && anchor.exitCode === null && anchor.signalCode === null;
  async function end() {
    stoppingRequested = true;
    if (closing || !config) return; closing = true;
    let stopped = false;
    try {
      if (!anchor?.pid) stopped = true;
      else if (alive()) {
        process.kill(-anchor.pid, 'SIGTERM');
        const deadline = Date.now() + 2000;
        while (alive() && Date.now() < deadline) {
          if (!(await members(anchor.pid)).some(pid => pid !== anchor.pid)) { stopped = true; break; }
          await delay(50);
        }
        if (!stopped && alive()) {
          // The live anchor pins this process-group identity during escalation.
          process.kill(-anchor.pid, 'SIGKILL');
          for (let n = 0; n < 40; n++) { if (!(await members(anchor.pid)).length) { stopped = true; break; } await delay(50); }
        }
        if (stopped && alive()) anchor.send({ exit: true });
      }
    } catch { stopped = false; }
    if (anchor) { process.stdin.unpipe(anchor.stdin); anchor.stdin.destroy(); }
    let timer;
    const drained = await Promise.race([anchorClosed.then(() => !outputAvailable || anchor?.exitCode === 70 ? false : drainOutput()).catch(() => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    // Complete the forwarding attempt before recording physical tree exit. A lost producer
    // cannot receive output, but that does not erase verified exit or establish an SDK stop.
    try { persist(stopped ? 'stopped' : 'unknown', stopped, drained); }
    catch { process.exit(70); }
    if (anchor?.connected) anchor.disconnect();
    process.exit(stopped && drained ? exitCode : 70);
  }
  process.on('SIGTERM', () => void end()); process.on('SIGINT', () => void end());
  // Input EOF is data protocol completion (for example JSON-on-stdin tools), not cancellation.
  // Producer loss is independently detected through the private IPC channel.
  function loseOutput() {
    outputAvailable = false;
    // Do not leave the native pipes blocked on a producer that can no longer read them.
    anchor?.stdout.unpipe(process.stdout); anchor?.stderr.unpipe(process.stderr);
    anchor?.stdout.resume(); anchor?.stderr.resume();
    void end();
  }
  process.on('disconnect', loseOutput);
  process.stdout.on('error', loseOutput); process.stderr.on('error', loseOutput);
  process.on('message', message => {
    if (message?.stop === true) { if (!config || message.nonce === config.nonce) void end(); return; }
    if (config || message?.version !== 1 || !Array.isArray(message.args) || typeof message.command !== 'string') return;
    config = message;
    try {
      persist('starting', false);
      if (stoppingRequested) { void end(); return; }
      anchor = spawn(process.execPath, [fileURLToPath(import.meta.url), '--anchor'], { cwd: config.cwd, env: process.env,
        detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe','ipc'] });
      // ChildProcess.close can also wait on its IPC bookkeeping. Kernel exit plus the two
      // output-pipe close events are the completion facts needed before forwarding finishes.
      anchorClosed = Promise.all([
        new Promise(resolve => { anchor.once('exit', resolve); anchor.once('error', resolve); }),
        new Promise(resolve => anchor.stdout.once('close', resolve)),
        new Promise(resolve => anchor.stderr.once('close', resolve)),
      ]);
      process.stdin.pipe(anchor.stdin); anchor.stdout.pipe(process.stdout); anchor.stderr.pipe(process.stderr);
      anchor.stdin.on('error', () => {});
      anchor.on('message', value => {
        if (value?.nativeStarted) { nativePid = value.pid; try { persist('running', false); } catch { void end(); } }
        if (value?.nativeExit) { exitCode = Number.isInteger(value.code) ? value.code : 1; void end(); }
      });
      anchor.once('error', () => { exitCode = 127; void end(); });
      anchor.once('exit', () => { if (!closing) void end(); });
      anchor.send({ version: 1, command: config.command, args: config.args, cwd: config.cwd });
    } catch { exitCode = 127; void end(); }
  });
}

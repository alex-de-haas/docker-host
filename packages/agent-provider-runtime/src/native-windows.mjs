import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONTROL_BYTES = 1024 * 1024;
export function isWindowsJobProof(receipt, config, writerPid) {
  return Number.isSafeInteger(writerPid) && writerPid > 0 && receipt?.version === 1 && receipt.runId === config.runId && receipt.generation === config.generation && receipt.nonce === config.nonce
    && receipt.writerPid === writerPid && receipt.mechanism === 'windows-job.1' && receipt.state === 'stopped' && receipt.treeStopped === true
    && receipt.activeProcesses === 0 && receipt.knownHandlesClosed === true && Number.isFinite(Date.parse(receipt.observedAt))
    && Number.isInteger(receipt.code) && receipt.code >= -2147483648 && receipt.code <= 2147483647;
}
function persist(config, stopped = false) {
  const temporary = config.file + '.' + randomUUID() + '.tmp', file = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(file, JSON.stringify({ version: 1, runId: config.runId, generation: config.generation, nonce: config.nonce, state: stopped ? 'stopped' : 'unknown', treeStopped: stopped, writerPid: process.pid, mechanism: stopped ? 'windows-not-started.1' : 'windows-job.1', observedAt: new Date().toISOString() })); fsyncSync(file); }
  finally { closeSync(file); }
  renameSync(temporary, config.file);
}
async function drainOutput() {
  const pending = Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => {
    if (stream.destroyed || stream.writableEnded) { resolve(false); return; }
    try { stream.write('', error => resolve(!error)); } catch { resolve(false); }
  })));
  return (await pending).every(Boolean);
}
async function within(promise, milliseconds = 5000) {
  let timer; try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** The PowerShell bridge owns a non-inheritable Job Object handle outside the command's job.
 * Control uses a private named pipe; native stdin/stdout/stderr remain unchanged byte streams.
 */
export async function runWindowsWriter() {
  let config, bridge, socket, closed = false, stopping = false, connected = false, startupTimer, stopTimer, connectTimer, bridgeClosed = Promise.resolve();
  let tracing = false;
  const trace = stage => { if (tracing) process.stderr.write("[native-probe] " + stage + "\n"); };
  const proof = () => {
    try { const value = readFileSync(config.file); if (value.length > 64000) return null; const receipt = JSON.parse(value.toString('utf8')); return isWindowsJobProof(receipt, config, bridge?.pid) ? receipt : null; }
    catch { return null; }
  };
  const finish = async (code = 70) => {
    if (closed) return; closed = true; clearTimeout(startupTimer); clearTimeout(stopTimer); clearTimeout(connectTimer);
    socket?.destroy();
    // A lost response cannot overwrite an already durable identity-bound job proof.
    const receipt = proof();
    trace("finish: receipt=" + !!receipt + " bridge=" + bridge?.exitCode + " connected=" + connected);
    if (!receipt) { try { persist(config); } catch {} bridge?.kill('SIGKILL'); code = 70; }
    else code = receipt.code;
    if (bridge) { process.stdin.unpipe(bridge.stdin); bridge.stdin.destroy(); }
    // Private completion precedes pipe drain. Wait for PowerShell's stdio-close event and all
    // already forwarded writes before ending the SDK-facing streams.
    const drained = await within(bridgeClosed.then(drainOutput).catch(() => false));
    if (!drained) { bridge?.kill('SIGKILL'); code = 70; }
    process.exit(Number.isInteger(code) ? code : 70);
  };
  const requestStop = () => {
    stopping = true;
    if (socket && connected && !socket.destroyed && socket.writable) { try { socket.write(JSON.stringify({ stop: true, nonce: config.nonce }) + '\n'); } catch {} }
    // Closing the pipe asks the helper to terminate its job. KILL_ON_JOB_CLOSE also applies if
    // the helper itself fails; without its independent accounting receipt, state stays unknown.
    if (!stopTimer && config) { stopTimer = setTimeout(() => { socket?.destroy(); finish(70); }, 10000); stopTimer.unref(); }
  };
  process.on('SIGTERM', requestStop); process.on('SIGINT', requestStop); process.on('disconnect', requestStop);
  process.stdout.on('error', requestStop); process.stderr.on('error', requestStop);
  process.on('message', message => {
    if (message?.stop === true) { if (!config || message.nonce === config.nonce) requestStop(); return; }
    if (config || message?.version !== 1 || !Array.isArray(message.args) || typeof message.command !== 'string') return;
    config = message;
    tracing = /^job-probe-[A-Za-z0-9]+$/.test(path.basename(config.cwd)) && config.command === process.execPath
      && config.args.length === 2 && config.args[0] === '-e' && config.args[1] === 'process.exit(0)';
    // Stop/producer loss may arrive before launch configuration. No helper or native command
    // is created in that case; the independent SDK marker remains a separate requirement.
    if (stopping) { try { persist(config, true); } catch { process.exit(70); return; } process.exit(0); return; }
    const pipeName = 'hosty-native-' + config.nonce, pipe = '\\\\.\\pipe\\' + pipeName;
    if (!/^[a-f0-9-]{36}$/.test(config.nonce)) { finish(70); return; }
    const connect = () => {
      if (closed) return;
      const candidate = createConnection(pipe); let buffer = '';
      candidate.once('connect', () => { socket = candidate; trace('control pipe connected'); });
      candidate.on('data', bytes => {
        buffer += bytes.toString('utf8'); if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES) { requestStop(); candidate.destroy(); return; }
        for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let value;
          try { value = JSON.parse(line); } catch { requestStop(); candidate.destroy(); return; }
          if (value.version !== 1 || value.nonce !== config.nonce) { requestStop(); candidate.destroy(); return; }
          if (value.type === 'ready' && !connected) {
            connected = true; clearTimeout(startupTimer); trace('ready frame');
            const command = JSON.stringify({ version: 1, runId: config.runId, generation: config.generation, nonce: config.nonce, file: config.file, command: config.command, args: config.args, cwd: config.cwd, cancelled: stopping });
            if (Buffer.byteLength(command) > MAX_CONTROL_BYTES) { requestStop(); candidate.destroy(); return; }
            candidate.write(command + '\n'); if (stopping) requestStop();
          } else if (value.type === 'stopped') {
            // The helper has flushed and atomically replaced the proof file before this message.
            if (!proof()) { requestStop(); return; }
            finish(value.code);
          } else if (value.type !== 'started') { requestStop(); candidate.destroy(); return; }
        }
      });
      candidate.on('error', error => {
        candidate.destroy();
        if (connected && socket === candidate) requestStop();
        else if (!closed && ['ENOENT', 'EBUSY', 'ECONNREFUSED'].includes(error.code)) { connectTimer = setTimeout(connect, 50); connectTimer.unref(); }
        else finish(70);
      });
      candidate.on('close', () => { if (!closed && socket === candidate && connected && !stopping) requestStop(); });
    };
      const system = process.env.SystemRoot || process.env.SYSTEMROOT;
      if (!system || !path.isAbsolute(system)) { finish(70); return; }
      const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_CHANNEL_')));
      trace('starting bridge');
      bridge = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-native-job.ps1', import.meta.url)), '-PipeName', pipeName, ...(tracing ? ['-TraceBootstrap'] : [])], { cwd: config.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      bridgeClosed = Promise.all([
        new Promise(resolve => { bridge.once('exit', resolve); bridge.once('error', resolve); }),
        new Promise(resolve => bridge.stdout.once('close', resolve)),
        new Promise(resolve => bridge.stderr.once('close', resolve)),
      ]);
      // EOF belongs to the command protocol, not to the control channel or job stop operation.
      process.stdin.pipe(bridge.stdin); bridge.stdout.pipe(process.stdout); bridge.stderr.pipe(process.stderr);
      bridge.stdin.on('error', requestStop);
      bridge.once('error', error => { trace('bridge spawn error ' + error.code); finish(70); });
      bridge.once('exit', code => finish(code));
      startupTimer = setTimeout(() => { trace('timed out waiting for bridge ready'); requestStop(); }, 30000); startupTimer.unref(); connect();
  });
}

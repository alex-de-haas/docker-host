import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { isWindowsJobProof } from './native-windows.mjs';

describe('Windows owned-job receipt boundary', () => {
  const config = { runId: 'run', generation: 'generation', nonce: 'nonce' };
  const receipt = { version: 1, ...config, writerPid: 123, mechanism: 'windows-job.1', state: 'stopped', treeStopped: true, activeProcesses: 0, knownHandlesClosed: true, code: 0, observedAt: '2026-11-12T10:00:00.000Z' };
  it('accepts only an independently closed job bound to the held helper process and execution', () => {
    expect(isWindowsJobProof(receipt, config, 123)).toBe(true);
    for (const changed of [{ runId: 'other' }, { generation: 'other' }, { nonce: 'other' }, { writerPid: 456 }, { mechanism: 'taskkill' }, { activeProcesses: 1 }, { knownHandlesClosed: false }, { treeStopped: false }, { state: 'unknown' }, { observedAt: 'unknown' }])
      expect(isWindowsJobProof({ ...receipt, ...changed }, config, 123)).toBe(false);
  });
  it('cannot replace a held native writer identity with a missing or guessed PID', () => {
    expect(isWindowsJobProof(receipt, config, undefined)).toBe(false);
    expect(isWindowsJobProof({ ...receipt, writerPid: undefined }, config, undefined)).toBe(false);
    expect(isWindowsJobProof(receipt, config, 0)).toBe(false);
  });
});
it('fences Stop received before Windows launch configuration without spawning a helper or command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hosty-windows-stop-fence-'));
  const config = { version: 1, runId: randomUUID(), generation: randomUUID(), nonce: randomUUID(), file: path.join(directory, 'receipt.json'), cwd: directory,
    command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'unexpected-effect'))},'bad')`] };
  await writeFile(config.file, '{}');
  const script = `const {runWindowsWriter}=await import(${JSON.stringify(new URL('./native-windows.mjs', import.meta.url).href)});await runWindowsWriter();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, env: { PATH: process.env.PATH, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  try {
    child.send({ stop: true, nonce: config.nonce }); child.send(config);
    expect(await new Promise(resolve => child.once('close', resolve))).toBe(0);
    expect(JSON.parse(await readFile(config.file, 'utf8'))).toMatchObject({ state: 'stopped', treeStopped: true, mechanism: 'windows-not-started.1' });
    await expect(access(path.join(directory, 'unexpected-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

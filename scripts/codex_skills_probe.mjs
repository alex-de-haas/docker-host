/** No-inference discovery check against the repository's pinned native Codex. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

let entry;
try { entry = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  console.log('SKIP: native Codex skill discovery (pinned @openai/codex is unavailable; run npm ci to enable)');
  process.exit(77);
}
// Spawn the native process directly so escalation cannot strand a wrapper's child.
const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
const target = { linux: `${cpu}-unknown-linux-musl`, darwin: `${cpu}-apple-darwin`, win32: `${cpu}-pc-windows-msvc` }[process.platform];
let vendor;
try { vendor = path.join(path.dirname(createRequire(entry).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), 'vendor'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  vendor = path.join(path.dirname(entry), '..', 'vendor');
}
const binary = path.join(vendor, target ?? 'unsupported', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
try { await access(binary); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('SKIP: pinned native Codex binary is unavailable for this platform; no installation attempted');
  process.exit(77);
}
const [exportRoot, name, referenceValue] = process.argv.slice(2);
assert.ok(exportRoot && name && referenceValue, 'Provide export root, native skill name and reference value');
const root = await mkdtemp(path.join(os.tmpdir(), 'hosty-native-skills-'));
let child;
let close;
let closed = false;
async function waitForClose(milliseconds) {
  if (closed) return true;
  let timer;
  try {
    return await Promise.race([close.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
try {
  const home = path.join(root, 'home'), connection = path.join(root, 'connection'), cwd = path.join(root, 'work');
  const selected = path.join(root, 'selected-skills');
  await Promise.all([mkdir(path.join(home, '.agents', 'skills'), { recursive: true }), mkdir(connection), mkdir(cwd)]);
  await symlink(await realpath(exportRoot), selected, process.platform === 'win32' ? 'junction' : 'dir');
  const expectedPath = await realpath(path.join(exportRoot, name, 'SKILL.md'));
  const selectedRoots = [path.resolve(selected), await realpath(selected), path.resolve(exportRoot), await realpath(exportRoot)];
  async function resolvedOrLexical(file) {
    try { return await realpath(file); } catch { return path.resolve(file); }
  }
  function contains(directory, file) {
    const relative = path.relative(directory, file);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  async function selectedErrors(errors) {
    const matches = [];
    for (const error of errors) {
      const lexical = path.resolve(error.path), physical = await resolvedOrLexical(error.path);
      if (selectedRoots.some(directory => contains(directory, lexical) || contains(directory, physical))) matches.push(error);
    }
    return matches;
  }
  // Use an empty connection and home hints. OS discovery can still expose unrelated user skills.
  // Those additive skills and their parse errors are outside this export's assertion scope.
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'windir', 'COMSPEC']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: connection });
  child = spawn(binary, ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.stdin.on('error', () => {});
  const rejectPending = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  child.on('error', rejectPending);
  close = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    rejectPending(new Error(`Codex exited (${code ?? signal}): ${stderr}`)); resolve();
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const result = JSON.parse(line), request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      if (result.error) request.reject(new Error(JSON.stringify(result.error)));
      else request.resolve(result.result);
    } catch (error) { rejectPending(error); }
  });
  let nextId = 1;
  async function request(method, params) {
    if (closed) throw new Error(`Codex already closed: ${stderr}`);
    const id = nextId++;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out: ${stderr}`)); }, 10000);
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally { clearTimeout(timer); }
  }
  await request('initialize', { clientInfo: { name: 'hosty-skills-acceptance', version: '1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const before = await request('skills/list', { cwds: [cwd], forceReload: true });
  assert.equal(before.data.length, 1);
  const beforePaths = await Promise.all(before.data[0].skills.map(skill => resolvedOrLexical(skill.path)));
  assert.ok(!beforePaths.some(file => path.relative(expectedPath, file) === ''), 'Selected export must be absent before root registration');
  await request('skills/extraRoots/set', { extraRoots: [selected] });
  // Configuration must also be accepted when creating the subsequent native thread. No turn is submitted.
  const started = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.ok(started.thread?.id, 'Codex must start a thread after root registration');
  const catalog = await request('skills/list', { cwds: [cwd], forceReload: true });
  assert.equal(catalog.data.length, 1);
  assert.deepEqual(await selectedErrors(catalog.data[0].errors), [], 'Native Codex must accept every package in the selected export');
  const skills = await Promise.all(catalog.data[0].skills.map(async skill => ({ ...skill, resolvedPath: await resolvedOrLexical(skill.path) })));
  const skill = skills.find(skill => skill.name === name && path.relative(expectedPath, skill.resolvedPath) === '');
  assert.ok(skill?.enabled, `Native Codex did not discover enabled skill ${name}`);
  assert.equal(await realpath(skill.path), expectedPath);
  assert.equal(await readFile(path.join(path.dirname(skill.path), 'references', 'value.txt'), 'utf8'), referenceValue);
  console.log(`PASS: pinned native Codex registers extra roots, starts a thread and discovers enabled ${name} with current references (${referenceValue}); no inference`);
} finally {
  if (child) {
    child.stdin.end();
    if (!await waitForClose(1000)) {
      child.kill('SIGTERM');
      if (!await waitForClose(2000)) {
        child.kill('SIGKILL');
        if (!await waitForClose(2000))
          throw new Error(`Codex process closure is unconfirmed; retained temporary files at ${root}`);
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}

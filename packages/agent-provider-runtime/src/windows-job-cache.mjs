import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const abi = 'hosty-windows-job/1';
const compilerTimeout = 120_000;
const probeTimeout = 10_000;
const flags = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:anycpu', '/optimize+', '/main:HostyNativeJob'];
const assemblies = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Runtime.Serialization.dll', 'System.Xml.dll'];
const recipe = JSON.stringify([abi, flags, assemblies, '/out:job.exe', 'job.cs']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ownDirectory = /^\.windows-job-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const executionOptions = { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 };

async function fileInfo(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function resolveWindowsCompiler(systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT) {
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('An absolute Windows SystemRoot is required for the Job Object helper.');
  for (const framework of ['Framework64', 'Framework']) {
    const compiler = path.join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if ((await fileInfo(compiler))?.isFile()) return compiler;
  }
  throw new Error('The Windows .NET Framework v4.0.30319 C# compiler is unavailable in SystemRoot.');
}

async function checkVersion(executable, execute) {
  const { stdout } = await execute(executable, ['--version'], { ...executionOptions, cwd: path.dirname(executable), timeout: probeTimeout });
  if (![abi, abi + '\n', abi + '\r\n'].includes(stdout))
    throw new Error('The Windows Job Object helper returned an incompatible protocol version.');
}

async function useCached(data, entry, execute) {
  if (!entry || !ownDirectory.test(entry.directory) || !/^[a-f0-9]{64}$/.test(entry.binary)) return null;
  const directory = path.join(data, entry.directory), executable = path.join(directory, 'job.exe');
  if (!(await fileInfo(directory))?.isDirectory() || !(await fileInfo(executable))?.isFile()) return null;
  if (sha256(await readFile(executable)) !== entry.binary) return null;
  try { await checkVersion(executable, execute); }
  catch { return null; }
  return executable;
}

async function execWithLockRetry(db, sql) {
  const deadline = Date.now() + compilerTimeout + 3 * probeTimeout;
  for (;;) {
    try { db.exec(sql); return; }
    catch (error) {
      const code = Number(error.errcode) & 255;
      if (code !== 5 && code !== 6) throw error;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Windows Job Object helper preparation.', { cause: error });
      await delay(50);
    }
  }
}

/** One crash-released interprocess lock publishes immutable binaries. Older processes keep their own executable. */
export async function prepareWindowsJob(data, source = fileURLToPath(new URL('./windows-native-job.cs', import.meta.url)),
  { systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT, execute = run } = {}) {
  if (!data || !path.isAbsolute(data)) throw new Error('The Windows Job Object helper requires an absolute provider data directory.');
  const bytes = await readFile(source);
  const key = createHash('sha256').update(recipe).update('\0').update(bytes).digest('hex');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const index = path.join(data, '.windows-job-cache.sqlite');
  const existing = await fileInfo(index);
  if (existing && !existing.isFile()) throw new Error('Invalid Windows Job Object helper cache.');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(index);
  let staging;
  try {
    await execWithLockRetry(db, 'PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS helpers (source TEXT PRIMARY KEY, directory TEXT NOT NULL, binary TEXT NOT NULL)');
    const cached = await useCached(data, db.prepare('SELECT directory,binary FROM helpers WHERE source=?').get(key), execute);
    if (cached) return cached;
    const compiler = await resolveWindowsCompiler(systemRoot);
    const directory = '.windows-job-' + randomUUID();
    const candidate = path.join(data, directory);
    await mkdir(candidate, { mode: 0o700 });
    staging = candidate;
    const executable = path.join(candidate, 'job.exe');
    // Compile exactly the bytes hashed above, keeping the legacy compiler's input/output paths short.
    await writeFile(path.join(candidate, 'job.cs'), bytes, { flag: 'wx', mode: 0o600 });
    const references = assemblies.map(name => '/reference:' + path.join(path.dirname(compiler), name));
    try {
      await execute(compiler, [...flags, ...references, '/out:job.exe', 'job.cs'],
        { ...executionOptions, cwd: candidate, timeout: compilerTimeout });
    } catch (error) {
      const diagnostic = String(error.stderr || error.stdout || error.message).trim().slice(0, 1200);
      throw new Error('Windows Job Object helper compilation failed: ' + diagnostic, { cause: error });
    }
    if (!(await fileInfo(executable))?.isFile()) throw new Error('The compiler did not produce the Windows Job Object helper.');
    const output = await open(executable, 'r+');
    let digest;
    try { await output.sync(); digest = sha256(await output.readFile()); } finally { await output.close(); }
    await checkVersion(executable, execute);
    await unlink(path.join(candidate, 'job.cs'));
    db.prepare('INSERT OR REPLACE INTO helpers(source,directory,binary) VALUES(?,?,?)').run(key, directory, digest);
    // In rollback journal mode a reader can hold a shared lock after BEGIN IMMEDIATE.
    // A busy COMMIT leaves this transaction open, including its already verified binary.
    await execWithLockRetry(db, 'COMMIT');
    staging = undefined;
    return executable;
  } finally {
    db.close(); // Also rolls back a failed preparation or a read-only cache hit.
    if (staging) await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}

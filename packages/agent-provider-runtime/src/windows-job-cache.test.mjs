import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { prepareWindowsJob, resolveWindowsCompiler } from './windows-job-cache.mjs';

const run = promisify(execFile);
const cacheModule = new URL('./windows-job-cache.mjs', import.meta.url).href;
let root, data, systemRoot, source;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'windows job test '));
  data = path.join(root, 'private provider data');
  systemRoot = path.join(root, 'Windows');
  source = path.join(root, 'fixture.cs');
  await mkdir(data);
  await writeFile(source, 'fixture-A');
});

afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5 }); });

async function installCompiler(framework = 'Framework64') {
  const directory = path.join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319');
  await mkdir(directory, { recursive: true });
  const compiler = path.join(directory, 'csc.exe');
  await writeFile(compiler, 'stock fixture');
  return compiler;
}

function toolchain() {
  const compiles = [], probes = [];
  return {
    compiles, probes,
    async execute(file, args, options) {
      if (path.basename(file) === 'csc.exe') {
        compiles.push({ file, args, options });
        await delay(20);
        const snapshot = await readFile(path.join(options.cwd, 'job.cs'), 'utf8');
        await writeFile(path.join(options.cwd, 'job.exe'), 'compiled:' + snapshot);
        return { stdout: '' };
      }
      probes.push(file);
      expect(args).toEqual(['--version']);
      expect(options.timeout).toBeGreaterThan(0);
      expect(await readFile(file, 'utf8')).toMatch(/^compiled:fixture-/);
      return { stdout: 'hosty-windows-job/1\r\n' };
    },
  };
}

it('resolves only the stock Framework compiler, preferring the 64-bit toolchain', async () => {
  await mkdir(systemRoot);
  await writeFile(path.join(systemRoot, 'csc.exe'), 'unrelated');
  await expect(resolveWindowsCompiler(systemRoot)).rejects.toThrow('unavailable');
  await expect(resolveWindowsCompiler('relative')).rejects.toThrow('absolute');
  expect(await installCompiler('Framework')).toBe(await resolveWindowsCompiler(systemRoot));
  expect(await installCompiler()).toBe(await resolveWindowsCompiler(systemRoot));
});

it('qualifies scratch output and reuses immutable content across replicas and source locations', async () => {
  const compiler = await installCompiler();
  const fake = toolchain();
  const prepare = file => prepareWindowsJob(data, file, { systemRoot, execute: fake.execute });
  const alias = path.join(root, 'same-source.cs');
  await writeFile(alias, await readFile(source));
  const results = await Promise.all([prepare(source), prepare(alias), prepare(source), prepare(alias)]);
  expect(new Set(results).size).toBe(1);
  const [executable] = results;
  expect(path.dirname(path.dirname(executable))).toBe(data);
  expect(fake.compiles).toHaveLength(1);
  const { file, args, options } = fake.compiles[0];
  expect(file).toBe(compiler);
  expect(args).toContain('/noconfig');
  expect(args).toContain('/nostdlib+');
  expect(args).toContain('/platform:anycpu');
  expect(args).toContain('/reference:' + path.join(path.dirname(compiler), 'mscorlib.dll'));
  expect(args).toContain('/reference:' + path.join(path.dirname(compiler), 'System.Runtime.Serialization.dll'));
  expect(options).toMatchObject({ cwd: path.dirname(executable), timeout: 120_000, windowsHide: true });
  expect(fake.probes).toEqual(results);
  await expect(access(path.join(options.cwd, 'job.cs'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(compiler);
  expect(await prepare(alias)).toBe(executable);
});

it('publishes only one binary across independent provider processes', async () => {
  await installCompiler();
  const module = path.join(root, 'prepare.mjs');
  await writeFile(module, [
    "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    'const [moduleUrl, data, source, systemRoot] = process.argv.slice(2);',
    'const { prepareWindowsJob } = await import(moduleUrl);',
    'const execute = async (file, args, { cwd }) => {',
    "  if (args[0] === '--version') {",
    "    if (await readFile(file, 'utf8') !== 'compiled:fixture-A') throw Error('invalid fixture');",
    "    return { stdout: 'hosty-windows-job/1' };",
    '  }',
    "  await appendFile(path.join(data, 'compilations'), '1');",
    '  await delay(100);',
    "  await writeFile(path.join(cwd, 'job.exe'), 'compiled:' + await readFile(path.join(cwd, 'job.cs'), 'utf8'));",
    '};',
    'console.log(await prepareWindowsJob(data, source, { systemRoot, execute }));',
  ].join('\n'));
  const args = [module, cacheModule, data, source, systemRoot];
  const processes = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, args)));
  expect(new Set(processes.map(result => result.stdout.trim())).size).toBe(1);
  expect(await readFile(path.join(data, 'compilations'), 'utf8')).toBe('1');
});

it('finishes publishing a verified binary after a concurrent SQLite reader releases its snapshot', async () => {
  await installCompiler();
  const fake = toolchain();
  const reader = new DatabaseSync(path.join(data, '.windows-job-cache.sqlite'));
  let release;
  try {
    reader.exec('CREATE TABLE fixture(id INTEGER)');
    const executable = await prepareWindowsJob(data, source, { systemRoot, execute: async (file, args, options) => {
      const result = await fake.execute(file, args, options);
      if (args[0] === '--version') {
        reader.exec('BEGIN; SELECT id FROM fixture');
        release = delay(150).then(() => reader.exec('COMMIT'));
      }
      return result;
    } });
    expect(fake.compiles).toHaveLength(1);
    expect(await prepareWindowsJob(data, source, { systemRoot, execute: fake.execute })).toBe(executable);
    expect(fake.compiles).toHaveLength(1);
  } finally { await release; reader.close(); }
});

it('rebuilt and requalified generations leave older executables and unrelated inputs intact', async () => {
  await installCompiler();
  const fake = toolchain();
  const prepare = () => prepareWindowsJob(data, source, { systemRoot, execute: fake.execute });
  const settings = path.join(data, 'user settings');
  await writeFile(settings, 'retain me');
  const original = await prepare();
  await writeFile(source, 'fixture-B');
  const next = await prepare();
  expect(next).not.toBe(original);
  expect(await readFile(original, 'utf8')).toBe('compiled:fixture-A');
  await writeFile(next, 'damaged output');
  fake.probes.length = 0;
  const repaired = await prepare();
  expect(repaired).not.toBe(next);
  expect(fake.probes).toEqual([repaired]);
  expect(await readFile(next, 'utf8')).toBe('damaged output');
  expect(await readFile(settings, 'utf8')).toBe('retain me');
});

it('rejects incompatible self-checks and compiler failures without publishing partial results', async () => {
  await installCompiler();
  const fake = toolchain();
  const prepare = execute => prepareWindowsJob(data, source, { systemRoot, execute });
  await expect(prepare(async () => { throw Error('compiler fixture error'); })).rejects.toThrow('compiler fixture error');
  for (const stdout of ['extra\nhosty-windows-job/1\n', 'hosty-windows-job/2', '']) {
    await expect(prepare((file, args, opts) => args[0] === '--version' ? { stdout } : fake.execute(file, args, opts)))
      .rejects.toThrow('incompatible');
  }
  expect((await readdir(data)).filter(name => name.startsWith('.windows-job-') && !name.includes('sqlite'))).toEqual([]);
  const ready = await prepare(fake.execute);
  expect(await prepare(fake.execute)).toBe(ready);
});

it.skipIf(process.platform !== 'win32')('builds and checks the packaged C# implementation on Windows', async () => {
  const executable = await prepareWindowsJob(data);
  expect((await run(executable, ['--version'], { windowsHide: true })).stdout.trim()).toBe('hosty-windows-job/1');
  expect(await prepareWindowsJob(data)).toBe(executable);
}, 150_000);

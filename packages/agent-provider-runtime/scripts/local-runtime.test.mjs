import { afterEach, expect, it } from 'vitest';
import { launchModeBootstrapScript } from '@hosty-sdk/app';
import { themeBootstrapScript } from '@hosty-sdk/app/theme';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { prepare, inputSnapshot, repository, fingerprint, completeBundle, buildEnvironment, start } from './local-runtime.mjs';
const roots = [];
const fontAssets = ['plex-sans', 'jetbrains-mono'].flatMap(family => [
  ...['latin', 'latin-ext', 'cyrillic'].map(subset => `fonts/${family}-${subset}.woff2`), `fonts/${family}-LICENSE.txt`,
]);
const bundleAssets = ['main.mjs','native-runner.mjs','native-windows.mjs','windows-native-job.ps1','windows-native-job.cs',
  'claude-child-history.mjs','settings-browser.mjs','hosty-theme.css','settings-bootstrap.js','settings.css',...fontAssets];
async function writeFixtureOutput(output, file, contents) {
  const target = path.join(output,file); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,contents);
}
async function copySnapshot(root) {
  const files = await inputSnapshot(repository,'codex-provider');
  for (const file of files) await writeFixtureOutput(root,file.path,file.bytes);
  return files;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'hosty-provider-local-')); roots.push(parent);
  const root = path.join(parent, 'source'), cache = path.join(parent, 'cache'); await mkdir(root);
  await mkdir(path.join(root, 'node_modules')); await writeFile(path.join(root, 'node_modules/other-provider'), 'keep');
  await writeFile(path.join(root, 'input'), 'first'); let builds = 0;
  const snapshot = async () => [{ path: 'input', bytes: await readFile(path.join(root, 'input')) }];
  const options = { root, cache, slug: 'codex-provider', snapshot, log() {}, buildBundle: async (directory, slug) => {
    builds++; const output = path.join(directory, 'apps', slug, 'dist'); await mkdir(output, { recursive: true });
    for (const file of bundleAssets)
      await writeFixtureOutput(output, file, 'built ' + await readFile(path.join(directory, 'input'), 'utf8'));
    await mkdir(path.join(directory, 'node_modules')); await writeFile(path.join(directory, 'node_modules/native-provider'), slug);
  } };
  return { root, cache, options, builds: () => builds };
}
it('prepares once under the provider cache, serializes callers and never mutates shared dependencies', async () => {
  const f = await fixture(), values = await Promise.all([prepare(f.options), prepare(f.options)]);
  expect(values[0]).toBe(values[1]); expect(f.builds()).toBe(1);
  expect(values[0].startsWith(f.cache + path.sep)).toBe(true);
  expect(await readFile(path.join(f.root, 'node_modules/other-provider'), 'utf8')).toBe('keep');
  expect(await readdir(f.root)).toEqual(['input','node_modules']);
});
it('keeps concurrently prepared providers in independent generations and preserves the first native package', async () => {
  const f = await fixture();
  const [codex, claude] = await Promise.all([prepare(f.options), prepare({ ...f.options, slug: 'claude-code-provider' })]);
  expect(codex).not.toBe(claude);
  expect(await readFile(path.join(codex,'node_modules/native-provider'),'utf8')).toBe('codex-provider');
  expect(await readFile(path.join(claude,'node_modules/native-provider'),'utf8')).toBe('claude-code-provider');
  expect(await prepare(f.options)).toBe(codex); expect(f.builds()).toBe(2);
});
it('invalidates changed source and toolchain while retaining existing consumers generations', async () => {
  const f = await fixture(), first = await prepare(f.options);
  await writeFile(path.join(f.root,'input'),'other'); const second = await prepare(f.options);
  const third = await prepare({ ...f.options, identity: { node:'new',platform:'other',arch:'other' } });
  expect(new Set([first,second,third]).size).toBe(3);
  expect(await readFile(path.join(first,'apps/codex-provider/dist/main.mjs'),'utf8')).toBe('built first');
});
it('publishes a new generation for damaged output without renaming the old consumer path', async () => {
  const f = await fixture(), first = await prepare(f.options);
  await rm(path.join(first,'apps/codex-provider/dist/windows-native-job.cs'));
  const second = await prepare(f.options); expect(second).not.toBe(first);
  expect(await readFile(path.join(first,'apps/codex-provider/dist/main.mjs'),'utf8')).toBe('built first');
  expect(await completeBundle(second,fingerprint(await f.options.snapshot()),f.options.slug)).toBe(true);
});
it.each(['claude-child-history.mjs','hosty-theme.css','settings-bootstrap.js','settings.css',...fontAssets])('rejects an older cache receipt that omits required asset %s', async file => {
  const f = await fixture(), first = await prepare(f.options), receiptPath = path.join(first,'bundle.json');
  const receipt = JSON.parse(await readFile(receiptPath,'utf8'));
  receipt.files = receipt.files.filter(([entry]) => entry !== `apps/codex-provider/dist/${file}`);
  await writeFile(receiptPath,JSON.stringify(receipt)); await rm(path.join(first,'apps/codex-provider/dist',file));
  expect(await completeBundle(first,fingerprint(await f.options.snapshot()),f.options.slug)).toBe(false);
  const second = await prepare(f.options);
  expect(second).not.toBe(first); expect(f.builds()).toBe(2);
  expect(await completeBundle(second,fingerprint(await f.options.snapshot()),f.options.slug)).toBe(true);
});
it('does not publish failed or moving-source builds and permits an explicit clean retry', async () => {
  const f = await fixture();
  await expect(prepare({ ...f.options, buildBundle: () => { throw new Error('failed build'); } })).rejects.toThrow('failed build');
  await expect(prepare({ ...f.options, buildBundle: async (...args) => { await f.options.buildBundle(...args); await writeFile(path.join(f.root,'input'),'moving'); } })).rejects.toThrow('source changed');
  const prepared = await prepare(f.options); expect(prepared).toContain('provider-runtime');
});
it('requires an external Core-managed cache and strips app/control/loader credentials from build subprocesses', async () => {
  const f = await fixture();
  await expect(prepare({ ...f.options, cache: undefined })).rejects.toThrow('HOSTY_APP_CACHE_DIR');
  await expect(prepare({ ...f.options, cache: path.join(f.root,'.cache') })).rejects.toThrow('outside');
  expect(buildEnvironment({ PATH:'/tools',HOSTY_APP_SERVICE_TOKEN:'secret',HOSTY_CORE_CONTROL_SECRET:'private',NODE_OPTIONS:'--import=other' }))
    .toEqual({ PATH:'/tools',NODE_ENV:'production' });
});
it('projects only the selected native SDK and build dependencies, omitting other apps and test toolchains', async () => {
  const before = await readFile(path.join(repository,'package-lock.json'));
  for (const [slug, included, excluded] of [['codex-provider','@openai/codex','@anthropic-ai/claude-agent-sdk'],
    ['claude-code-provider','@anthropic-ai/claude-agent-sdk','@openai/codex'],['ollama-provider',null,'@openai/codex']]) {
    const files = await inputSnapshot(repository,slug), lock = JSON.parse(files.find(file => file.path==='package-lock.json').bytes);
    if (included) expect(lock.packages['node_modules/'+included]).toBeDefined();
    expect(lock.packages['node_modules/'+excluded]).toBeUndefined();
    expect(lock.packages['node_modules/vitest']).toBeUndefined(); expect(lock.packages['node_modules/next']).toBeUndefined();
    expect(files.some(file => /\.(test|spec)\./.test(file.path))).toBe(false);
    expect(files.some(file => file.path.startsWith('apps/harness/'))).toBe(false);
    expect(files.some(file => file.path==='scripts/npm-workspace.mjs')).toBe(true);
    expect(files.filter(file => file.path.startsWith('shared/')).map(file => file.path).sort()).toEqual(
      ['shared/web/hosty-theme.css',...fontAssets.map(file => 'shared/web/'+file)].sort());
  }
  expect(await readFile(path.join(repository,'package-lock.json'))).toEqual(before);
});

it('invalidates the snapshot for shared CSS and font changes while omitting unrelated shared files', async () => {
  const f = await fixture(); await copySnapshot(f.root);
  const snapshot = () => inputSnapshot(f.root,'codex-provider'), key = fingerprint(await snapshot());
  for (const file of ['shared/web/hosty-theme.css','shared/web/fonts/plex-sans-latin.woff2']) {
    const target = path.join(f.root,file), original = await readFile(target);
    await writeFile(target,Buffer.concat([original,Buffer.from('\nchanged')]));
    expect(fingerprint(await snapshot())).not.toBe(key);
    await writeFile(target,original); expect(fingerprint(await snapshot())).toBe(key);
  }
  await writeFile(path.join(f.root,'shared/web/unrelated.css'),'unrelated');
  expect(fingerprint(await snapshot())).toBe(key);
});

it('rejects a symlinked shared font input instead of reading outside the source closure', async () => {
  const f = await fixture(); await copySnapshot(f.root);
  const fonts = path.join(f.root,'shared/web/fonts'); await rm(fonts,{recursive:true});
  await symlink(path.join(f.root,'packages'),fonts,process.platform==='win32'?'junction':'dir');
  await expect(inputSnapshot(f.root,'codex-provider')).rejects.toThrow('Provider build input must not be a symlink: shared/web/fonts');
});

it('copies canonical CSS, font subsets and license notices into every provider bundle with an isolated compiler fixture', async () => {
  const f = await fixture(), script = 'packages/agent-provider-runtime/scripts/build.mjs';
  await writeFixtureOutput(f.root,script,await readFile(path.join(repository,script)));
  await writeFixtureOutput(f.root,'node_modules/esbuild/package.json',JSON.stringify({name:'esbuild',type:'module',exports:'./index.mjs'}));
  await writeFixtureOutput(f.root,'node_modules/esbuild/index.mjs',"import { writeFile } from 'node:fs/promises'; export const build = options => writeFile(options.outfile, '// isolated compiler fixture');");
  await writeFixtureOutput(f.root,'node_modules/@hosty-sdk/app/package.json',JSON.stringify({name:'@hosty-sdk/app',type:'module',exports:{'.':'./index.mjs','./theme':'./theme.mjs'}}));
  await writeFixtureOutput(f.root,'node_modules/@hosty-sdk/app/index.mjs','export const launchModeBootstrapScript='+JSON.stringify(launchModeBootstrapScript)+';');
  await writeFixtureOutput(f.root,'node_modules/@hosty-sdk/app/theme.mjs','export const themeBootstrapScript='+JSON.stringify(themeBootstrapScript)+';');
  const copies = new Map([
    ['hosty-theme.css','shared/web/hosty-theme.css'], ['settings.css','packages/agent-provider-runtime/src/settings.css'],
    ['claude-child-history.mjs','packages/agent-provider-runtime/src/claude-child-history.mjs'],
    ...fontAssets.map(file => [file,'shared/web/'+file]),
  ]);
  for (const source of copies.values()) await writeFixtureOutput(f.root,source,await readFile(path.join(repository,source)));
  for (const file of ['native-runner.mjs','native-windows.mjs','windows-native-job.ps1','windows-native-job.cs'])
    await writeFixtureOutput(f.root,'packages/agent-provider-runtime/src/'+file,'fixture');
  for (const slug of ['codex-provider','claude-code-provider','ollama-provider']) {
    await writeFixtureOutput(f.root,`apps/${slug}/package.json`,JSON.stringify({name:`@hosty/${slug}`,version:'0.1.0'}));
    await promisify(execFile)(process.execPath,[path.join(f.root,script),slug],{cwd:f.root});
    expect(await readFile(path.join(f.root,'apps',slug,'dist/settings-bootstrap.js'),'utf8')).toBe(launchModeBootstrapScript+'\n'+themeBootstrapScript);
    for (const [asset, source] of copies)
      expect(await readFile(path.join(f.root,'apps',slug,'dist',asset))).toEqual(await readFile(path.join(repository,source)));
  }
});

it('starts only its private prepared executable and ignores unrelated lock entries in the generation key', async () => {
  const f = await fixture(); await copySnapshot(f.root);
  const key = fingerprint(await inputSnapshot(f.root,'codex-provider'));
  const lockFile = path.join(f.root,'package-lock.json'), lock = JSON.parse(await readFile(lockFile,'utf8'));
  lock.packages['node_modules/unrelated-app-only'] = { version:'1.2.3',resolved:'https://example.test/unrelated.tgz',integrity:'sha512-unrelated' };
  await writeFile(lockFile,JSON.stringify(lock));
  expect(fingerprint(await inputSnapshot(f.root,'codex-provider'))).toBe(key);
  const options = { root:f.root,cache:f.cache,slug:'codex-provider',log(){},buildBundle:async directory => {
    const output=path.join(directory,'apps/codex-provider/dist');await mkdir(output,{recursive:true});
    await writeFile(path.join(output,'main.mjs'),'export const executable = import.meta.url;');
    for(const file of bundleAssets.filter(file=>file!=='main.mjs'))await writeFixtureOutput(output,file,'fixture');
  } };
  const prepared=await prepare(options), before=process.env.NODE_ENV;
  try { expect((await start(options)).executable).toContain(prepared); }
  finally { if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before; }
  expect(await readFile(path.join(f.root,'node_modules/other-provider'),'utf8')).toBe('keep');
});

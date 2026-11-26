import { realpathSync } from "node:fs";
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, lstat, stat, rename, rm, rmdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectNpm } from '../../../scripts/npm-workspace.mjs';
import { applicationSlug, commonAssets, providerBuildConfig } from './build-config.mjs';

import { initializeGeneration, useGeneration, generationBuildEnvironment, reclaimGenerations } from './generation-use.mjs';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
const selected = applicationSlug;
export const platformIdentity = () => ({ node: process.version, platform: process.platform, arch: process.arch });
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const excluded = /(?:^|\/)(?:node_modules|dist|[^/]+\.(?:test|spec)\.[^/]+|__tests__)(?:\/|$)/;

/** Copy only this app's build inputs; unrelated workspace lock entries never enter its cache key. */
export async function inputSnapshot(root, slug) {
  selected(slug);
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const workspaces = [`apps/${slug}`, 'packages/agent-provider-runtime', 'packages/app-sdk'];
  const rootPackage = await json('package.json'), sourceLock = await json('package-lock.json');
  const lock = structuredClone(sourceLock), generated = new Map();
  // Bundling needs esbuild, not the SDK's UI/test toolchain or another provider's optional SDK.
  for (const workspace of workspaces) {
    const manifest = await json(workspace + '/package.json');
    manifest.devDependencies = workspace === 'packages/agent-provider-runtime'
      ? { esbuild: manifest.devDependencies.esbuild } : {};
    generated.set(workspace + '/package.json', Buffer.from(canonical(manifest)));
    lock.packages[workspace] = { ...lock.packages[workspace], devDependencies: manifest.devDependencies };
  }
  const projection = projectNpm(rootPackage, lock, workspaces, { ignoreOptionalPeers: true });
  generated.set('package.json', Buffer.from(canonical(projection.package)));
  generated.set('package-lock.json', Buffer.from(canonical(projection.lock)));
  const paths = new Set(['scripts/npm-workspace.mjs']);
  async function visit(relative) {
    if (excluded.test(relative)) return;
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error('Provider build input must not be a symlink: ' + relative);
    if (info.isDirectory()) for (const name of (await readdir(path.join(root, relative))).sort()) await visit(relative + '/' + name);
    else if (info.isFile()) paths.add(relative);
  }
  for (const entry of [`apps/${slug}/src`, `apps/${slug}/manifest.json`,
    'packages/agent-provider-runtime/src', 'packages/agent-provider-runtime/scripts', 'packages/app-sdk/src',
    'shared/web/hosty-theme.css', 'shared/web/fonts']) await visit(entry);
  const files = [...generated].map(([file, bytes]) => ({ path: file, bytes }));
  for (const file of paths) if (!generated.has(file)) files.push({ path: file, bytes: await readFile(path.join(root, file)) });
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export function fingerprint(files, identity = platformIdentity()) {
  const hash = createHash('sha256').update(JSON.stringify(identity));
  for (const file of files) hash.update('\0' + file.path + '\0').update(file.bytes);
  return hash.digest('hex');
}
async function inventory(root, relative = '') {
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const item = path.posix.join(relative, name), target = path.join(root, item), info = await lstat(target);
    if (info.isSymbolicLink()) files.push([item, info.size, await readlink(target)]);
    else if (info.isDirectory()) files.push(...await inventory(root, item));
    else if (info.isFile()) files.push([item, info.size]);
  }
  return files;
}
export async function completeBundle(directory, key, slug) {
  try {
    const receipt = JSON.parse(await readFile(path.join(directory, 'bundle.json'), 'utf8'));
    if (receipt.key !== key || receipt.slug !== slug || !Array.isArray(receipt.files) || !receipt.files.length) return false;
    for (const [file, size, link] of receipt.files) {
      const target = path.resolve(directory, file);
      if (!target.startsWith(directory + path.sep)) return false;
      const info = await lstat(target);
      if (link !== undefined) {
        if (!info.isSymbolicLink() || await readlink(target) !== link) return false;
        const resolved = path.resolve(path.dirname(target), link);
        if (!resolved.startsWith(directory + path.sep)) return false;
        await stat(target);
      } else if (!info.isFile() || info.size !== size) return false;
    }
    const { assets } = await providerBuildConfig(directory, slug);
    const fonts = ['plex-sans', 'jetbrains-mono'].flatMap(family => [
      ...['latin', 'latin-ext', 'cyrillic'].map(subset => `fonts/${family}-${subset}.woff2`), `fonts/${family}-LICENSE.txt`,
    ]);
    return ['main.mjs', ...commonAssets, ...assets.map(asset => asset.target),
      'settings-browser.mjs', 'hosty-theme.css', 'settings-bootstrap.js', 'settings.css', ...fonts]
      .every(file => receipt.files.some(([entry]) => entry === `apps/${slug}/dist/${file}`));
  } catch { return false; }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function lock(store) {
  const directory = path.join(store, 'prepare.lock'), id = randomUUID();
  const candidate = path.join(store, '.lock-' + id), ownerFile = 'owner-' + id + '.json';
  await mkdir(candidate); await writeFile(path.join(candidate, ownerFile), JSON.stringify({ pid: process.pid }));
  const deadline = Date.now() + 300_000;
  async function removeEmpty() { try { await rmdir(directory); } catch (error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; } }
  try {
    while (true) {
      try {
        await rename(candidate, directory);
        return async () => { await rm(path.join(directory, ownerFile), { force: true }); await removeEmpty(); };
      } catch (error) {
        if (!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)) throw error;
        try {
          const entries = await readdir(directory);
          if (!entries.length) await removeEmpty();
          else {
            if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) throw new Error('Invalid provider preparation lock.');
            const ownerPath = path.join(directory, entries[0]), owner = JSON.parse(await readFile(ownerPath, 'utf8'));
            if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid provider preparation owner.');
            try { process.kill(owner.pid, 0); }
            catch (probe) { if (probe.code === 'ESRCH') { await rm(ownerPath, { force: true }); await removeEmpty(); } else if (probe.code !== 'EPERM') throw probe; }
          }
        } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for provider preparation.');
        await wait(100);
      }
    }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}
export function buildEnvironment(input = process.env) {
  const env = {};
  for (const key of ['PATH','HOME','USERPROFILE','SystemRoot','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','LANG',
    'LOCALAPPDATA','APPDATA','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','NO_PROXY'])
    if (input[key]) env[key] = input[key];
  return { ...env, NODE_ENV: 'production' };
}
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...buildEnvironment(), ...generationBuildEnvironment(cwd) }, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(command + ' failed (' + (signal || code) + ').')));
  });
}
export async function build(snapshot, slug) {
  await run('npm', ['ci','--ignore-scripts','--include=dev','--workspaces','--include-workspace-root=false','--no-audit','--no-fund'], snapshot);
  await run(process.execPath, ['packages/agent-provider-runtime/scripts/build.mjs', slug], snapshot);
  // The executable bundles every workspace import. Remove npm workspace junctions before the
  // atomic directory move; Windows junctions can name the staging directory absolutely.
  const rootPackage = JSON.parse(await readFile(path.join(snapshot, 'package.json'), 'utf8'));
  for (const workspace of rootPackage.workspaces) {
    const manifest = JSON.parse(await readFile(path.join(snapshot, workspace, 'package.json'), 'utf8'));
    const link = path.join(snapshot, 'node_modules', manifest.name);
    if ((await lstat(link)).isSymbolicLink()) await rm(link, { recursive: true, force: true });
    else throw new Error('Expected an npm workspace link in the private build snapshot.');
  }
}
function cacheStore(cache, root, slug) {
  selected(slug);
  if (typeof cache !== 'string' || !path.isAbsolute(cache)) throw new Error('Core must supply an absolute HOSTY_APP_CACHE_DIR.');
  const store = path.resolve(cache, 'provider-runtime', slug), relative = path.relative(path.resolve(root), store);
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    throw new Error('Provider cache must be outside its source checkout.');
  return store;
}
async function generationFor(store, key) {
  try {
    const pointer = JSON.parse(await readFile(path.join(store, key + '.json'), 'utf8'));
    // Retain old hash-prefixed generations without adding that hash to every native binary path.
    const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const directory = typeof pointer.directory === 'string'
      ? new RegExp('(?:g|' + key + ')-' + uuid).exec(pointer.directory)?.[0] : undefined;
    if (pointer.key !== key || !directory || directory !== pointer.directory) return null;
    return path.join(store, directory);
  } catch { return null; }
}
export async function prepare({ root = repository, slug, cache = process.env.HOSTY_APP_CACHE_DIR,
  identity = platformIdentity(), snapshot = () => inputSnapshot(root, slug), buildBundle = build, log = console.log } = {}) {
  const store = cacheStore(cache, root, slug), files = await snapshot(), key = fingerprint(files, identity);
  await mkdir(store, { recursive: true }); const release = await lock(store);
  try {
    const previous = await generationFor(store, key);
    await reclaimGenerations(store, previous);
    if (previous && await completeBundle(previous, key, slug)) { log('[provider-runtime] Reusing ' + slug + ' ' + key.slice(0,12)); return previous; }
    // A full hash here pushes packaged native executables past Windows CreateProcess limits.
    // The pointer and bundle receipt still retain the full source/toolchain fingerprint.
    const id = randomUUID(), staging = path.join(store, '.build-' + id), generation = path.join(store, 'g-' + id);
    await mkdir(staging);
    initializeGeneration(staging);
    try {
      for (const file of files) {
        const target = path.join(staging, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.bytes);
      }
      await buildBundle(staging, slug);
      await writeFile(path.join(staging, 'bundle.json'), JSON.stringify({ key, slug, identity, files: await inventory(staging) }));
      if (!await completeBundle(staging, key, slug)) throw new Error('Provider production bundle is incomplete.');
      if (fingerprint(await snapshot(), identity) !== key) throw new Error('Provider source changed during preparation; retry with the current source.');
      // Never alter an older generation: another local provider process may still use it.
      await rename(staging, generation);
      const pointer = path.join(store, key + '.json'), temporary = pointer + '.' + id + '.tmp';
      await writeFile(temporary, JSON.stringify({ key, directory: path.basename(generation) })); await rename(temporary, pointer);
      log('[provider-runtime] Prepared ' + slug + ' ' + key.slice(0,12)); return generation;
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await release(); }
}
export async function start({ root = repository, slug, cache = process.env.HOSTY_APP_CACHE_DIR } = {}) {
  const store = cacheStore(cache, root, slug), key = fingerprint(await inputSnapshot(root, slug));
  const release = await lock(store);
  let generation;
  try {
    generation = await generationFor(store, key);
    if (!generation || !await completeBundle(generation, key, slug)) throw new Error('Provider bundle is absent or incomplete; run its Core-managed setup first.');
    useGeneration(generation);
  } finally { await release(); }
  process.env.HOSTY_PROVIDER_GENERATION = generation;
  process.env.HOSTY_PROVIDER_ENTRY = path.join(generation, 'apps', slug, 'dist/main.mjs');
  process.env.NODE_ENV = 'production';
  return import(pathToFileURL(path.join(generation, 'apps', slug, 'dist/main.mjs')).href);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Local providers require Node.js 24 or newer.');
    if (process.argv[2] === 'prepare') await prepare({ slug: process.argv[3] });
    else if (process.argv[2] === 'start') await start({ slug: process.argv[3] });
    else throw new Error('Usage: node packages/agent-provider-runtime/scripts/local-runtime.mjs prepare|start <provider-directory>');
  } catch (error) { console.error('[provider-runtime] ' + error.message); process.exitCode = 1; }
}

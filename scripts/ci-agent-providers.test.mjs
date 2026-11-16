import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stageProviderChecks, validateProviderChecks, selectedProviders, PROVIDERS } from './ci-agent-providers.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-ci-source-')), output = await mkdtemp(path.join(tmpdir(), 'provider-ci-staged-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  const workspaces = ['packages/agent-provider-runtime', 'packages/app-sdk', ...PROVIDERS.map(slug => `apps/${slug}`), 'apps/unrelated'];
  const packages = { '': { workspaces } };
  const write = async (relative, value) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), value); };
  for (const workspace of workspaces) {
    const name = workspace === 'packages/app-sdk' ? '@hosty-sdk/app' : workspace === 'packages/agent-provider-runtime' ? '@hosty/agent-provider-runtime' : '@hosty/' + path.basename(workspace);
    const manifest = { name, version: '1.0.0', ...(workspace.startsWith('apps/') && workspace !== 'apps/unrelated' ? { dependencies: { '@hosty/agent-provider-runtime': '*' } } : {}) };
    packages[workspace] = manifest; packages['node_modules/' + name] = { link: true, resolved: workspace };
    await write(workspace + '/package.json', JSON.stringify(manifest)); await write(workspace + '/src/fixture.ts', 'retained source');
    await write(workspace + '/node_modules/stale', 'never use checkout modules'); await write(workspace + '/dist/stale', 'never use checkout outputs');
  }
  packages['packages/agent-provider-runtime'].dependencies = { '@hosty-sdk/app': '*' };
  packages['packages/agent-provider-runtime'].peerDependencies = { 'unused-native': '*' };
  packages['packages/agent-provider-runtime'].peerDependenciesMeta = { 'unused-native': { optional: true } };
  packages['node_modules/unused-native'] = { version: '1.0.0', resolved: 'https://example.test/native.tgz', integrity: 'sha512-proof' };
  await write('package.json', JSON.stringify({ workspaces, scripts: { unrelated: 'must not execute' } }));
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
  await write('scripts/npm-workspace.mjs', 'projection implementation'); await write('shared/web/hosty-theme.css', 'theme'); await write('shared/web/fonts/font.woff2', 'font');
  return { root, output };
}
test('isolates the selected locked runtime/vendor workspace closure and keeps test/config/source inputs', async t => {
  const f = await fixture(t), projection = await stageProviderChecks(f.root, f.output);
  assert.equal(projection.workspaces.length, 5); assert.ok(!projection.workspaces.includes('apps/unrelated'));
  const lock = JSON.parse(await readFile(path.join(f.output, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['apps/unrelated'], undefined); assert.equal(lock.packages['node_modules/unused-native'], undefined);
  assert.equal((await readFile(path.join(f.output, 'packages/agent-provider-runtime/src/fixture.ts'), 'utf8')), 'retained source');
  assert.equal((await readFile(path.join(f.output, 'shared/web/hosty-theme.css'), 'utf8')), 'theme');
  for (const relative of ['apps/unrelated', 'packages/agent-provider-runtime/node_modules', 'packages/agent-provider-runtime/dist']) await assert.rejects(stat(path.join(f.output, relative)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.root, 'packages/agent-provider-runtime/node_modules/stale'), 'utf8'), 'never use checkout modules');
});
test('installs once, runs common runtime checks once and retains each selected provider lint/build', async t => {
  const f = await fixture(t), commands = [];
  await validateProviderChecks({ ...f, plan: { version: 1, components: ['codex-provider', 'ollama-provider'] }, execute: async (args, cwd) => { assert.equal(cwd, f.output); commands.push(args); } });
  assert.equal(commands.filter(args => args[0] === 'ci').length, 1);
  assert.deepEqual(commands.slice(1), [
    ['run', 'lint', '--workspace', '@hosty/agent-provider-runtime'], ['run', 'test', '--workspace', '@hosty/agent-provider-runtime'],
    ['run', 'lint', '--workspace', '@hosty/codex-provider'], ['run', 'build', '--workspace', '@hosty/codex-provider'],
    ['run', 'lint', '--workspace', '@hosty/ollama-provider'], ['run', 'build', '--workspace', '@hosty/ollama-provider'],
  ]);
});
test('a failed selected check cannot be replaced by a later build or a successful shared test', async t => {
  const f = await fixture(t), commands = [];
  await assert.rejects(validateProviderChecks({ ...f, plan: { version: 1, components: ['claude-code-provider'] }, execute: async args => {
    commands.push(args); if (args[1] === 'lint' && args.at(-1) === '@hosty/claude-code-provider') throw new Error('selected lint failed');
  } }), /selected lint failed/);
  assert.equal(commands.some(args => args[1] === 'build'), false);
});
test('missing/empty selected-provider plans cannot produce a green job', () => {
  for (const plan of [null, {}, { version: 2, components: PROVIDERS }, { version: 1, components: ['harness'] }]) assert.throws(() => selectedProviders(plan));
  assert.deepEqual(selectedProviders({ version: 1, components: [...PROVIDERS, ...PROVIDERS] }), PROVIDERS);
});


test('rejects workspace symlinks instead of resolving dependencies or source from outside the isolated copy', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, 'apps/unrelated/src/fixture.ts'), path.join(f.root, 'packages/agent-provider-runtime/src/escape.ts'));
  await assert.rejects(stageProviderChecks(f.root, f.output), /must not be symlinks/);
});

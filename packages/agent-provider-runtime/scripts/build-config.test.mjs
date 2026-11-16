import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationSlug, providerBuildConfig } from './build-config.mjs';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(declaration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-build-config-')); roots.push(root);
  await mkdir(path.join(root, 'apps/independent-engine'), { recursive: true });
  await writeFile(path.join(root, 'apps/independent-engine/package.json'), JSON.stringify({ name: '@independent/engine', hostyAgentProvider: declaration }));
  return root;
}
it('accepts an independent application and preserves its declared dependencies, helpers and probes', async () => {
  const declaration = { external: ['@independent/native'], assets: [{ source: 'src/native-helper.mjs', target: 'native-helper.mjs' }], nativeTests: ['test/native.mjs'] };
  const root = await fixture(declaration), value = await providerBuildConfig(root, 'independent-engine');
  expect(value).toMatchObject(declaration);
  expect(value.application).toBe(path.join(root, 'apps/independent-engine'));
});
it.each(['../other', '/absolute', 'nested/application', '', undefined])('rejects an invalid application directory %s', value => {
  expect(() => applicationSlug(value)).toThrow('application directory');
});
it.each([
  { source: '../outside.mjs', target: 'helper.mjs' },
  { source: 'src/helper.mjs', target: '../outside.mjs' },
  { source: 'src/helper.mjs', target: 'native-runner.mjs' },
])('rejects escaping or duplicate application helper outputs %j', async asset => {
  await expect(providerBuildConfig(await fixture({ assets: [asset] }), 'independent-engine')).rejects.toThrow();
});

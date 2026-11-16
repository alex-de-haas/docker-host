import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const commonAssets = ['native-runner.mjs', 'native-windows.mjs', 'windows-native-job.ps1', 'windows-native-job.cs'];
export function applicationSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Select an application directory.');
  return slug;
}
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Provider build files must use relative paths inside the application.');
  return value;
}
/** Applications declare their native dependencies and helper files; the runtime owns no engine catalog. */
export async function providerBuildConfig(root, slug) {
  const application = path.join(root, 'apps', applicationSlug(slug));
  const manifest = JSON.parse(await readFile(path.join(application, 'package.json'), 'utf8'));
  const declaration = manifest.hostyAgentProvider ?? {};
  const external = declaration.external ?? [], assets = declaration.assets ?? [], nativeTests = declaration.nativeTests ?? [];
  if (!Array.isArray(external) || external.some(value => typeof value !== 'string' || !value)
    || !Array.isArray(assets) || !Array.isArray(nativeTests)) throw new Error('Invalid provider build declaration.');
  const targets = new Set(commonAssets);
  for (const asset of assets) {
    relativeFile(asset.source); relativeFile(asset.target);
    if (targets.has(asset.target)) throw new Error('Provider helper assets must have distinct output paths.');
    targets.add(asset.target);
  }
  nativeTests.forEach(relativeFile);
  return { application, manifest, external, assets, nativeTests };
}

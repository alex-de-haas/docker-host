import { build } from 'esbuild';
import { launchModeBootstrapScript } from '@hosty-sdk/app';
import { themeBootstrapScript } from '@hosty-sdk/app/theme';
import { mkdir, writeFile, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonAssets, providerBuildConfig } from './build-config.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { application, manifest, external, assets } = await providerBuildConfig(repository, process.argv[2]);
const output = path.join(application, 'dist');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(application, 'src/main.ts')], outfile: path.join(output, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
  external, banner: { js: "import { createRequire as hostyCreateRequire } from 'node:module'; const require = hostyCreateRequire(import.meta.url);" } });
await build({ entryPoints: [path.join(repository, 'packages/agent-provider-runtime/src/settings-browser.mjs')], outfile: path.join(output, 'settings-browser.mjs'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true });
for (const asset of commonAssets)
  await copyFile(path.join(repository, 'packages/agent-provider-runtime/src', asset), path.join(output, asset));
for (const asset of assets) {
  const target = path.join(output, asset.target); await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(application, asset.source), target);
}
await writeFile(path.join(output, 'settings-bootstrap.js'), launchModeBootstrapScript + '\n' + themeBootstrapScript);
await copyFile(path.join(repository, 'shared/web/hosty-theme.css'), path.join(output, 'hosty-theme.css'));
await copyFile(path.join(repository, 'packages/agent-provider-runtime/src/settings.css'), path.join(output, 'settings.css'));
await cp(path.join(repository, 'shared/web/fonts'), path.join(output, 'fonts'), { recursive: true });
await writeFile(path.join(output, 'build.json'), JSON.stringify({ application: manifest.name, version: manifest.version, node: process.versions.node }) + '\n');
console.log('Built ' + manifest.name + ' with independent settings and native provider dependencies.');

import { build } from 'esbuild';
import { launchModeBootstrapScript } from '@hosty-sdk/app';
import { themeBootstrapScript } from '@hosty-sdk/app/theme';
import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const slug = process.argv[2];
if (!['codex-provider','claude-code-provider','ollama-provider'].includes(slug)) throw new Error('Select a provider application directory.');
const application = path.join(repository,'apps',slug), output = path.join(application,'dist');
await mkdir(output,{recursive:true});
await build({entryPoints:[path.join(application,'src/main.ts')],outfile:path.join(output,'main.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:true,
  external:['@openai/codex','@openai/codex/*','@anthropic-ai/claude-agent-sdk','@anthropic-ai/claude-agent-sdk/*'],
  banner:{js:"import { createRequire as hostyCreateRequire } from 'node:module'; const require = hostyCreateRequire(import.meta.url);"}});
await build({entryPoints:[path.join(repository,'packages/agent-provider-runtime/src/settings-browser.mjs')],outfile:path.join(output,'settings-browser.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true});
for (const asset of ['native-runner.mjs','native-windows.mjs','windows-native-job.ps1','windows-native-job.cs','claude-child-history.mjs'])
  await copyFile(path.join(repository,'packages/agent-provider-runtime/src',asset),path.join(output,asset));
await writeFile(path.join(output,'settings-bootstrap.js'),launchModeBootstrapScript+'\n'+themeBootstrapScript);
await copyFile(path.join(repository,'shared/web/hosty-theme.css'),path.join(output,'hosty-theme.css'));
await copyFile(path.join(repository,'packages/agent-provider-runtime/src/settings.css'),path.join(output,'settings.css'));
await cp(path.join(repository,'shared/web/fonts'),path.join(output,'fonts'),{recursive:true});
const manifest = JSON.parse(await readFile(path.join(application,'package.json'),'utf8'));
await writeFile(path.join(output,'build.json'),JSON.stringify({application:manifest.name,version:manifest.version,node:process.versions.node})+'\n');
console.log('Built '+manifest.name+' with independent settings and native provider dependencies.');

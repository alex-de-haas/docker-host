#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectNpm } from './npm-workspace.mjs';

export const PROVIDERS = Object.freeze(['codex-provider', 'claude-code-provider', 'ollama-provider']);
const roots = ['packages/agent-provider-runtime', 'packages/app-sdk', ...PROVIDERS.map(slug => `apps/${slug}`)];
const excluded = new Set(['node_modules', 'dist', '.next', 'out', 'out-build', '.local-runtime', '.git']);
export function selectedProviders(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.components)) throw new Error('A qualified CI component selection is required.');
  const selected = PROVIDERS.filter(slug => plan.components.includes(slug));
  if (!selected.length) throw new Error('No agent provider was selected for this job.');
  return selected;
}

/** Preserve the exact lock graph, including both SDKs needed to typecheck the shared runtime.
 * No unrelated application, build output or node_modules from the checkout enters this install. */
export async function stageProviderChecks(root, output) {
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const projection = projectNpm(await json('package.json'), await json('package-lock.json'), roots, { ignoreOptionalPeers: true });
  await mkdir(output, { recursive: true });
  for (const workspace of projection.workspaces) {
    await cp(path.join(root, workspace), path.join(output, workspace), { recursive: true,
      filter: async source => {
        if (path.relative(path.join(root, workspace), source).split(path.sep).some(part => excluded.has(part))) return false;
        if ((await lstat(source)).isSymbolicLink()) throw new Error('Provider CI source inputs must not be symlinks.');
        return true;
      } });
  }
  for (const relative of ['scripts/npm-workspace.mjs', 'shared/web/hosty-theme.css', 'shared/web/fonts'])
    await cp(path.join(root, relative), path.join(output, relative), { recursive: true });
  await writeFile(path.join(output, 'package.json'), JSON.stringify(projection.package, null, 2) + '\n');
  await writeFile(path.join(output, 'package-lock.json'), JSON.stringify(projection.lock, null, 2) + '\n');
  return projection;
}
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Provider CI command failed: npm ${args.join(' ')} (${signal ?? code}).`)));
  });
}
export async function validateProviderChecks({ root, output, plan, execute = run }) {
  const providers = selectedProviders(plan);
  await stageProviderChecks(root, output);
  await execute(['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'], output);
  await execute(['run', 'lint', '--workspace', '@hosty/agent-provider-runtime'], output);
  await execute(['run', 'test', '--workspace', '@hosty/agent-provider-runtime'], output);
  for (const slug of providers) {
    await execute(['run', 'lint', '--workspace', `@hosty/${slug}`], output);
    await execute(['run', 'build', '--workspace', `@hosty/${slug}`], output);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let output;
  try {
    const plan = JSON.parse(process.env.CI_PLAN ?? 'null'); selectedProviders(plan);
    output = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'hosty-provider-ci-'));
    await validateProviderChecks({ root: fileURLToPath(new URL('../', import.meta.url)), output, plan });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (output) await rm(output, { recursive: true, force: true }); }
}

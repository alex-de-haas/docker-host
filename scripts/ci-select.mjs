#!/usr/bin/env node
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { classifyPaths, fullPlan, planOutputs, versionOnlyBuildProps } from './ci-policy.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function resolveRevision(revision) {
  return git('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`);
}
export function changedPaths(base, head) {
  if (!base || /^0+$/.test(base)) {
    return execFileSync('git', ['ls-tree', '-rz', '--name-only', head], { encoding: 'utf8' }).split('\0').filter(Boolean);
  }
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
}
export function qualificationPlan(scope, affected) {
  if (scope === 'affected') return affected;
  if (scope === 'all') return fullPlan();
  throw new Error(`Unknown qualification scope: ${scope}`);
}
export function select(eventName, event, env = process.env) {
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(eventName)) throw new Error(`Unsupported CI event: ${eventName}`);
  if (event.inputs?.scope && event.inputs.scope !== 'all') throw new Error('Runtime qualification moved to npm run test:integration');
  const manual = eventName === 'workflow_dispatch';
  const head = resolveRevision(manual ? (event.inputs?.revision || 'origin/main') : env.GITHUB_SHA || 'HEAD');
  let base;
  if (eventName === 'pull_request') base = resolveRevision(event.pull_request.base.sha);
  else if (eventName === 'push') base = event.before && !/^0+$/.test(event.before) ? resolveRevision(event.before) : undefined;
  const paths = changedPaths(base, head);
  const versionOnlyPaths = [];
  if (base && paths.includes('Directory.Build.props')) {
    try {
      if (versionOnlyBuildProps(git('show', `${base}:Directory.Build.props`), git('show', `${head}:Directory.Build.props`))) {
        versionOnlyPaths.push('Directory.Build.props');
      }
    } catch { /* Added/deleted/unreadable configuration stays conservative. */ }
  }
  const affected = classifyPaths(paths, { versionOnlyPaths });
  const scope = manual ? 'all' : 'affected';
  return { head, base, scope, paths, plan: qualificationPlan(scope, affected) };
}
export function selectionManifest(selection) {
  return { format: 1, sourceSha: selection.head, baseSha: selection.base || null,
    components: selection.plan.components, profiles: selection.plan.profiles, required: selection.plan.required };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const env = { ...process.env };
    const selection = select(env.GITHUB_EVENT_NAME, event, env);
    const outputs = { ...planOutputs(selection.plan), sha: selection.head };
    if (env.GITHUB_EVENT_NAME === 'push') {
      if (!env.RUNNER_TEMP) throw new Error('Missing runner directory for CI selection evidence');
      const directory = join(env.RUNNER_TEMP, 'hosty-ci-selection');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'selection.json'), JSON.stringify(selectionManifest(selection)) + '\n');
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    const summary = `## CI selection\n\nSource: \`${selection.head}\`\n\nScope: ${selection.scope}\n\nRequired jobs: ${selection.plan.required.join(', ')}\n\nChanged paths: ${selection.paths.length}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(JSON.stringify(selection));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

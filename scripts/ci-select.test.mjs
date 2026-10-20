import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { qualificationPlan, changedPaths, resolveRevision, select } from './ci-select.mjs';
import { classifyPaths, fullPlan } from './ci-policy.mjs';

test('manual and nightly qualification share the automatic risk policy', () => {
  const affected = classifyPaths(['scripts/check-workspace-activation.py']);
  assert.deepEqual(qualificationPlan('nightly', affected).profiles, affected.profiles);
  assert.deepEqual(qualificationPlan('all', affected), fullPlan());
  assert.deepEqual(qualificationPlan('windows', affected).profiles, ['core-windows-process-control']);
  assert.equal(qualificationPlan('nightly', classifyPaths(['README.md'])).profiles.length, 0);
  assert.throws(() => qualificationPlan('typo', affected));
});

test('exact revisions and renamed paths are resolved from a real Git repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosty-ci-select-'));
  const previous = process.cwd();
  const command = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    command('init', '--quiet');
    command('config', 'user.email', 'ci@example.invalid');
    command('config', 'user.name', 'CI test');
    writeFileSync(join(directory, 'old.txt'), 'tracked\n');
    command('add', '.');
    command('commit', '-qm', 'base');
    const base = command('rev-parse', 'HEAD');
    command('mv', 'old.txt', 'new name.txt');
    command('commit', '-qm', 'rename');
    const head = command('rev-parse', 'HEAD');
    process.chdir(directory);
    assert.deepEqual(new Set(changedPaths(base, head)), new Set(['old.txt', 'new name.txt']));
    assert.deepEqual(changedPaths('0000000000000000000000000000000000000000', head), ['new name.txt']);
    assert.equal(resolveRevision('HEAD'), head);
    assert.throws(() => resolveRevision('--help'));
    const selection = select('pull_request', { pull_request: { base: { sha: base } } }, { GITHUB_SHA: head });
    assert.equal(selection.head, head);
    assert.deepEqual(new Set(selection.paths), new Set(['old.txt', 'new name.txt']));
    const manual = select('workflow_dispatch', { inputs: { revision: base, scope: 'lifecycle' } }, { GITHUB_SHA: head });
    assert.equal(manual.head, base);
    assert.deepEqual(manual.plan.profiles, ['workspace-native-activation']);
    assert.throws(() => select('workflow_dispatch', { inputs: { revision: 'does-not-exist' } }, {}));
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nightly baseline is the last successful scheduled main revision, with safe full fallback', async () => {
  const { previousNightly } = await import('./ci-select.mjs');
  const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'test-not-a-secret' };
  let requested;
  const sha = 'a'.repeat(40);
  const fetcher = async url => {
    requested = url;
    return { ok: true, json: async () => ({ workflow_runs: [{ event: 'schedule', head_branch: 'main', conclusion: 'success', status: 'completed', head_sha: sha }] }) };
  };
  assert.equal(await previousNightly(env, fetcher), sha);
  assert.match(requested, /event=schedule&status=success&branch=main/);
  assert.equal(await previousNightly({}, fetcher), undefined);
  assert.equal(await previousNightly(env, async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) })), undefined);
  await assert.rejects(previousNightly(env, async () => ({ ok: false, status: 403 })));
  await assert.rejects(previousNightly(env, async () => ({ ok: true, json: async () => ({ workflow_runs: [{ head_sha: sha, head_branch: 'other' }] }) })));
});

test('push selection narrows version metadata only after comparing real Git contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosty-ci-props-'));
  const previous = process.cwd();
  const command = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const props = version => `<Project><PropertyGroup><Version>${version}</Version></PropertyGroup></Project>\n`;
  try {
    command('init', '--quiet');
    command('config', 'user.email', 'ci@example.invalid');
    command('config', 'user.name', 'CI test');
    writeFileSync(join(directory, 'Directory.Build.props'), props('0.1.0'));
    command('add', '.');
    command('commit', '-qm', 'base');
    const base = command('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'Directory.Build.props'), props('0.1.1'));
    command('commit', '-qam', 'version');
    const head = command('rev-parse', 'HEAD');
    process.chdir(directory);
    const version = select('push', { before: base }, { GITHUB_SHA: head });
    assert.deepEqual(version.plan.components, ['core', 'cli']);
    assert.deepEqual(version.plan.profiles, ['core-aot']);
    writeFileSync(join(directory, 'Directory.Build.props'), '<Project><PropertyGroup><Version>0.1.1</Version><DefineConstants>NEW_RUNTIME</DefineConstants></PropertyGroup></Project>');
    command('commit', '-qam', 'build configuration');
    const config = select('push', { before: head }, { GITHUB_SHA: command('rev-parse', 'HEAD') });
    assert.ok(config.plan.profiles.includes('workspace-native-activation'));
    assert.ok(config.plan.components.includes('whisper'));
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publication manifest preserves all commits in the actual push selection', async () => {
  const { selectionManifest } = await import('./ci-select.mjs');
  const { mkdirSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'hosty-ci-multi-push-'));
  const previous = process.cwd();
  const command = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    command('init', '--quiet');
    command('config', 'user.email', 'ci@example.invalid');
    command('config', 'user.name', 'CI test');
    writeFileSync(join(directory, 'README.md'), 'base');
    command('add', '.');
    command('commit', '-qm', 'base');
    const base = command('rev-parse', 'HEAD');
    mkdirSync(join(directory, 'apps/core/src'), { recursive: true });
    writeFileSync(join(directory, 'apps/core/src/Domain.cs'), '// Core change');
    command('add', '.');
    command('commit', '-qm', 'Core');
    mkdirSync(join(directory, 'apps/shell/src'), { recursive: true });
    writeFileSync(join(directory, 'apps/shell/src/page.tsx'), '// Shell change');
    command('add', '.');
    command('commit', '-qm', 'Shell');
    const head = command('rev-parse', 'HEAD');
    process.chdir(directory);
    const manifest = selectionManifest(select('push', { before: base }, { GITHUB_SHA: head }));
    assert.equal(manifest.sourceSha, head);
    assert.equal(manifest.baseSha, base);
    assert.ok(manifest.components.includes('core'));
    assert.ok(manifest.components.includes('shell'));
    assert.ok(manifest.required.includes('core-aot'));
    assert.equal(classifyPaths(changedPaths(command('rev-parse', 'HEAD^'), head)).components.includes('core'), false);
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

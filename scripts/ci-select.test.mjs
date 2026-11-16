import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { qualificationPlan, changedPaths, resolveRevision, select } from './ci-select.mjs';
import { classifyPaths, fullPlan } from './ci-policy.mjs';

test('manual validation retains all normal checks and refuses retired risk scopes', () => {
  const affected = classifyPaths(['scripts/check-workspace-activation.py']);
  assert.deepEqual(qualificationPlan('affected', affected), affected);
  assert.deepEqual(qualificationPlan('all', affected), fullPlan());
  for (const scope of ['nightly', 'windows', 'lifecycle', 'docker', 'whisper', 'typo']) {
    assert.throws(() => qualificationPlan(scope, affected));
  }
  assert.throws(() => select('schedule', {}, {}), /Unsupported CI event/);
  assert.throws(() => select('workflow_dispatch', { inputs: { scope: 'lifecycle' } }, {}), /moved/);
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
    const manual = select('workflow_dispatch', { inputs: { revision: base } }, { GITHUB_SHA: head });
    assert.equal(manual.head, base);
    assert.deepEqual(manual.plan, fullPlan());
    assert.throws(() => select('workflow_dispatch', { inputs: { revision: 'does-not-exist' } }, {}));
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
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
    assert.deepEqual(config.plan.profiles, ['core-aot']);
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


test('actual push and PR selection prove a lock-only vendor change without consulting dirty working files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosty-ci-locked-vendor-')), previous = process.cwd();
  const command = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const node = ['codex-provider','claude-code-provider','ollama-provider','opus','shell','desktop','demo-app','marketplace','documents','harness','telemetry-ui'];
  const workspaces = [...node.map(id => `apps/${id}`), 'apps/harness/web', 'packages/app-sdk', 'packages/agent-provider-runtime'];
  const packages = { '': { workspaces } }, pkg = { workspaces };
  for (const workspace of workspaces) {
    const name = workspace === 'packages/app-sdk' ? 'sdk' : workspace === 'packages/agent-provider-runtime' ? 'runtime' : workspace.replaceAll('/', '-');
    packages[workspace] = { name }; packages['node_modules/' + name] = { link: true, resolved: workspace };
  }
  packages['packages/agent-provider-runtime'].dependencies = { sdk: '*' };
  packages['packages/agent-provider-runtime'].peerDependencies = { codex: '1', claude: '1' };
  packages['packages/agent-provider-runtime'].peerDependenciesMeta = { codex: { optional: true }, claude: { optional: true } };
  for (const [slug, vendor] of [['codex-provider','codex'],['claude-code-provider','claude']])
    packages[`apps/${slug}`].dependencies = { runtime: '*', [vendor]: '1' };
  packages['apps/ollama-provider'].dependencies = { runtime: '*' };
  for (const vendor of ['codex','claude']) packages['node_modules/' + vendor] = { version: '1', resolved: `https://example.test/${vendor}.tgz`, integrity: 'sha512-original' };
  const lock = { lockfileVersion: 3, packages };
  try {
    command('init', '-q'); command('config','user.email','ci@example.invalid'); command('config','user.name','CI test');
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg)); writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock));
    command('add','.'); command('commit','-qm','initial locked graph'); const base = command('rev-parse','HEAD');
    lock.packages['node_modules/codex'].integrity = 'sha512-updated-codex';
    writeFileSync(join(directory,'package-lock.json'),JSON.stringify(lock)); command('commit','-qam','Codex archive pin'); const head = command('rev-parse','HEAD');
    process.chdir(directory);
    writeFileSync(join(directory,'package-lock.json'),'uncommitted invalid metadata is not the tested revision');
    for (const [event, payload] of [['push',{ before: base }],['pull_request',{ pull_request: { base: { sha: base } } }]]) {
      const selection = select(event,payload,{ GITHUB_SHA: head });
      assert.deepEqual(selection.plan.components,['codex-provider']);
      assert.ok(selection.plan.required.includes('agent-providers')); assert.ok(!selection.plan.required.includes('harness'));
      assert.equal(selection.head,head); assert.equal(selection.base,base);
    }
    writeFileSync(join(directory,'package-lock.json'),JSON.stringify({ lockfileVersion: 0 })); command('commit','-qam','unprovable locked graph');
    const fallback = select('push',{ before: head },{ GITHUB_SHA: command('rev-parse','HEAD') });
    assert.ok(fallback.plan.components.includes('harness')); assert.ok(fallback.plan.components.includes('claude-code-provider'));
    assert.ok(fallback.plan.components.includes('app-sdk')); assert.ok(!fallback.plan.components.includes('core'));
  } finally { process.chdir(previous); rmSync(directory,{ recursive:true,force:true }); }
});

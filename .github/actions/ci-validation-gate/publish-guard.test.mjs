import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const guard = fileURLToPath(new URL('../publish-guard/guard.sh', import.meta.url));
const latest = 'b'.repeat(40), older = 'a'.repeat(40);
function run(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'publication-guard-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'git'), '#!/bin/sh\nprintf "%s\trefs/heads/main\n" "$TEST_MAIN_TIP"\n', { mode: 0o755 });
  const output = join(root, 'outputs');
  writeFileSync(output, '');
  const environment = { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_SHA: latest,
    GITHUB_OUTPUT: output, TEST_MAIN_TIP: latest, VERSION: '', IMAGE: '' };
  delete environment.PUBLISH_SOURCE_SHA;
  if (source !== undefined) environment.PUBLISH_SOURCE_SHA = source;
  const result = spawnSync('bash', [guard], { env: environment, encoding: 'utf8' });
  return { ...result, output: readFileSync(output, 'utf8') };
}

test('stale CI source cannot move mutable tags even when workflow_run GITHUB_SHA is latest main', t => {
  const result = run(t, older);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /fresh=false/);
  assert.ok(result.stdout.includes(older));
});

test('ordinary callers retain default workflow SHA freshness behavior', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /fresh=true/);
});

test('invalid explicit source fails before freshness or version outputs', t => {
  const result = run(t, 'main');
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
});

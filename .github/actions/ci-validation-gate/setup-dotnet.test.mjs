import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sdkVersion } from '../setup-dotnet/version.mjs';

test('SDK selection retains the declared exact version despite roll-forward policy', () => {
  assert.equal(sdkVersion({ sdk: { version: '10.0.401', rollForward: 'latestFeature' } }), '10.0.401');
  assert.equal(sdkVersion({ sdk: { version: '11.0.100-preview.1' } }), '11.0.100-preview.1');
  for (const version of [undefined, '10.0.x', '10.0', 'latest', '10.0.401\n', '10.0.401\nother=value']) {
    assert.throws(() => sdkVersion({ sdk: { version } }), /exact/);
  }
});

test('SDK output comes from the selected checkout, not the action source or ambient directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosty-dotnet-selection-'));
  try {
    const output = path.join(root, 'outputs');
    writeFileSync(path.join(root, 'global.json'), JSON.stringify({ sdk: { version: '10.0.402', rollForward: 'latestFeature' } }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../setup-dotnet/version.mjs', import.meta.url))], {
      env: { ...process.env, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: output }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'version=10.0.402\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CI and .NET publication share exact repository SDK setup', () => {
  for (const file of ['ci.yml', 'publish-app-sdk-dotnet.yml', 'cli-release.yml', 'telemetry-backend-image.yml']) {
    const workflow = readFileSync(new URL(`../../workflows/${file}`, import.meta.url), 'utf8');
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-dotnet/);
    assert.doesNotMatch(workflow, /uses: actions\/setup-dotnet@|dotnet-version: 10\.0\.x|global-json-file:/);
  }
  const action = readFileSync(new URL('../setup-dotnet/action.yml', import.meta.url), 'utf8');
  assert.match(action, /dotnet-version: \$\{\{ steps\.sdk\.outputs\.version \}\}/);
  assert.doesNotMatch(action, /global-json-file:|continue-on-error:/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyPaths } from '../../../scripts/ci-policy.mjs';
import { publicationSelected, selectPublication, validateSelection } from './select-publication.mjs';

const source = 'a'.repeat(40), beforePush = 'b'.repeat(40);
const evidence = paths => {
  const { components, profiles, required } = classifyPaths(paths);
  return { format: 1, sourceSha: source, baseSha: beforePush, components, profiles, required };
};
const context = { event: 'workflow_run', sha: source };

test('uses the successful CI selection for a multi-commit push with earlier Core and latest Shell changes', () => {
  const manifest = evidence(['apps/core/src/Haas.Hosty.Core/RuntimeApp.cs', 'apps/shell/src/app/page.tsx']);
  for (const component of ['core', 'shell']) {
    assert.equal(selectPublication({ context, components: [component], manifestPath: 'ci-selection/selection.json',
      readManifest: path => { assert.equal(path, 'ci-selection/selection.json'); return manifest; } }), true);
  }
  assert.equal(publicationSelected('workflow_run', ['cardputer-shell'], manifest, source), false);
});

test('shared dependency policy selects Shell and Harness publication from actual CI evidence', () => {
  const manifest = evidence(['shared/web/workspace-activation.tsx']);
  assert.equal(publicationSelected('workflow_run', ['shell'], manifest, source), true);
  assert.equal(publicationSelected('workflow_run', ['harness'], manifest, source), true);
  assert.equal(publicationSelected('workflow_run', ['cardputer-shell'], manifest, source), false);
});

test('unrelated CI is a no-op and explicit manual/SDK push publication needs no selection download', () => {
  assert.equal(publicationSelected('workflow_run', ['cardputer-shell'], evidence(['apps/shell/src/app/page.tsx']), source), false);
  for (const event of ['workflow_dispatch', 'push']) assert.equal(selectPublication({
    context: { event, sha: source }, components: ['cardputer-shell'], readManifest: () => assert.fail('explicit publication must not read selection'),
  }), true);
});

for (const mismatch of [
  { sourceSha: 'c'.repeat(40) }, { format: 2 }, { baseSha: 'main' }, { components: ['unknown'] },
  { profiles: ['unknown'] }, { required: ['unknown'] }, { components: ['shell', 'shell'] },
  { required: [] }, { components: [] }, { profiles: ['core-aot'] },
]) test(`selection fails closed for wrong identity/schema/required contract: ${JSON.stringify(mismatch)}`, () => {
  assert.throws(() => validateSelection({ ...evidence(['apps/shell/src/app/page.tsx']), ...mismatch }, source), /manifest/);
});

test('missing, malformed and incomplete selection cannot fall back to recomputation', () => {
  assert.throws(() => selectPublication({ context, components: ['shell'], manifestPath: '/missing/selection.json' }), /ENOENT/);
  assert.throws(() => selectPublication({ context, components: ['shell'], readManifest: () => JSON.parse('broken') }), /JSON|Unexpected/);
  const missingBase = evidence(['apps/shell/src/app/page.tsx']);
  delete missingBase.baseSha;
  assert.throws(() => validateSelection(missingBase, source), /schema/);
  assert.throws(() => validateSelection({ ...evidence([]), extra: true }, source), /schema/);
  assert.throws(() => publicationSelected('workflow_run', ['typo'], evidence([]), source), /known component/);
  assert.throws(() => publicationSelected('schedule', ['shell'], evidence([]), source), /completed CI/);
});

test('root/initial push can record a null base without weakening exact source identity', () => {
  const manifest = { ...evidence(['apps/shell/src/app/page.tsx']), baseSha: null };
  assert.equal(publicationSelected('workflow_run', ['shell'], manifest, source), true);
});

test('composite downloads actual selection evidence only after exact CI validation, by source and run', () => {
  const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
  assert.ok(action.indexOf('/gate.mjs') < action.indexOf('uses: actions/download-artifact'));
  assert.ok(action.indexOf('uses: actions/download-artifact') < action.indexOf('/select-publication.mjs'));
  assert.match(action, /name: ci-selection-\$\{\{ steps.validation.outputs.source-sha \}\}/);
  assert.match(action, /run-id: \$\{\{ steps.validation.outputs.run-id \}\}/);
  assert.match(action, /if: github.event_name == 'workflow_run'/);
  assert.doesNotMatch(action, /continue-on-error:/);
});

test('retained pre-migration selection can still publish its verified component', () => {
  const legacy = ['core-windows-process-control', 'workspace-native-activation', 'core-transport', 'harness-worker', 'whisper-native'];
  const current = evidence(['apps/core/src/Haas.Hosty.Core/RuntimeApp.cs']);
  const historical = { ...current, profiles: [...current.profiles, ...legacy], required: [...current.required, ...legacy] };
  assert.equal(publicationSelected('workflow_run', ['core'], historical, source), true);
  assert.equal(publicationSelected('workflow_run', ['shell'], historical, source), false);
  for (const mismatch of [
    { profiles: [...historical.profiles, legacy[0]] },
    { required: [...historical.required, legacy[0]] },
    { profiles: current.profiles }, { required: current.required },
    { profiles: [...historical.profiles, 'unknown'], required: [...historical.required, 'unknown'] },
    { required: historical.required.filter(job => job !== 'core') },
    { sourceSha: 'c'.repeat(40) },
  ]) assert.throws(() => validateSelection({ ...historical, ...mismatch }, source), /manifest/);
});

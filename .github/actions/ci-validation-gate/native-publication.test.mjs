import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishNative } from '../../../scripts/releases/native-publish.mjs';
import { sha256 } from '../../../scripts/releases/context.mjs';

function fixture() {
  const artifacts = mkdtempSync(join(tmpdir(), 'hosty-native-publish-'));
  const plan = { sourceCommit: 'a'.repeat(40), repository: 'example/repo', validationRunId: '42', config: { platform: { rids: ['linux-x64'] } }, platform: { selected: true, version: '1.0.0', inputFingerprint: 'b'.repeat(64) } };
  for (const role of ['cli','core']) {
    const fileName = `hosty${role === 'core' ? '-core' : ''}-linux-x64`, bytes = Buffer.from(role);
    writeFileSync(join(artifacts, fileName), bytes);
    writeFileSync(join(artifacts, fileName + '.json'), JSON.stringify({ role, rid: 'linux-x64', fileName,
      size: bytes.length, sha256: sha256(bytes), inputFingerprint: 'c'.repeat(64), qualifiedInputs: plan.platform.inputFingerprint,
      buildSourceCommit: plan.sourceCommit, provenance: 'https://example.test/proof' }));
  }
  return { artifacts, plan, store: { update: () => assert.fail('Incomplete publication cannot advance metadata.') }, prove: async () => {}, request: async () => new Response('', { status: 404 }) };
}
test('missing or corrupt native counterpart cannot publish any assets or pointers', async () => {
  for (const mode of ['missing','corrupt']) {
    const f = fixture();
    try {
      const core = join(f.artifacts, 'hosty-core-linux-x64');
      if (mode === 'missing') rmSync(core); else writeFileSync(core, 'bad');
      await assert.rejects(publishNative({ ...f, run: () => assert.fail('No upload before both artifacts are verified.') }));
    } finally { rmSync(f.artifacts, { recursive: true, force: true }); }
  }
});
test('a failed native asset upload leaves every feed and completion pointer unchanged', async () => {
  const f = fixture(), calls = [];
  try {
    await assert.rejects(publishNative({ ...f, run: (_, args) => { calls.push(args); if (args.includes('upload')) throw new Error('Upload interrupted'); } }), /Upload interrupted/);
    assert.ok(calls.some(args => args.includes('create'))); assert.ok(calls.some(args => args.includes('upload')));
    assert.ok(calls.every(args => !args.includes('--clobber') && !args.includes('--force') && !args.includes('--draft=false')));
  } finally { rmSync(f.artifacts, { recursive: true, force: true }); }
});
test('normal native publication has no rolling tag or overwrite operation', () => {
  const source = readFileSync(new URL('../../../scripts/releases/native-publish.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cli-dev|--clobber|--force/);
  assert.match(source, /receipt.qualifiedInputs !== plan.platform.inputFingerprint/);
});

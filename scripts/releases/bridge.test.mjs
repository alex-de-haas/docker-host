import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { freezeBridge } from './bridge.mjs';
import { canonical, sha256 } from './context.mjs';

function fixture() {
  const releaseId = 'a'.repeat(64), repository = 'example/platform', commit = 'b'.repeat(40);
  const distribution = { legacyRepository: repository, legacyReleaseTag: 'compat', migratedFeedId: 'frequent', indexRef: 'https://example.test/feeds.json' };
  const data = new Map(), published = new Map(), uploads = [];
  const descriptor = { schemaVersion: 'hosty-platform-release.0.1', releaseId, version: '0.172.0', sourceCommit: commit,
    assets: ['cli','core'].map(role => { const bytes = Buffer.from(role), url = `https://example.test/${role}`; data.set(url, bytes); return {
      role, rid: 'linux-x64', fileName: `hosty-${role}-linux-x64`, url, size: bytes.length, sha256: sha256(bytes), inputFingerprint: 'c'.repeat(64), provenance: 'https://example.test/proof',
    }; }) };
  const files = new Map([[`platform/releases/${releaseId}/release.json`, descriptor], ['platform/feeds.json', { feeds: [{ id: 'stable', default: true }, { id: 'frequent' }] }]]);
  const store = {
    refresh: () => commit, run: () => commit, json: (_head, path) => files.get(path) ?? null,
    read: (_head, path) => canonical(files.get(path)) + '\n',
    async update(_message, callback) {
      for (const [path, change] of Object.entries(await callback(commit) ?? {})) {
        if (change.immutable && files.has(path)) assert.equal(canonical(files.get(path)), canonical(change.value));
        files.set(path, change.value);
      }
      return commit;
    },
  };
  const request = async url => new Response(data.get(url) ?? published.get(url), { status: data.has(url) || published.has(url) ? 200 : 404 });
  const run = (_command, args) => {
    uploads.push(args);
    const path = args[3]; published.set(`https://github.com/${repository}/releases/download/compat/${basename(path)}`, readFileSync(path));
  };
  return { options: { store, config: { platform: { rids: ['linux-x64'] } }, distribution, repository, releaseId, request, run, verify: async () => {}, prove: async () => {} }, files, data, uploads };
}

test('the one-time bridge freezes verified bytes and refuses a later release', async () => {
  const { options, files, uploads } = fixture();
  const frozen = await freezeBridge(options);
  assert.equal(frozen.status, 'frozen'); assert.equal(uploads.length, 4);
  assert.equal(files.get('platform/bridge-intent.json').releaseId, frozen.releaseId);
  await freezeBridge(options); assert.equal(uploads.length, 4, 'retry after cutoff never overwrites assets');
  const other = 'd'.repeat(64);
  files.set(`platform/releases/${other}/release.json`, { ...files.get(`platform/releases/${options.releaseId}/release.json`), releaseId: other });
  await assert.rejects(freezeBridge({ ...options, releaseId: other }), /cutoff cannot move/);
  assert.equal(uploads.length, 4);
});

test('partial bridge uploads retain their exact intent for recovery', async () => {
  const { options, files } = fixture(); let count = 0;
  await assert.rejects(freezeBridge({ ...options, run: (...args) => { options.run(...args); if (++count === 1) throw new Error('connection lost'); } }), /connection lost/);
  const intent = structuredClone(files.get('platform/bridge-intent.json'));
  assert.equal(files.has('platform/bridge.json'), false);
  const result = await freezeBridge(options);
  assert.equal(result.cutoff, intent.cutoff); assert.equal(result.releaseId, intent.releaseId);
});

test('an unseeded default or failed provenance cannot advertise a bridge', async () => {
  const unseeded = fixture(); unseeded.files.delete('platform/feeds.json');
  await assert.rejects(freezeBridge(unseeded.options), /Seed/); assert.equal(unseeded.uploads.length, 0);
  const invalid = fixture();
  await assert.rejects(freezeBridge({ ...invalid.options, prove: async () => { throw new Error('invalid signature'); } }), /invalid signature/);
  assert.equal(invalid.uploads.length, 0); assert.equal(invalid.files.has('platform/bridge.json'), false);
});

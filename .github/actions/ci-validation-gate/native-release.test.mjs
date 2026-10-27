import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingNativeRelease, nativeReleaseRequest } from './native-release.mjs';

const published = 'b'.repeat(40), source = 'a'.repeat(40);
const repository = 'owner/repo';
const release = { tag_name: 'cli-dev', draft: false, body: `Published commit: ${published}\n` };
const comparison = files => ({ status: 'ahead', base_commit: { sha: published },
  merge_base_commit: { sha: published }, files: files.map(filename => ({ filename, status: 'modified' })) });
const check = (record, diff, extra = {}) => {
  const paths = [];
  return pendingNativeRelease({ repository, sourceSha: source, releaseTag: 'cli-dev', ...extra,
    request: async path => { paths.push(path); return path.includes('/compare/') ? diff : record; },
  }).then(result => ({ result, paths }));
};

test('recovers an unpublished Core change after a later unrelated successful push', async () => {
  const { result, paths } = await check(release, comparison(['apps/core/src/Haas.Hosty.Core/CoreTracing.cs']));
  assert.equal(result, true);
  assert.deepEqual(paths, [`/repos/${repository}/releases/tags/cli-dev`,
    `/repos/${repository}/compare/${published}...${source}`]);
});

test('current receipt and unrelated changes avoid unnecessary native rebuilds', async () => {
  const current = await check({ ...release, body: `Published commit: ${source}\n` }, null);
  assert.equal(current.result, false);
  assert.equal(current.paths.length, 1);
  assert.equal((await check(release, comparison(['apps/documents/src/main.ts', 'docs/root.md']))).result, false);
});

test('missing and pre-receipt releases recover conservatively without trusting the rolling tag', async () => {
  for (const record of [null, { ...release, body: null }, { ...release, body: `Commit: ${source}\n` }, { ...release, draft: true }]) {
    const { result, paths } = await check(record, null);
    assert.equal(result, true);
    assert.equal(paths.length, 1);
  }
});

test('failed upload leaves the old completion receipt and the new source remains pending', async () => {
  const record = { ...release, target_commitish: source };
  assert.equal((await check(record, comparison(['Directory.Build.props']))).result, true);
});

test('shared native inputs and both sides of renames select native publication', async () => {
  for (const path of ['apps/cli/src/Program.cs', 'global.json', 'shared/HostyLaunch.cs']) {
    assert.equal((await check(release, comparison([path]))).result, true);
  }
  const diff = comparison([]);
  diff.files = [{ filename: 'docs/removed.md', previous_filename: 'apps/core/src/Removed.cs', status: 'renamed' }];
  assert.equal((await check(release, diff)).result, true);
});

test('GitHub truncated file lists trigger a full native build instead of missing a later Core file', async () => {
  assert.equal((await check(release, comparison(Array.from({ length: 300 }, (_, i) => `docs/${i}.md`)))).result, true);
});

test('stale main completion cannot select a rollback', async () => {
  assert.equal((await check(release, { status: 'behind', base_commit: { sha: published } })).result, false);
});

test('malformed completion receipts and uncertain comparisons fail visibly', async () => {
  for (const body of ['Published commit: main', `Published commit: ${published}\nPublished commit: ${source}`]) {
    await assert.rejects(check({ ...release, body }, null), /receipt/);
  }
  for (const diff of [
    { status: 'diverged', base_commit: { sha: published } },
    { ...comparison([]), base_commit: { sha: source } },
    { ...comparison([]), merge_base_commit: { sha: source } },
    { ...comparison([]), files: undefined },
    comparison([null]),
  ]) await assert.rejects(check(release, diff), /comparison|filename/);
});

test('GitHub failures and invalid request identities never become a no-update verdict', async () => {
  await assert.rejects(pendingNativeRelease({ repository, sourceSha: source, releaseTag: 'cli-dev',
    request: async () => { throw new Error('GitHub unavailable'); } }), /unavailable/);
  await assert.rejects(check(release, comparison([]), { sourceSha: 'main' }), /identity/);
  await assert.rejects(check(release, comparison([]), { repository: '../escape' }), /identity/);
});

test('release lookup distinguishes an absent channel from authentication and compare failures', async () => {
  const requests = [];
  const request = nativeReleaseRequest({ token: 'test-token', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { status: 404, ok: false };
  } });
  assert.equal(await request('/repos/owner/repo/releases/tags/cli-dev'), null);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  await assert.rejects(request('/repos/owner/repo/compare/base...head'), /HTTP 404/);
  for (const status of [401, 403, 500]) {
    await assert.rejects(nativeReleaseRequest({ token: 'test-token',
      fetchImpl: async () => ({ status, ok: false }) })('/repos/owner/repo/releases/tags/cli-dev'), new RegExp('HTTP ' + status));
  }
  assert.throws(() => nativeReleaseRequest({ token: '' }), /contents:read/);
});

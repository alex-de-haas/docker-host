import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { publishApps } from './publish.mjs';
import { canonical } from './context.mjs';
import { prepareRelease } from './prepare.mjs';
import { dockerInputs } from './docker-inputs.mjs';
import { publishVersionAliases } from './version-aliases.mjs';
import { verifyProvenance } from './evidence.mjs';
const hash = 'a'.repeat(64), commit = 'b'.repeat(40);
const write = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
function memoryStore() {
  const values = new Map();
  return { values, refresh: () => commit, json: (_head, path) => structuredClone(values.get(path) ?? null),
    async update(_message, build) { for (const [path, change] of Object.entries(await build(commit))) {
      if (change.immutable && values.has(path)) assert.deepEqual(values.get(path), change.value);
      values.set(path, structuredClone(change.value));
    } return commit; } };
}
test('check scope does not order builds; core, app, shared and recovery select independently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-selection-')), store = memoryStore();
  try {
    execFileSync('git', ['init', '-q', root]);
    const config = { schemaVersion: 'hosty-publisher.0.1', metadataBranch: 'releases', feeds: [{ id: 'edge', policy: 'validated-source' }],
      apps: ['a','b'].map(id => ({ id, manifest: `apps/${id}/manifest.json`, profiles: ['docker'], sourceInputs: [`apps/${id}`] })),
      images: ['a','b'].map(id => ({ id, appId: id, repository: `example/${id}`, dockerfile: `apps/${id}/Dockerfile`, inputs: [`apps/${id}`],
        services: ['api'], platforms: ['linux/arm64'], reusable: true, toolchain: {} })), platform: { rids: ['custom'], inputs: ['core.cs','Directory.Build.props'] } };
    write(root, 'distribution/release-publisher.json', JSON.stringify(config));
    write(root, 'Directory.Build.props', '<Project><Version>1.0.0</Version></Project>');
    write(root, 'core.cs', 'initial core'); write(root, 'shared/data', 'shared');
    write(root, '.github/workflows/ready-releases.yml', 'workflow');
    for (const file of ['context.mjs','docker-inputs.mjs']) write(root, `scripts/releases/${file}`, readFileSync(new URL(file, import.meta.url)));
    write(root, 'scripts/npm-workspace.mjs', readFileSync(new URL('../npm-workspace.mjs', import.meta.url)));
    for (const app of config.apps) {
      write(root, app.manifest, JSON.stringify({ id: app.id, version: '1.0.0' }));
      write(root, `apps/${app.id}/Dockerfile`, `FROM example/base@sha256:${hash}\nCOPY apps/${app.id} /app\nCOPY shared /shared\n`);
      write(root, `apps/${app.id}/code`, 'initial');
    }
    let sequence = 0;
    const options = { root, sourceCommit: commit, validationRunId: 42, repository: 'example/repo', store, resolveExternal: false,
      verify: async () => ({}), prove: async () => ({}) };
    const prepare = () => prepareRelease({ ...options, output: join(root, `.git/plan-${sequence++}`) });
    const initial = await prepare();
    for (const image of initial.images) store.values.set(`artifacts/images/${image.recipe.id}/current.json`, {
      schemaVersion: 'hosty-image-artifact.0.1', repository: image.recipe.repository, digest: `sha256:${hash}`, inputFingerprint: image.inputFingerprint,
      buildSourceCommit: commit, provenance: 'https://example.test/proof', platforms: image.recipe.platforms });
    for (const app of initial.apps) {
      store.values.set(`apps/${app.app.id}/candidate.json`, { inputFingerprint: app.inputFingerprint, releaseId: hash });
      store.values.set(`apps/${app.app.id}/feed-state.json`, { feeds: { edge: { releaseId: hash } } });
    }
    store.values.set('platform/candidate.json', { inputFingerprint: initial.platform.inputFingerprint, releaseId: hash });
    store.values.set('platform/feed-state.json', { feeds: { edge: { releaseId: hash } } });
    const noChange = await prepare(); assert.equal(noChange.platform.selected, false); assert.ok(noChange.apps.every(a => !a.selected));
    write(root, 'core.cs', 'changed core');
    const core = await prepare(); assert.equal(core.platform.selected, true); assert.ok(core.images.every(i => i.decision === 'unchanged-app'));
    write(root, 'apps/a/code', 'changed app');
    const app = await prepare(); assert.deepEqual(app.images.map(i => i.decision), ['build','unchanged-app']);
    write(root, 'apps/a/code', 'initial');
    store.values.delete('apps/a/feed-state.json');
    const recovery = await prepare(); assert.equal(recovery.apps[0].recoveryOnly, true); assert.ok(recovery.images.every(i => i.decision === 'unchanged-app'));
    write(root, 'shared/data', 'changed shared');
    const shared = await prepare(); assert.ok(shared.images.every(i => i.decision === 'build'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('literal Docker inputs expand the graph; uncertain syntax disables reuse visibly', () => {
  const recipe = { reusable: true }, paths = ['app/main','extra/input'];
  const literal = dockerInputs(`FROM base@sha256:${hash}\nCOPY extra /data`, recipe, paths);
  assert.deepEqual(literal.inputs, ['extra']); assert.equal(literal.reusable, true);
  assert.throws(() => dockerInputs('COPY missing /data', recipe, paths), /Missing declared/);
  for (const line of ['COPY . /data','COPY ${INPUT} /data','ADD https://example.test/a /data','RUN --mount=type=bind,target=/src build','RUN --mount=type=cache,target=/cache --mount=type=bind,target=/src build']) {
    const result = dockerInputs(line, recipe, paths); assert.equal(result.reusable, false); assert.ok(result.fallback);
  }
  assert.equal(dockerInputs('FROM unpinned:latest', recipe, paths).reusable, false);
});
test('version aliases never overwrite existing bytes and recover the original claim', async () => {
  const store = memoryStore(), commands = [], registry = new Map();
  const verify = async (_repo, ref) => { if (ref.startsWith('sha256:')) return { digest: ref }; if (!registry.has(ref)) throw new Error('HTTP 404'); return { digest: registry.get(ref) }; };
  const run = (_exe, args) => { commands.push(args); registry.set('1.0.0', args.at(-1).split('@')[1]); };
  const options = { store, app: { id: 'a' }, version: '1.0.0', artifacts: [{ repository: 'example/a', digest: `sha256:${hash}`, platforms: ['linux/arm64'] }], verify, run };
  await publishVersionAliases(options); assert.equal(commands.length, 1);
  options.artifacts[0].digest = `sha256:${'c'.repeat(64)}`;
  await publishVersionAliases(options); assert.equal(commands.length, 1); assert.equal(registry.get('1.0.0'), `sha256:${hash}`);
  registry.clear(); await publishVersionAliases(options); assert.equal(registry.get('1.0.0'), `sha256:${hash}`);
  await assert.rejects(publishVersionAliases({ ...options, verify: async () => { throw new Error('HTTP 403'); } }), /403/);
});
test('signed provenance must match the original artifact, source, inputs and platforms', () => {
  const receipt = { artifactId: 'api', buildSourceCommit: commit, inputFingerprint: hash, platforms: ['linux/arm64'] };
  const predicate = { schemaVersion: 'hosty-artifact-provenance.0.1', repository: 'example/repo', artifactId: 'api', sourceCommit: commit,
    inputFingerprint: hash, platforms: receipt.platforms, validation: { workflow: '.github/workflows/ci.yml', runId: '42' } };
  const run = () => JSON.stringify([{ verificationResult: { statement: { predicate } } }]);
  assert.equal(verifyProvenance('oci://example.test/api@sha256:' + hash, receipt, 'example/repo', { run }).sourceCommit, commit);
  predicate.artifactId = 'other'; assert.throws(() => verifyProvenance('oci://example.test/api@sha256:' + hash, receipt, 'example/repo', { run }), /does not match/);
});

test('one missing image cannot hold an independently complete source app release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-independent-release-')), store = memoryStore();
  try {
    execFileSync('git', ['init', '-q', root]); store.ancestor = () => true;
    const app = { id: 'working', manifest: 'apps/working/manifest.json', profiles: ['local'] };
    const manifest = { id: app.id, version: '1.0.0', source: { repository: 'https://example.test/repo' },
      runtimeProfiles: [{ key: 'local', type: 'localCommand' }], services: [{ key: 'api', runtimes: { local: { type: 'localCommand', command: 'run' } } }] };
    write(root, app.manifest, JSON.stringify(manifest));
    const plan = { sourceCommit: commit, repository: 'example/repo', config: { metadataBranch: 'releases', feeds: [{ id: 'edge', policy: 'validated-source' }], images: [] },
      images: [{ recipe: { id: 'missing', appId: 'broken', repository: 'example/broken', platforms: ['linux/arm64'] }, decision: 'build', inputFingerprint: hash }],
      apps: [{ app: { id: 'broken' }, selected: true }, { app, manifest, selected: true, inputFingerprint: hash, sourceFingerprint: hash }] };
    const request = async url => {
      const path = url.split(`/${commit}/`)[1], value = store.values.get(path);
      const response = new Response(value ? canonical(value) + '\n' : '', { status: value ? 200 : 404 });
      Object.defineProperty(response, 'url', { value: url }); return response;
    };
    await assert.rejects(publishApps({ root, plan, artifacts: join(root, 'missing-artifacts'), store, request, aliases: async () => {}, validate: async () => {},
      verify: async () => assert.fail('Source-only release has no image'), prove: async () => {} }), /broken:/);
    assert.ok(store.values.has('apps/working/feeds.json'));
    assert.ok(store.values.has('apps/working/install.json'));
    assert.equal(store.values.has('apps/broken/feeds.json'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('source Docker development profiles retain their own verified base instead of the production app image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-dev-base-')), store = memoryStore(), requests = [];
  try {
    execFileSync('git', ['init', '-q', root]);
    const app = { id: 'independent.app', manifest: 'app/manifest.json', profiles: ['docker'] };
    const manifest = { id: app.id, version: '1.0.0', runtimeProfiles: [{ key: 'docker', type: 'docker' }, { key: 'docker-dev', type: 'docker', development: true }],
      services: [{ key: 'api', runtimes: { docker: { type: 'docker', image: 'example/app:1.0.0' }, 'docker-dev': { type: 'docker', artifact: 'source', image: { repository: 'node', tag: '24-slim' } } } }] };
    const receipt = { repository: 'example/app', digest: `sha256:${hash}`, inputFingerprint: hash, buildSourceCommit: commit, platforms: ['linux/amd64','linux/arm64'] };
    const plan = { sourceCommit: commit, validationRunId: '42', repository: 'example/repo', config: { images: [{ id: 'app', appId: app.id, services: ['api'] }], feeds: [] },
      images: [{ recipe: { id: 'app', appId: app.id, repository: receipt.repository, platforms: receipt.platforms }, decision: 'reuse', previous: receipt, inputFingerprint: hash }],
      apps: [{ app, manifest, selected: true, sourceFingerprint: hash, inputFingerprint: hash }] };
    await publishApps({ root, plan, artifacts: root, store, prove: async () => ({}), aliases: async () => {}, validate: async () => {},
      request: async url => { const value = store.values.get(url.split(`/${commit}/`)[1]); const response = new Response(value ? canonical(value) + '\n' : '', { status: value ? 200 : 404 }); Object.defineProperty(response, 'url', { value: url }); return response; },
      verify: async (repository, reference, platforms) => { requests.push([repository, reference]); return { repository, digest: repository === 'node' ? `sha256:${'c'.repeat(64)}` : receipt.digest, platforms }; } });
    const candidate = store.values.get(`apps/${app.id}/candidate.json`), emitted = store.values.get(`apps/${app.id}/releases/${candidate.releaseId}/manifest.json`);
    assert.equal(emitted.services[0].runtimes.docker.image.repository, 'example/app');
    assert.equal(emitted.services[0].runtimes['docker-dev'].image.repository, 'node');
    assert.equal(emitted.services[0].runtimes['docker-dev'].image.digest, `sha256:${'c'.repeat(64)}`);
    assert.ok(requests.some(([repository, reference]) => repository === 'node' && reference === '24-slim'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('an unrelated .NET build-target change does not select the Docker-only Harness release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-harness-dotnet-input-')), store = memoryStore();
  try {
    execFileSync('git', ['init', '-q', root]);
    const configured = JSON.parse(readFileSync(new URL('../../distribution/release-publisher.json', import.meta.url))).apps.find(app => app.id === 'hosty.harness');
    assert.ok(!configured.sourceInputs.includes('Directory.Build.targets'));
    const workspaces = ['apps/harness','apps/harness/web','packages/app-sdk'], packages = { '': { workspaces } };
    for (const [workspace, name] of [['apps/harness','harness'],['apps/harness/web','web'],['packages/app-sdk','sdk']]) {
      packages[workspace] = { name, ...(name === 'harness' ? { dependencies: { sdk: '*' } } : {}) };
      packages['node_modules/' + name] = { link: true, resolved: workspace };
      write(root, workspace + '/package.json', JSON.stringify(packages[workspace]));
    }
    const config = { schemaVersion: 'hosty-publisher.0.1', metadataBranch: 'releases', feeds: [{ id: 'edge', policy: 'validated-source' }], apps: [configured], images: [],
      platform: { rids: ['fixture'], inputs: ['Directory.Build.props','Directory.Build.targets'] } };
    write(root, 'distribution/release-publisher.json', JSON.stringify(config));
    write(root, configured.manifest, JSON.stringify({ id: configured.id, version: '0.99.0' }));
    write(root, 'package.json', JSON.stringify({ workspaces })); write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
    write(root, 'Directory.Build.props', '<Project><Version>0.180.0</Version></Project>'); write(root, 'Directory.Build.targets', 'native build metadata');
    write(root, 'scripts/npm-workspace.mjs', 'locked projection');
    const options = { root, sourceCommit: commit, validationRunId: '42', repository: 'example/repo', store, resolveExternal: false };
    const before = await prepareRelease({ ...options, output: join(root,'.git/before') });
    store.values.set(`apps/${configured.id}/candidate.json`, { inputFingerprint: before.apps[0].inputFingerprint, releaseId: hash });
    store.values.set(`apps/${configured.id}/feed-state.json`, { feeds: { edge: { releaseId: hash } } });
    store.values.set('platform/candidate.json', { inputFingerprint: before.platform.inputFingerprint, releaseId: hash });
    store.values.set('platform/feed-state.json', { feeds: { edge: { releaseId: hash } } });
    write(root, 'Directory.Build.targets', 'changed native build metadata');
    const nativeOnly = await prepareRelease({ ...options, output: join(root,'.git/native') });
    assert.equal(nativeOnly.apps[0].selected, false); assert.equal(nativeOnly.platform.selected, true);
    write(root, 'scripts/npm-workspace.mjs', 'changed locked projection');
    const ownInput = await prepareRelease({ ...options, output: join(root,'.git/own') }); assert.equal(ownInput.apps[0].selected, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

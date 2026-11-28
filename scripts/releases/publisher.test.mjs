import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectNpm, buildContext, materializeContext, identity, reusableArtifact } from './context.mjs';
import { validatePublisher, appRelease, platformRelease, promotionDecision, feedDocument } from './model.mjs';
import { imageReceipt } from './artifacts.mjs';
const hash = 'a'.repeat(64), commit = 'b'.repeat(40);
const config = count => ({ schemaVersion: 'hosty-publisher.0.1', metadataBranch: 'artifacts', feeds: Array.from({ length: count }, (_, i) => ({ id: `feed-${i}`, policy: i ? 'manual-promotion' : 'validated-source', default: i === count - 1 })), apps: [], images: [] });

test('repository publication targets resolve existing production apps and migration declarations', () => {
  const read = path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
  const publisher = validatePublisher(read('distribution/release-publisher.json'));
  const appIds = new Set(publisher.apps.map(app => app.id));
  for (const app of publisher.apps) {
    const manifest = read(app.manifest);
    assert.equal(manifest.id, app.id, app.manifest);
    for (const profile of app.profiles) {
      assert.ok(manifest.runtimeProfiles.some(runtime => runtime.key === profile && !runtime.development),
        `${app.id}: missing production profile ${profile}`);
    }
    for (const input of app.sourceInputs) {
      assert.ok(existsSync(new URL(`../../${input}`, import.meta.url)), `${app.id}: missing source input ${input}`);
    }
  }
  const declarations = read('distribution/app-source-migrations.json');
  assert.equal(declarations.schemaVersion, 'app-source-migrations.0.1');
  const migrationIds = new Set();
  for (const migration of declarations.migrations) {
    assert.ok(appIds.has(migration.appId), `${migration.migrationId}: app is not a publication target`);
    assert.ok(!migrationIds.has(migration.migrationId), `Duplicate migration ${migration.migrationId}`);
    migrationIds.add(migration.migrationId);
  }
});
test('Telemetry release and local container builds use the repository SDK and retained app runtime', () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const publisher = JSON.parse(read('distribution/release-publisher.json'));
  const recipe = publisher.images.find(image => image.dockerfile === 'apps/telemetry-backend/Dockerfile');
  const sdk = JSON.parse(read('global.json')).sdk.version.split('.').slice(0, 2).join('.');
  const runtime = /<TargetFramework>net(\d+\.\d+)<\/TargetFramework>/.exec(read('apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Haas.Hosty.TelemetryBackend.csproj'))[1];
  assert.equal(recipe.resolveBases.SDK_IMAGE.tag, sdk, 'release build arguments must not override the selected SDK with an older major');
  assert.equal(recipe.resolveBases.RUNTIME_IMAGE.tag, runtime, 'runtime follows the application target');
  const dockerfile = read(recipe.dockerfile);
  for (const [name, base] of Object.entries(recipe.resolveBases)) {
    assert.ok(dockerfile.split('\n').includes(`ARG ${name}=${base.repository}:${base.tag}`), `${name}: local and release builds use the same base version`);
  }
});
test('publisher names and counts are data; duplicate/default/control IDs fail', () => {
  for (const count of [1,3,10]) assert.equal(validatePublisher(config(count)).feeds.length, count);
  const c = config(2); c.feeds[1].id = c.feeds[0].id; assert.throws(() => validatePublisher(c), /duplicate/);
  c.feeds[1].id = 'bad\u0085id'; assert.throws(() => validatePublisher(c), /Invalid/);
});
test('first automatic pointer is retained but not advertised ahead of the configured default', () => {
  const c = config(2); assert.equal(feedDocument(c, 'example.app', { 'feed-0': { manifestRef: 'https://example.test/1' } }), null);
  assert.equal(feedDocument(c, 'example.app', { 'feed-0': { manifestRef: 'https://example.test/1' }, 'feed-1': { manifestRef: 'https://example.test/2' } }).feeds.length, 2);
  assert.equal(feedDocument(config(1), 'example.app', { 'feed-0': { manifestRef: 'https://example.test/1' } }).feeds[0].default, true);
});
test('manual promotion is exact, guarded and cannot be bypassed by automatic callers', () => {
  const options = { config: config(2), feedId: 'feed-1', kind: 'manual', releaseId: hash, current: 'old', expected: 'old', evidence: 'Verified acceptance', sourceCommit: commit, currentSource: 'c'.repeat(40), isAncestor: () => true };
  assert.equal(promotionDecision(options), true);
  assert.equal(promotionDecision({ ...options, current: hash, expected: 'stale' }), false);
  assert.throws(() => promotionDecision({ ...options, kind: 'automatic' }), /manual/);
  assert.throws(() => promotionDecision({ ...options, expected: 'stale' }), /pointer changed/);
  assert.throws(() => promotionDecision({ ...options, isAncestor: () => false }), /regress/);
});
function lockFixture() {
  const archive = (dependencies = {}) => ({ version: '1.0.0', resolved: 'https://registry.example.test/a.tgz', integrity: 'sha512-proof', dependencies });
  return { lockfileVersion: 3, packages: { '': { workspaces: ['apps/a','apps/b','packages/sdk'] },
    'apps/a': { name: 'a', dependencies: { sdk: '*', x: '^1' } }, 'apps/b': { name: 'b', dependencies: { unrelated: '^1' } },
    'packages/sdk': { name: 'sdk', peerDependencies: { peer: '^1' }, optionalDependencies: { optional: '^1' } },
    'node_modules/a': { link: true, resolved: 'apps/a' }, 'node_modules/b': { link: true, resolved: 'apps/b' },
    'node_modules/sdk': { link: true, resolved: 'packages/sdk' }, 'node_modules/x': archive({ nested: '^1' }),
    'node_modules/x/node_modules/nested': archive(), 'node_modules/peer': archive(), 'node_modules/optional': archive(), 'node_modules/unrelated': archive() } };
}
test('npm projection retains actual nested, peer, optional and workspace closure only', () => {
  const lock = lockFixture(), root = { workspaces: lock.packages[''].workspaces, overrides: { x: '^1' }, scripts: { unrelated: 'anything' } };
  const projection = projectNpm(root, lock, ['apps/a']);
  assert.deepEqual(projection.workspaces, ['apps/a','packages/sdk']);
  assert.ok(projection.lock.packages['node_modules/x/node_modules/nested']); assert.ok(projection.lock.packages['node_modules/peer']); assert.ok(projection.lock.packages['node_modules/optional']);
  assert.equal(projection.lock.packages['apps/b'], undefined); assert.equal(projection.lock.packages['node_modules/unrelated'], undefined);
  const before = identity(projection); lock.packages['apps/b'].version = '2.0.0'; root.scripts.unrelated = 'changed';
  assert.equal(identity(projectNpm(root, lock, ['apps/a'])), before);
  lock.packages['node_modules/peer'].version = '2.0.0'; assert.notEqual(identity(projectNpm(root, lock, ['apps/a'])), before);
  delete lock.packages['node_modules/peer'].integrity; assert.throws(() => projectNpm(root, lock, ['apps/a']), /integrity/);
});
test('fingerprints describe materialized bytes, modes, renames and deletions', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-context-test-'));
  try {
    mkdirSync(join(root, 'apps/a'), { recursive: true }); writeFileSync(join(root, 'Dockerfile'), 'COPY apps/a apps/a\n'); writeFileSync(join(root, '.dockerignore'), 'docs\n'); writeFileSync(join(root, 'apps/a/a'), 'same');
    const recipe = { inputs: ['apps/a'], dockerfile: 'Dockerfile', platforms: ['linux/amd64'] }, paths = ['apps/a/a','Dockerfile','.dockerignore'];
    const original = buildContext(root, recipe, { paths }); materializeContext(original, join(root, 'output'));
    assert.equal(readFileSync(join(root, 'output/apps/a/a'), 'utf8'), 'same');
    rmSync(join(root, 'apps/a/a')); writeFileSync(join(root, 'apps/a/b'), 'same');
    assert.notEqual(buildContext(root, recipe, { paths: [...paths, 'apps/a/b'] }).fingerprint, original.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('digest reuse requires exact proof format, full build revision and complete platforms', () => {
  const recipe = { reusable: true, repository: 'example/app', platforms: ['linux/amd64','linux/arm64'] };
  const receipt = { schemaVersion: 'hosty-image-artifact.0.1', repository: recipe.repository, digest: `sha256:${hash}`, inputFingerprint: hash, buildSourceCommit: commit, provenance: 'https://example.test/proof', platforms: recipe.platforms };
  assert.equal(reusableArtifact(receipt, recipe, hash), true);
  for (const invalid of [{ ...receipt, platforms: ['linux/amd64'] }, { ...receipt, buildSourceCommit: 'abcd' }, { ...receipt, provenance: null }, { ...receipt, inputFingerprint: 'different' }]) assert.equal(reusableArtifact(invalid, recipe, hash), false);
  assert.equal(reusableArtifact(receipt, { ...recipe, reusable: false }, hash), false);
});
test('mixed-service releases retain original build revisions and ignore unrelated candidate HEAD', () => {
  const app = { id: 'example.telemetry', profiles: ['docker'] }, manifest = { id: app.id, version: '1.0.0', source: { repository: 'https://example.test/repo' }, runtimeProfiles: [{ key: 'docker', type: 'docker' }], services: ['backend','ui'].map(key => ({ key, runtimes: { docker: { type: 'docker', image: { repository: `example/${key}`, tag: 'latest' } } } })) };
  const artifacts = ['backend','ui'].map((service, i) => ({ type: 'image', service, profile: 'docker', repository: `example/${service}`, digest: `sha256:${String(i).repeat(64)}`, platforms: ['linux/arm64'], buildSourceCommit: i ? commit : 'c'.repeat(40), inputFingerprint: hash }));
  const first = appRelease({ manifest, app, sourceCommit: commit, sourceFingerprint: hash, artifacts });
  assert.equal(first.manifest.schemaVersion, 'app.0.2'); assert.equal(first.manifest.services[0].runtimes.docker.image.tag, undefined);
  assert.equal(first.descriptor.releaseId, appRelease({ manifest, app, sourceCommit: 'd'.repeat(40), sourceFingerprint: hash, artifacts }).descriptor.releaseId);
  assert.throws(() => appRelease({ manifest, app, sourceCommit: commit, sourceFingerprint: hash, artifacts: artifacts.slice(1) }), /Missing verified/);
});
test('Docker releases retain named editing sources without requiring a primary source', () => {
  const app = { id: 'example.images', manifest: 'apps/images/manifest.json', profiles: ['docker'] };
  const manifest = {
    id: app.id, version: '1.0.0',
    sources: { api: { type: 'git', repository: 'https://git.example.test/services/api.git', branch: 'trunk' } },
    runtimeProfiles: [{ key: 'docker', type: 'docker' }],
    services: [{ key: 'api', sourceRef: 'api', runtimes: { docker: { type: 'docker', image: 'example/api:1.0.0' } } }],
  };
  const image = { repository: 'example/api', digest: `sha256:${hash}` };
  const artifact = { type: 'image', service: 'api', profile: 'docker', platforms: ['linux/arm64'], ...image };
  const result = appRelease({ manifest, app, repository: 'example/app', sourceCommit: commit, sourceFingerprint: hash, artifacts: [artifact] });
  assert.deepEqual(result.manifest.sources, manifest.sources);
  assert.equal(result.manifest.services[0].sourceRef, 'api');
  assert.deepEqual(result.manifest.services[0].runtimes.docker.image, image);
  assert.equal(Object.hasOwn(result.manifest, 'source'), false);
  assert.equal(Object.hasOwn(result.descriptor, 'source'), false);
});

test('published local source writes the manifest path and qualified pin only to the named primary', () => {
  const app = { id: 'example.local', manifest: 'apps/local/manifest.json', profiles: ['local'], sourceReusable: true };
  const manifest = {
    id: app.id, version: '1.0.0', primarySource: 'application',
    sources: {
      application: { type: 'git', repository: 'https://github.com/example/app.git', branch: 'main' },
      ui: { type: 'git', repository: 'https://git.example.test/services/ui.git', commit: 'e'.repeat(40) },
    },
    runtimeProfiles: [{ key: 'local', type: 'localCommand' }],
    services: [{ key: 'api', sourceRef: 'application', runtimes: { local: { type: 'localCommand', command: 'run' } } }],
  };
  const options = { manifest, app, repository: 'Example/App', sourceCommit: commit, sourceFingerprint: hash, artifacts: [] };
  const first = appRelease(options);
  assert.deepEqual(first.manifest.sources.application, { ...manifest.sources.application, manifestPath: app.manifest, commit });
  assert.deepEqual(first.manifest.sources.ui, manifest.sources.ui);
  assert.equal(Object.hasOwn(first.manifest, 'source'), false);
  assert.equal(Object.hasOwn(manifest.sources.application, 'commit'), false);
  assert.equal(first.descriptor.source.inputFingerprint, hash);
  assert.equal(first.descriptor.source.commit, commit);

  const nextCommit = 'c'.repeat(40);
  const reused = appRelease({ ...options, sourceCommit: nextCommit, previous: first.descriptor });
  assert.equal(reused.manifest.sources.application.commit, commit);
  assert.equal(reused.descriptor.sourceCommit, nextCommit);
  assert.equal(reused.descriptor.releaseId, first.descriptor.releaseId);
  assert.throws(() => appRelease({ ...options, repository: 'example/other' }), /qualified publication checkout/);
  assert.throws(() => appRelease({ ...options, manifest: { ...manifest, primarySource: undefined } }), /declared primarySource/);
});

test('native release requires every role/RID and derives immutable URLs after identity', () => {
  const assets = ['cli','core'].map(role => ({ role, rid: 'custom-rid', fileName: role, size: 5, sha256: hash, inputFingerprint: hash, provenance: 'https://example.test/proof' }));
  const options = { version: '1.0.0', sourceCommit: commit, assets, repository: 'example/repo', rids: ['custom-rid'] };
  const release = platformRelease(options); assert.ok(release.descriptor.assets[0].url.includes(release.descriptor.releaseId));
  assert.throws(() => platformRelease({ ...options, assets: assets.slice(1) }), /Incomplete/);
});
test('build results must belong to the selected plan', () => {
  const plan = { sourceCommit: commit, validationRunId: '42', repository: 'example/repo', images: [{ recipe: { id: 'api', repository: 'example/api', platforms: ['linux/amd64'] }, inputFingerprint: hash, decision: 'build' }] };
  assert.equal(imageReceipt(plan, 'api', `sha256:${hash}`).receipt.buildSourceCommit, commit);
  assert.throws(() => imageReceipt(plan, 'other', `sha256:${hash}`), /Unexpected/);
});


test('local provider recipes pin source independently and never require a Harness worker image', () => {
  const publisher = validatePublisher(JSON.parse(readFileSync(new URL('../../distribution/release-publisher.json', import.meta.url))));
  assert.ok(!publisher.images.some(image => image.id === 'hosty-harness-worker'));
  for (const component of ['codex-provider', 'claude-code-provider', 'ollama-provider']) {
    const app = publisher.apps.find(app => app.id === `hosty.${component}`);
    const manifest = JSON.parse(readFileSync(new URL(`../../apps/${component}/manifest.json`, import.meta.url)));
    assert.deepEqual(app.profiles, ['local']); assert.ok(app.sourceInputs.includes('packages/agent-provider-runtime'));
    assert.equal(app.sourceIgnoreOptionalPeers, true);
    assert.ok(app.sourceInputs.includes('shared/web/hosty-theme.css'));
    assert.ok(app.sourceInputs.includes('shared/web/fonts'));
    const result = appRelease({ manifest, app, sourceCommit: commit, sourceFingerprint: hash, artifacts: [] });
    assert.equal(result.descriptor.source.commit, commit);
    assert.ok(result.descriptor.artifacts.every(artifact => artifact.type === 'source'));
  }
});

test('source and image fingerprints ignore an unreachable native SDK lock entry but retain their own graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosty-independent-source-'));
  try {
    mkdirSync(join(root, 'apps/a'), { recursive: true }); mkdirSync(join(root, 'apps/b'), { recursive: true });
    mkdirSync(join(root, 'packages/sdk'), { recursive: true });
    const pkg = { workspaces: ['apps/a','apps/b','packages/sdk'], scripts: { build: 'workspace build' } }, lock = lockFixture();
    for (const path of pkg.workspaces) writeFileSync(join(root, path, 'package.json'), JSON.stringify(lock.packages[path]));
    writeFileSync(join(root, 'apps/a/manifest.json'), JSON.stringify({ id: 'a' }));
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
    const recipe = { inputs: ['apps/a','package.json','package-lock.json'], dockerfile: 'apps/a/manifest.json', platforms: [], workspaces: ['apps/a'], retainRootScripts: true };
    const paths = ['apps/a/package.json','apps/a/manifest.json','apps/b/package.json','packages/sdk/package.json','package.json','package-lock.json'];
    const fingerprint = () => buildContext(root, recipe, { paths }).fingerprint;
    const before = fingerprint(); lock.packages['node_modules/unrelated'].integrity = 'sha512-native-update';
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock)); assert.equal(fingerprint(), before);
    lock.packages['node_modules/x'].integrity = 'sha512-own-update';
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock)); assert.notEqual(fingerprint(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('explicit local provider projection ignores optional native peers while keeping direct SDK and ordinary recipe closure', () => {
  const root=mkdtempSync(join(tmpdir(),'hosty-optional-native-'));
  try {
    const lock=lockFixture();
    lock.packages['packages/sdk'].peerDependencies.unrelated='^1';
    lock.packages['packages/sdk'].peerDependenciesMeta={unrelated:{optional:true}};
    const pkg={workspaces:lock.packages[''].workspaces};
    for(const workspace of pkg.workspaces) { mkdirSync(join(root,workspace),{recursive:true});writeFileSync(join(root,workspace,'package.json'),JSON.stringify(lock.packages[workspace])); }
    writeFileSync(join(root,'apps/a/manifest.json'),'{}'); writeFileSync(join(root,'package.json'),JSON.stringify(pkg));
    const paths=['package.json','package-lock.json','apps/a/package.json','apps/a/manifest.json','apps/b/package.json','packages/sdk/package.json'];
    const recipe={inputs:['apps/a','package.json','package-lock.json'],dockerfile:'apps/a/manifest.json',platforms:[],workspaces:['apps/a']};
    const fingerprint=ignoreOptionalPeers=>{writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock));return buildContext(root,{...recipe,...(ignoreOptionalPeers?{ignoreOptionalPeers:true}:{})},{paths}).fingerprint;};
    const provider=fingerprint(true), ordinary=fingerprint(false);
    lock.packages['node_modules/unrelated'].integrity='sha512-other-native';
    assert.equal(fingerprint(true),provider);assert.notEqual(fingerprint(false),ordinary);
    lock.packages['node_modules/x'].integrity='sha512-direct-native';assert.notEqual(fingerprint(true),provider);
  } finally {rmSync(root,{recursive:true,force:true});}
});


test('Harness publishes only its Docker production profile while retaining declared development profiles', () => {
  const publisher = JSON.parse(readFileSync(new URL('../../distribution/release-publisher.json', import.meta.url)));
  const app = publisher.apps.find(app => app.id === 'hosty.harness');
  const manifest = JSON.parse(readFileSync(new URL('../../apps/harness/manifest.json', import.meta.url)));
  assert.deepEqual(app.profiles, ['docker']);
  const image = publisher.images.find(image => image.appId === app.id);
  assert.ok(image.inputs.includes('scripts/npm-workspace.mjs'));
  const artifacts = [{ service: 'api', profile: 'docker', repository: image.repository, digest: `sha256:${hash}`, platforms: image.platforms },
    ...manifest.runtimeProfiles.filter(profile => profile.development && profile.type === 'docker').map(profile => ({ service: 'api', profile: profile.key, repository: 'node', digest: `sha256:${'c'.repeat(64)}`, platforms: image.platforms }))];
  const result = appRelease({ manifest, app, sourceCommit: commit, sourceFingerprint: hash, artifacts });
  assert.ok(!result.manifest.runtimeProfiles.some(profile => profile.key === 'local'));
  assert.ok(result.manifest.runtimeProfiles.some(profile => profile.key === 'dev' && profile.development));
  assert.ok(!result.descriptor.artifacts.some(artifact => artifact.type === 'source'));
});

test('provider settings theme and font bytes invalidate source release fingerprints', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-shared-inputs-'));
  try {
    const publisher = JSON.parse(readFileSync(new URL('../../distribution/release-publisher.json', import.meta.url)));
    for (const slug of ['codex-provider', 'claude-code-provider', 'ollama-provider']) {
      const app = publisher.apps.find(app => app.id === `hosty.${slug}`);
      const files = { [app.manifest]: '{}', 'shared/web/hosty-theme.css': 'theme', 'shared/web/fonts/font.woff2': 'font', 'shared/web/unrelated.tsx': 'component' };
      for (const [file, content] of Object.entries(files)) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), content); }
      const recipe = { inputs: app.sourceInputs, dockerfile: app.manifest, platforms: [] }, paths = Object.keys(files);
      const fingerprint = () => buildContext(root, recipe, { paths }).fingerprint;
      const before = fingerprint(); writeFileSync(join(root, 'shared/web/unrelated.tsx'), 'different'); assert.equal(fingerprint(), before);
      writeFileSync(join(root, 'shared/web/hosty-theme.css'), 'new theme'); assert.notEqual(fingerprint(), before);
      const afterTheme = fingerprint(); writeFileSync(join(root, 'shared/web/fonts/font.woff2'), 'new font'); assert.notEqual(fingerprint(), afterTheme);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

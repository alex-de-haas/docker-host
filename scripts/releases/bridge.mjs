import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MetadataStore } from './metadata.mjs';
import { bytes } from './registry.mjs';
import { sha256 } from './context.mjs';
import { verifyMetadata } from './publish.mjs';
import { verifyProvenance } from './evidence.mjs';

// This is the only compatibility asset replacement. Its retained intent fixes the bytes forever.
export async function freezeBridge({ store, config, distribution, repository, releaseId, request = fetch, run = execFileSync, verify = verifyMetadata, prove = verifyProvenance }) {
  if (repository !== distribution.legacyRepository || !/^[a-f0-9]{64}$/.test(releaseId ?? '')) throw new Error('Select a retained release in the declared bridge repository.');
  const head = store.refresh(), path = `platform/releases/${releaseId}/release.json`;
  const descriptor = store.json(head, path);
  if (!descriptor || descriptor.releaseId !== releaseId) throw new Error('The selected bridge release is missing.');
  const metadataCommit = store.run(['log', '--format=%H', '--diff-filter=A', head, '--', path]).split('\n').at(-1);
  const feeds = store.json(head, 'platform/feeds.json');
  if (!feeds?.feeds.some(f => f.default) || !feeds.feeds.some(f => f.id === distribution.migratedFeedId))
    throw new Error('Seed the declared default and migration feeds before publishing the compatibility bridge.');
  const ref = `https://raw.githubusercontent.com/${repository}/${metadataCommit}/${path}`;
  const descriptorBytes = store.read(metadataCommit, path);
  await verify(ref, descriptorBytes, request);
  if (descriptor.schemaVersion !== 'hosty-platform-release.0.1' || descriptor.assets.length !== config.platform.rids.length * 2
    || config.platform.rids.some(rid => ['cli','core'].some(role => descriptor.assets.filter(a => a.rid === rid && a.role === role).length !== 1)))
    throw new Error('The bridge must contain the complete declared native pair matrix.');
  const identity = { schemaVersion: 'hosty-platform-bridge.0.1', releaseId, releaseRef: ref, releaseSha256: sha256(descriptorBytes),
    repository, tag: distribution.legacyReleaseTag, migratedFeedId: distribution.migratedFeedId, indexRef: distribution.indexRef };
  let intent;
  await store.update('retain one-time platform bridge intent', latest => {
    const prior = store.json(latest, 'platform/bridge-intent.json');
    if (prior) {
      if (Object.keys(identity).some(key => identity[key] !== prior[key])) throw new Error('The compatibility bridge is already bound to another release; its cutoff cannot move.');
      intent = prior; return {};
    }
    intent = { ...identity, status: 'publishing', cutoff: new Date().toISOString() };
    return { 'platform/bridge-intent.json': { value: intent, immutable: true } };
  });
  const frozen = store.json(store.refresh(), 'platform/bridge.json');
  if (frozen) {
    if (frozen.releaseId !== releaseId || frozen.status !== 'frozen') throw new Error('Invalid frozen bridge record.');
    return frozen;
  }
  const directory = mkdtempSync(join(tmpdir(), 'hosty-bridge-'));
  try {
    const assets = [];
    for (const asset of descriptor.assets) {
      const response = await request(asset.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Bridge asset unavailable: ${asset.fileName}`);
      const data = await bytes(response, asset.size);
      if (data.length !== asset.size || sha256(data) !== asset.sha256) throw new Error(`Bridge asset changed: ${asset.fileName}`);
      const local = join(directory, asset.fileName); writeFileSync(local, data);
      await prove(local, { ...asset, buildSourceCommit: descriptor.sourceCommit }, repository);
      assets.push({ name: asset.fileName, data });
    }
    assets.push({ name: 'VERSION', data: Buffer.from(descriptor.version + '\n') },
      { name: 'SHA256SUMS', data: Buffer.from(descriptor.assets.map(a => `${a.sha256}  ${a.fileName}`).join('\n') + '\n') });
    // Old clients do not have a paired preparation transaction. The manual rollout records this window.
    for (const asset of assets) {
      const file = join(directory, asset.name); writeFileSync(file, asset.data);
      run('gh', ['release', 'upload', identity.tag, file, '--repo', repository, '--clobber'], { stdio: 'inherit' });
    }
    for (const asset of assets) {
      const response = await request(`https://github.com/${repository}/releases/download/${identity.tag}/${asset.name}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || sha256(await bytes(response, asset.data.length)) !== sha256(asset.data)) throw new Error('The bridge is not consumer-readable yet; retry the same release.');
    }
    const result = { ...intent, status: 'frozen' };
    await store.update('freeze verified platform compatibility bridge', () => ({ 'platform/bridge.json': { value: result, immutable: true } }));
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('distribution/release-publisher.json'));
  await freezeBridge({ store: new MetadataStore(process.cwd(), config.metadataBranch), config,
    distribution: JSON.parse(readFileSync('distribution/platform-release.json')),
    repository: process.env.GITHUB_REPOSITORY, releaseId: process.env.RELEASE_ID });
}

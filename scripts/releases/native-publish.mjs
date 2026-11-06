import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonical, sha256 } from './context.mjs';
import { platformRelease } from './model.mjs';
import { MetadataStore } from './metadata.mjs';
import { verifyProvenance } from './evidence.mjs';
import { bytes } from './registry.mjs';
import { promote, verifyMetadata, verifyNativeAssets } from './publish.mjs';

export async function publishNative({ plan, artifacts, store, request = fetch, run = execFileSync, prove = verifyProvenance }) {
  if (!plan.platform.selected) return;
  if (plan.platform.recoveryOnly) {
    const previous = plan.platform.previous;
    const descriptor = store.json(store.refresh(), `platform/releases/${previous.releaseId}/release.json`);
    if (!descriptor) throw new Error('Retained completed native release is missing.');
    for (const feed of plan.config.feeds.filter(f => f.policy === 'validated-source')) await promote({ store, config: plan.config,
      repository: plan.repository, target: 'platform', release: { descriptor }, metadataCommit: previous.metadataCommit,
      feedId: feed.id, kind: 'automatic', actor: process.env.GITHUB_ACTOR ?? 'publisher', promotionId: randomUUID(), prove, request });
    return;
  }
  const suffixes = { 'osx-arm64': 'darwin-arm64', 'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-x64', 'win-x64': 'windows-x64.exe' };
  const assets = [];
  for (const rid of plan.config.platform.rids) for (const role of ['cli','core']) {
    const name = `hosty${role === 'core' ? '-core' : ''}-${suffixes[rid]}`;
    const receipt = JSON.parse(readFileSync(join(artifacts, name + '.json')));
    const data = readFileSync(join(artifacts, name));
    if (receipt.role !== role || receipt.rid !== rid || receipt.fileName !== name || receipt.buildSourceCommit !== plan.sourceCommit
      || receipt.qualifiedInputs !== plan.platform.inputFingerprint || data.length !== receipt.size || sha256(data) !== receipt.sha256) throw new Error(`Native build result differs from the qualified plan: ${name}`);
    await prove(join(artifacts, name), receipt, plan.repository); assets.push(receipt);
  }
  const release = platformRelease({ version: plan.platform.version, sourceCommit: plan.sourceCommit, assets,
    repository: plan.repository, rids: plan.config.platform.rids });
  const temporary = mkdtempSync(join(tmpdir(), 'hosty-native-release-'));
  try {
    const notes = join(temporary, 'notes.md');
    writeFileSync(notes, `Immutable Core and CLI release ${release.descriptor.releaseId}.\n\nSource: ${plan.sourceCommit}\nValidated CI: https://github.com/${plan.repository}/actions/runs/${plan.validationRunId}\n`);
    const supplemental = [
      { fileName: 'VERSION', data: Buffer.from(plan.platform.version + '\n') },
      { fileName: 'SHA256SUMS', data: Buffer.from(assets.map(a => `${a.sha256}  ${a.fileName}`).join('\n') + '\n') },
    ].map(a => { const path = join(temporary, a.fileName); writeFileSync(path, a.data); return { ...a, path, size: a.data.length, sha256: sha256(a.data) }; });
    const uploads = [...assets.map(a => ({ ...a, path: join(artifacts, a.fileName) })), ...supplemental];
    const api = `https://api.github.com/repos/${plan.repository}/releases/tags/${release.tag}`;
    const response = await request(api, { headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }, signal: AbortSignal.timeout(60_000) });
    let existing;
    if (response.status === 404) {
      run('gh', ['release', 'create', release.tag, '--repo', plan.repository, '--target', plan.sourceCommit, '--draft', '--prerelease', '--title', `Hosty ${plan.platform.version}`, '--notes-file', notes], { stdio: 'inherit' });
      existing = { draft: true, assets: [] };
    } else if (response.ok) existing = JSON.parse((await bytes(response, 4 * 1024 * 1024)).toString());
    else throw new Error(`Cannot inspect immutable native release: HTTP ${response.status}`);
    if (existing.target_commitish && existing.target_commitish !== plan.sourceCommit) throw new Error('Existing immutable release belongs to another source commit.');
    const expectedNames = new Set(uploads.map(a => a.fileName));
    if (existing.assets.some(a => !expectedNames.has(a.name))) throw new Error('Immutable release contains unexpected assets.');
    for (const asset of uploads) {
      const present = existing.assets.find(a => a.name === asset.fileName);
      if (present) {
        // GitHub's authenticated asset endpoint also reads a retained draft safely on retry.
        const prior = await request(present.url, { headers: { Accept: 'application/octet-stream', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }, signal: AbortSignal.timeout(120_000) });
        if (!prior.ok || sha256(await bytes(prior, asset.size)) !== asset.sha256) throw new Error(`Existing immutable asset differs: ${asset.fileName}`);
      } else {
        if (!existing.draft) throw new Error('A published immutable release is incomplete; it cannot be repaired by overwriting it.');
        run('gh', ['release', 'upload', release.tag, asset.path, '--repo', plan.repository], { stdio: 'inherit' });
      }
    }
    if (existing.draft) run('gh', ['release', 'edit', release.tag, '--repo', plan.repository, '--draft=false'], { stdio: 'inherit' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const path = `platform/releases/${release.descriptor.releaseId}/release.json`;
  const metadataCommit = await store.update(`retain platform ${release.descriptor.releaseId}`, () => ({ [path]: { value: release.descriptor, immutable: true } }));
  await verifyMetadata(`https://raw.githubusercontent.com/${plan.repository}/${metadataCommit}/${path}`, canonical(release.descriptor) + '\n', request);
  await verifyNativeAssets(release.descriptor, plan.repository, { request, prove });
  await store.update('record completed platform candidate', head => {
    const current = store.json(head, 'platform/candidate.json');
    if (current?.sourceCommit && current.sourceCommit !== plan.sourceCommit && !store.ancestor(current.sourceCommit, plan.sourceCommit)) return {};
    return { 'platform/candidate.json': { value: { releaseId: release.descriptor.releaseId, metadataCommit,
      sourceCommit: plan.sourceCommit, inputFingerprint: plan.platform.inputFingerprint } } };
  });
  // Asset verification happens before a candidate or feed pointer can move.
  for (const feed of plan.config.feeds.filter(f => f.policy === 'validated-source')) await promote({ store, config: plan.config,
    repository: plan.repository, target: 'platform', release, metadataCommit, feedId: feed.id, kind: 'automatic',
    actor: process.env.GITHUB_ACTOR ?? 'publisher', promotionId: randomUUID(), prove, request });

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.env.RELEASE_PLAN ?? 'release-plan/release-plan.json'));
  await publishNative({ plan, artifacts: resolve(process.env.ARTIFACT_OUTPUT ?? 'release-artifacts'), store: new MetadataStore(process.cwd(), plan.config.metadataBranch) });
}

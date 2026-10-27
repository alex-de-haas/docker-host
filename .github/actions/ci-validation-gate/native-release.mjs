import { classifyPaths } from '../../../scripts/ci-policy.mjs';

// This receipt is written only after every release asset has been uploaded. The rolling tag
// and the release's target_commitish can move before uploads finish, so neither is a baseline.
export async function pendingNativeRelease({ repository, sourceSha, releaseTag, request }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || repository.split('/').some(part => part === '.' || part === '..')
    || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[\w-]+$/.test(releaseTag ?? '')) {
    throw new Error('Invalid native release identity.');
  }
  const root = '/repos/' + repository;
  const release = await request(root + '/releases/tags/' + releaseTag);
  // An absent or older-format receipt needs one recovery publication. API failures must throw.
  if (release === null || release.draft === true) return true;
  if (release.tag_name !== releaseTag || (release.body !== null && typeof release.body !== 'string')) {
    throw new Error('Malformed native release receipt.');
  }
  const receipts = (release.body ?? '').split(/\r?\n/).filter(line => line.startsWith('Published commit:'));
  if (receipts.length === 0) return true;
  if (receipts.length !== 1 || !/^Published commit: [a-f0-9]{40}$/.test(receipts[0])) {
    throw new Error('Malformed native release receipt.');
  }
  const published = receipts[0].slice('Published commit: '.length);
  if (published === sourceSha) return false;
  const diff = await request(root + '/compare/' + published + '...' + sourceSha);
  if (diff?.base_commit?.sha !== published) throw new Error('Native release comparison has a different baseline.');
  if (diff.status === 'behind') return false; // A late CI completion cannot move the channel backwards.
  if (diff.status !== 'ahead' || diff.merge_base_commit?.sha !== published || !Array.isArray(diff.files)) {
    throw new Error('Native release comparison is incomplete or diverged.');
  }
  // GitHub's comparison endpoint caps the changed-file list at 300, regardless of pagination.
  // Build conservatively at the cap instead of assuming omitted paths contain no native changes.
  if (diff.files.length >= 300) return true;
  const paths = [];
  for (const file of diff.files) {
    if (typeof file?.filename !== 'string' || !file.filename
      || (file.status === 'renamed' && (typeof file.previous_filename !== 'string' || !file.previous_filename))) {
      throw new Error('Native release comparison contains an invalid filename.');
    }
    paths.push(file.filename);
    if (file.previous_filename) paths.push(file.previous_filename);
  }
  const plan = classifyPaths(paths);
  return plan.components.some(component => component === 'core' || component === 'cli');
}

export function nativeReleaseRequest({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token) throw new Error('Native release lookup requires a contents:read token.');
  return async path => {
    const response = await fetchImpl(apiUrl + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && path.includes('/releases/tags/')) return null;
    if (!response.ok) throw new Error('Native release lookup failed with HTTP ' + response.status + '.');
    return response.json();
  };
}

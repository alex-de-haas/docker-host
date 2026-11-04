import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflowDirectory = new URL('../../workflows/', import.meta.url);
const publications = ['cardputer-release.yml', 'publish-app-sdk.yml', 'publish-app-sdk-dotnet.yml'];

// Inspect dependencies, not just presence of the gate: an unrelated passing gate cannot authorize a writer.
function jobsIn(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const matches = [...body.matchAll(/^  ([\w-]+):\n/gm)];
  return new Map(matches.map((match, index) => [match[1], body.slice(match.index, matches[index + 1]?.index)]));
}
function assertGated(text) {
  const jobs = jobsIn(text);
  assert.ok(jobs.size, 'workflow has jobs');
  const gated = (name, visited = new Set()) => {
    assert.ok(!visited.has(name), 'job dependency cycle');
    const job = jobs.get(name);
    assert.ok(job, `missing prerequisite ${name}`);
    const condition = /^    if: (.+)$/m.exec(job)?.[1];
    if (condition && !job.includes('uses: ./.github/actions/ci-validation-gate')) {
      assert.equal(condition, "needs.validation.outputs.publish == 'true'", 'publication prerequisites cannot override failure propagation');
    }
    assert.doesNotMatch(job, /continue-on-error:/, 'publication prerequisites cannot ignore failure');
    if (job.includes('uses: ./.github/actions/ci-validation-gate')) {
      assert.match(job, /^      actions: read$/m);
      assert.doesNotMatch(job, /if:.*always\(/, 'gate cannot ignore failure');
      assert.doesNotMatch(job, /continue-on-error:/, 'gate cannot ignore failure');
      return true;
    }
    const dependency = /^    needs: (.+)$/m.exec(job)?.[1];
    if (!dependency) return false;
    const parents = dependency.replace(/[\[\]]/g, '').split(',').map(value => value.trim());
    // Any successful prerequisite path through the gate is sufficient; failures block dependent jobs.
    return parents.some(parent => gated(parent, new Set([...visited, name])));
  };
  let writers = 0;
  for (const [name, job] of jobs) {
    if (/packages: write|contents: write|npm publish|dotnet nuget push/.test(job)) {
      writers++;
      assert.ok(gated(name), `${name} can publish without exact main CI validation`);
      assert.doesNotMatch(job, /^    if:.*always\(/m, 'publication cannot ignore a failed prerequisite');
    }
  }
  assert.ok(writers, 'workflow contains a publication job');
}

test('every remaining publication workflow is covered', () => {
  const workflows = readdirSync(workflowDirectory).filter(name => name.endsWith('.yml')
    && !['ci.yml', 'claude-code-review.yml'].includes(name));
  assert.deepEqual(workflows.sort(), [...publications, 'ready-releases.yml', 'promote-release.yml', 'platform-bridge.yml'].sort());
});

for (const file of publications) test(`publication cannot bypass successful exact-SHA main CI: ${file}`, () => {
  assertGated(readFileSync(new URL(file, workflowDirectory), 'utf8'));
});

test('structural check rejects disconnected or non-blocking validation', () => {
  const text = readFileSync(new URL('publish-app-sdk.yml', workflowDirectory), 'utf8');
  assert.throws(() => assertGated(text.replace('    needs: validation\n', '')), /without exact main CI/);
  assert.throws(() => assertGated(text.replace('  validation:\n', '  validation:\n    continue-on-error: true\n')), /ignore failure/);
  assert.throws(() => assertGated(text.replace('  publish:\n', '  publish:\n    if: always()\n')), /override failure/);
});

test('Cardputer consumes complete artifacts only from the validated run and SHA before writing releases', () => {
  const text = readFileSync(new URL('cardputer-release.yml', workflowDirectory), 'utf8');
  assert.match(text, /name: hosty-cardputer-\$\{\{ needs\.validation\.outputs\.source-sha \}\}/);
  assert.match(text, /run-id: \$\{\{ needs\.validation\.outputs\.run-id \}\}/);
  assert.match(text, /verify-cardputer\.mjs verified-cardputer "\$VALIDATED_SOURCE_SHA" dist/);
  const steps = text.split('      - name: ');
  const download = steps.find(step => step.startsWith('Download verified firmware'));
  assert.match(download, /if: steps\.guard\.outputs\.fresh == 'true' && github\.event_name != 'workflow_dispatch'/);
  assert.doesNotMatch(download, /continue-on-error:/);
  for (const command of ['tools/host-test.sh', 'tools/docker-build.sh', 'prepare-cardputer.mjs']) {
    const step = steps.find(candidate => candidate.includes(command));
    assert.ok(step, `manual recovery includes ${command}`);
    assert.match(step, /if: steps\.guard\.outputs\.fresh == 'true' && github\.event_name == 'workflow_dispatch'/);
    assert.doesNotMatch(step, /continue-on-error:/);
  }
  const verify = steps.find(step => step.startsWith('Verify and prepare release assets'));
  assert.match(verify, /if: steps\.guard\.outputs\.fresh == 'true'\n/);
  assert.doesNotMatch(verify, /continue-on-error:|github\.event_name/);
  assert.ok(text.indexOf('verify-cardputer.mjs') < text.indexOf('uses: actions/attest@'));
  assert.match(text, /group: cardputer-dev-release\n      cancel-in-progress: false/);
  assert.match(text, /uses: \.\/\.github\/actions\/publish-guard/);
});

test('retains independent SDK publishing and Core/CLI production RID matrix', () => {
  for (const file of ['publish-app-sdk.yml', 'publish-app-sdk-dotnet.yml']) {
    const text = readFileSync(new URL(file, workflowDirectory), 'utf8');
    assert.doesNotMatch(text, /^    concurrency:/m);
    assert.match(text, /id-token: write/);
  }
  const cli = readFileSync(new URL('ready-releases.yml', workflowDirectory), 'utf8');
  const ci = readFileSync(new URL('ci.yml', workflowDirectory), 'utf8');
  const supportedRids = ['osx-arm64', 'linux-arm64', 'linux-x64', 'win-x64'];
  for (const job of [jobsIn(ci).get('core-aot'), jobsIn(cli).get('native')]) {
    assert.deepEqual([...job.matchAll(/\brid: ([\w-]+)/g)].map(match => match[1]), supportedRids);
  }
  const build = jobsIn(cli).get('native');
  assert.doesNotMatch(build, /hosty-(?:core-)?darwin-x64/);
  assert.match(cli, /uses: \.\/\.github\/actions\/ci-validation-gate/);
  assert.match(cli, /dotnet publish apps\/core/);
  assert.match(cli, /dotnet publish apps\/cli/);
});

test('completed-CI publications bind every source consumer while SDKs preserve push provenance', () => {
  for (const file of publications) {
    const text = readFileSync(new URL(file, workflowDirectory), 'utf8');
    const sdk = file.startsWith('publish-app-sdk');
    if (sdk) {
      assert.match(text, /^  push:/m);
      assert.doesNotMatch(text, /^  workflow_run:/m);
      continue;
    }
    assert.match(text, /^  workflow_run:/m);
    assert.doesNotMatch(text, /^  push:/m);
    assert.match(text, /workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]/);
    for (const condition of ["workflow_run.event == 'push'", "workflow_run.conclusion == 'success'", "workflow_run.head_branch == 'main'", 'workflow_run.head_repository.full_name == github.repository']) {
      assert.ok(text.includes(condition), `${file} rejects unqualified trigger: ${condition}`);
    }
    const checkouts = text.split('uses: actions/checkout@v7').slice(1);
    assert.match(checkouts[0], /^\n        with:\n          fetch-depth: 1/);
    for (const checkout of checkouts.slice(1)) assert.match(checkout, /^\n        with:\n          ref: \$\{\{ needs.validation.outputs.source-sha \}\}/);
    assert.doesNotMatch(text, /\$\{?GITHUB_SHA\}?|github\.sha/);
    assert.match(text, /source-sha: \$\{\{ needs.validation.outputs.source-sha \}\}/);
    assert.doesNotMatch(text, /uses: actions\/attest-build-provenance/);
    assert.ok(text.includes('predicate-type: https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1\n          predicate-path: publication-provenance.json'), `${file} declares the supported custom predicate contract`);
    if (file.endsWith('-image.yml')) {
      assert.match(text, /context: git/);
      const attach = text.indexOf('run: git switch --create hosty-publish-source "$PUBLISH_SOURCE_SHA"');
      assert.ok(attach > 0 && attach < text.indexOf('- name: Extract Docker metadata'), `${file} gives exact-SHA Git metadata a named local ref`);
    } else assert.match(text, /git tag --force (?:cli-dev|cardputer-dev) "\$\{?PUBLISH_SOURCE_SHA\}?"/);
  }
});

test('ready-release writers require the exact qualified source and successful artifact prerequisites', () => {
  const text = readFileSync(new URL('ready-releases.yml', workflowDirectory), 'utf8'), jobs = jobsIn(text);
  const prepare = jobs.get('prepare');
  assert.match(prepare, /uses: \.\/\.github\/actions\/ci-validation-gate/);
  assert.match(prepare, /PUBLISH_SOURCE_SHA: \$\{\{ steps.validation.outputs.source-sha \}\}/);
  assert.doesNotMatch(text, /git push --force|--clobber/);
  for (const name of ['prepare','images','native','publish-platform']) assert.doesNotMatch(jobs.get(name), /continue-on-error:/);
  assert.match(jobs.get('publish-apps'), /uses: actions\/download-artifact[^\n]*\n        continue-on-error: true\n        if: needs.prepare.outputs.has-images/);
  for (const name of ['images','native']) {
    assert.match(jobs.get(name), /^    needs: prepare$/m);
    assert.match(jobs.get(name), /ref: \$\{\{ needs.prepare.outputs.source \}\}/);
  }
  assert.match(jobs.get('publish-apps'), /^    needs: \[prepare, images\]$/m);
  assert.match(jobs.get('publish-apps'), /if: always\(\) && needs.prepare.result == 'success' && needs.images.result != 'cancelled'/);
  assert.match(jobs.get('publish-platform'), /^    needs: \[prepare, native\]$/m);
  assert.match(jobs.get('publish-platform'), /if: needs.native.result == 'success'/);
  for (const name of ['publish-apps','publish-platform']) assert.match(jobs.get(name), /ref: \$\{\{ needs.prepare.outputs.source \}\}/);
  assert.match(text, /context: release-plan\/contexts\//);
  assert.match(text, /tar -xf release-plan\/contexts.tar/);
});

test('manual promotion selects an exact retained release and never invokes a builder', () => {
  const text = readFileSync(new URL('promote-release.yml', workflowDirectory), 'utf8');
  assert.match(text, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(text, /RELEASE_ID: \$\{\{ inputs.release-id \}\}/);
  assert.match(text, /EXPECTED_RELEASE: \$\{\{ inputs.expected-release \}\}/);
  assert.match(text, /PROMOTION_ID: \$\{\{ inputs.request-id \}\}/);
  assert.doesNotMatch(text, /workflow_run:|build-push-action|dotnet publish|continue-on-error:/);
  const implementation = readFileSync(new URL('../../../scripts/releases/publish.mjs', import.meta.url), 'utf8');
  assert.match(implementation, /await verify\(artifact.repository, artifact.digest, artifact.platforms\)/);
  assert.match(implementation, /await prove\(/);
});

test('compatibility bridge is an explicitly selected manual cutoff, never an automatic writer', () => {
  const text = readFileSync(new URL('platform-bridge.yml', workflowDirectory), 'utf8');
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /RELEASE_ID: \$\{\{ inputs.release-id \}\}/);
  assert.doesNotMatch(text, /workflow_run:|build-push-action|dotnet publish|continue-on-error:/);
});

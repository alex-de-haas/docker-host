import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflowDirectory = new URL('../../workflows/', import.meta.url);
const publications = [
  'harness-worker-image.yml', 'shell-image.yml', 'marketplace-image.yml', 'plans-image.yml',
  'demo-app-image.yml', 'telemetry-backend-image.yml', 'telemetry-ui-image.yml',
  'cli-release.yml', 'cardputer-release.yml', 'publish-app-sdk.yml', 'publish-app-sdk-dotnet.yml',
];

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
  assert.deepEqual(workflows.sort(), [...publications].sort());
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
  const cli = readFileSync(new URL('cli-release.yml', workflowDirectory), 'utf8');
  for (const rid of ['osx-arm64', 'osx-x64', 'linux-arm64', 'linux-x64', 'win-x64']) assert.match(cli, new RegExp(`rid: ${rid}`));
  assert.match(cli, /npm run core:test/);
  assert.match(cli, /npm run cli:test/);
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
    assert.match(text, /predicate-type: https:\/\/slsa.dev\/provenance\/v1\n          predicate-path: publication-provenance.json/);
    if (file.endsWith('-image.yml')) assert.match(text, /context: git/);
    else assert.match(text, /git tag --force (?:cli-dev|cardputer-dev) "\$\{?PUBLISH_SOURCE_SHA\}?"/);
  }
});

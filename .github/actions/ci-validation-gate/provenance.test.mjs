import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationProvenance } from './provenance.mjs';

const env = {
  GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY_ID: '123456789', GITHUB_REPOSITORY_OWNER_ID: '987654321', RUNNER_ENVIRONMENT: 'github-hosted',
  PUBLISH_SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'c'.repeat(40),
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/shell-image.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_run', VALIDATED_CI_RUN_ID: '123', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '2',
  PUBLICATION_KIND: 'build-image',
};

test('provenance separates validated source, executing workflow and latest event context', () => {
  const predicate = publicationProvenance(env);
  const deps = predicate.buildDefinition.resolvedDependencies;
  assert.deepEqual(deps[0], { uri: `git+https://github.com/owner/repo@${env.PUBLISH_SOURCE_SHA}`, name: 'validated-source', digest: { gitCommit: env.PUBLISH_SOURCE_SHA } });
  assert.deepEqual(deps[1], { uri: 'git+https://github.com/owner/repo@refs/heads/main', name: 'publishing-workflow', digest: { gitCommit: env.GITHUB_WORKFLOW_SHA } });
  assert.deepEqual(predicate.buildDefinition.internalParameters.github, {
    event_name: 'workflow_run', repository_id: '123456789', repository_owner_id: '987654321',
    runner_environment: 'github-hosted', execution_sha: env.GITHUB_SHA,
  });
  assert.equal(predicate.runDetails.builder.id, `https://github.com/${env.GITHUB_WORKFLOW_REF}`);
  assert.equal(predicate.buildDefinition.externalParameters.source.commit, env.PUBLISH_SOURCE_SHA);
  assert.equal(predicate.buildDefinition.externalParameters.validation.runId, '123');
  assert.equal(predicate.runDetails.metadata.invocationId, 'https://github.com/owner/repo/actions/runs/456/attempts/2');
});

test('firmware provenance distinguishes verified CI producer from manual rebuild', () => {
  const produced = publicationProvenance({ ...env, PUBLICATION_KIND: 'firmware' });
  assert.equal(produced.buildDefinition.externalParameters.operation, 'publish-verified-ci-firmware');
  assert.equal(produced.buildDefinition.resolvedDependencies[2].name, 'firmware-producer-ci-run');
  const manual = publicationProvenance({ ...env, PUBLICATION_KIND: 'firmware', GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(manual.buildDefinition.externalParameters.operation, 'build-firmware-for-manual-publication');
  assert.equal(manual.buildDefinition.resolvedDependencies[2].name, 'successful-ci-validation');
});

for (const changed of [{ PUBLISH_SOURCE_SHA: 'main' }, { GITHUB_WORKFLOW_SHA: '' }, { GITHUB_SHA: 'short' },
  { VALIDATED_CI_RUN_ID: '' }, { GITHUB_RUN_ID: 'other' }, { GITHUB_RUN_ATTEMPT: '0' },
  { GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/shell-image.yml@refs/heads/feature' },
  { GITHUB_EVENT_NAME: 'pull_request' }, { PUBLICATION_KIND: 'unknown' }]) {
  test(`provenance rejects invalid source or execution identity: ${JSON.stringify(changed)}`, () => {
    assert.throws(() => publicationProvenance({ ...env, ...changed }));
  });
}

test('publication uses its own build contract for completion-triggered and manual events', () => {
  for (const event of ['workflow_run', 'workflow_dispatch']) {
    const predicate = publicationProvenance({ ...env, GITHUB_EVENT_NAME: event });
    assert.equal(predicate.buildDefinition.buildType,
      'https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1');
    assert.equal(predicate.buildDefinition.internalParameters.github.event_name, event);
    assert.deepEqual(predicate.buildDefinition.externalParameters.workflow, {
      ref: 'refs/heads/main', repository: 'https://github.com/owner/repo', path: '.github/workflows/shell-image.yml',
    });
  }
});

test('repository identity remains numeric strings, including IDs beyond JavaScript integer precision', () => {
  const predicate = publicationProvenance({ ...env, GITHUB_REPOSITORY_ID: '9007199254740993', GITHUB_REPOSITORY_OWNER_ID: '9007199254740995' });
  assert.equal(predicate.buildDefinition.internalParameters.github.repository_id, '9007199254740993');
  assert.equal(predicate.buildDefinition.internalParameters.github.repository_owner_id, '9007199254740995');
});

for (const field of ['GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID']) {
  test(`provenance rejects missing or malformed ${field}`, () => {
    for (const value of [undefined, null, '', '0', '-1', '+1', '01', '1.5', '1e3', ' 123', '123\n', 123]) {
      assert.throws(() => publicationProvenance({ ...env, [field]: value }), /positive numeric repository and owner IDs as strings/,
        `accepted ${field}=${String(value)}`);
    }
  });
}

test('both supported runner identities are emitted without changing the actual builder workflow', () => {
  for (const runner of ['github-hosted', 'self-hosted']) {
    const predicate = publicationProvenance({ ...env, RUNNER_ENVIRONMENT: runner });
    assert.equal(predicate.buildDefinition.internalParameters.github.runner_environment, runner);
    assert.equal(predicate.runDetails.builder.id, `https://github.com/${env.GITHUB_WORKFLOW_REF}`);
  }
  for (const runner of [undefined, null, '', 'hosted', 'unknown', 'github-hosted\n']) {
    assert.throws(() => publicationProvenance({ ...env, RUNNER_ENVIRONMENT: runner }), /recognized runner environment/);
  }
});

test('workflow and source dependencies use the actual server and retain separate commit bindings', () => {
  const server = 'https://github.example.test';
  const workflow = 'owner/repo/.github/workflows/cardputer-release.yml@refs/heads/main';
  const predicate = publicationProvenance({ ...env, GITHUB_SERVER_URL: server, GITHUB_WORKFLOW_REF: workflow, PUBLICATION_KIND: 'firmware' });
  const dependencies = predicate.buildDefinition.resolvedDependencies;
  assert.equal(predicate.runDetails.builder.id, `${server}/${workflow}`);
  assert.equal(dependencies.find(dep => dep.name === 'publishing-workflow').uri, `git+${server}/owner/repo@refs/heads/main`);
  assert.equal(dependencies.find(dep => dep.name === 'publishing-workflow').digest.gitCommit, env.GITHUB_WORKFLOW_SHA);
  assert.equal(dependencies.find(dep => dep.name === 'validated-source').uri, `git+${server}/owner/repo@${env.PUBLISH_SOURCE_SHA}`);
  assert.equal(dependencies.find(dep => dep.name === 'validated-source').digest.gitCommit, env.PUBLISH_SOURCE_SHA);
});

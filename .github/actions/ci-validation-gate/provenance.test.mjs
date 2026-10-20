import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationProvenance } from './provenance.mjs';

const env = {
  GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: 'https://github.com',
  PUBLISH_SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'c'.repeat(40),
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/shell-image.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_run', VALIDATED_CI_RUN_ID: '123', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '2',
  PUBLICATION_KIND: 'build-image',
};

test('provenance separates validated source, executing workflow and latest event context', () => {
  const predicate = publicationProvenance(env);
  const deps = predicate.buildDefinition.resolvedDependencies;
  assert.equal(deps[0].digest.gitCommit, env.PUBLISH_SOURCE_SHA);
  assert.equal(deps[1].digest.gitCommit, env.GITHUB_WORKFLOW_SHA);
  assert.equal(predicate.buildDefinition.internalParameters.github.execution_sha, env.GITHUB_SHA);
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

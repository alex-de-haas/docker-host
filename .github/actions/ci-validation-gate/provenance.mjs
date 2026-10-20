import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const runId = value => /^[1-9][0-9]*$/.test(String(value ?? ''));
const numericIdentity = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const buildType = 'https://github.com/alex-de-haas/docker-host/blob/main/docs/features/ci-feedback-loop/feature.md#publication-provenance-v1';

// Automatic provenance uses the signing workflow's OIDC SHA, which can be newer than workflow_run
// source. Keep execution identity honest and declare the validated input separately:
// https://github.com/actions/toolkit/blob/main/packages/attest/src/provenance.ts
export function publicationProvenance(env) {
  const repository = env.GITHUB_REPOSITORY;
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const sourceSha = env.PUBLISH_SOURCE_SHA;
  const workflowSha = env.GITHUB_WORKFLOW_SHA;
  const executionSha = env.GITHUB_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !sha(sourceSha) || !sha(workflowSha) || !sha(executionSha)
    || !runId(env.VALIDATED_CI_RUN_ID) || !runId(env.GITHUB_RUN_ID) || !runId(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error('Provenance requires full source/execution/workflow SHAs, repository and validated run identities.');
  }
  if (!numericIdentity(env.GITHUB_REPOSITORY_ID) || !numericIdentity(env.GITHUB_REPOSITORY_OWNER_ID)) {
    throw new Error('Provenance requires positive numeric repository and owner IDs as strings.');
  }
  if (!['github-hosted', 'self-hosted'].includes(env.RUNNER_ENVIRONMENT)) throw new Error('Provenance requires a recognized runner environment.');
  if (!['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Unexpected publication provenance event.');
  const prefix = `${repository}/`;
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  if (!workflowRef?.startsWith(prefix) || !/^\.github\/workflows\/[\w.-]+\.yml@refs\/heads\/main$/.test(workflowRef.slice(prefix.length))) {
    throw new Error('Publication provenance requires a main workflow identity.');
  }
  if (new URL(server).origin !== server || !server.startsWith('https://')) throw new Error('Invalid GitHub server identity.');
  const [workflowPath, ref] = workflowRef.slice(prefix.length).split('@');
  const repositoryUrl = `${server}/${repository}`;
  const ciRun = `${repositoryUrl}/actions/runs/${env.VALIDATED_CI_RUN_ID}`;
  const firmware = env.PUBLICATION_KIND === 'firmware';
  const operation = firmware ? env.GITHUB_EVENT_NAME === 'workflow_run'
    ? 'publish-verified-ci-firmware' : 'build-firmware-for-manual-publication'
    : env.PUBLICATION_KIND;
  if (!['publish-verified-ci-firmware', 'build-firmware-for-manual-publication', 'build-image', 'build-native-release'].includes(operation)) {
    throw new Error('Unknown publication provenance operation.');
  }
  return {
    buildDefinition: {
      buildType,
      externalParameters: {
        workflow: { ref, repository: repositoryUrl, path: workflowPath },
        source: { repository: repositoryUrl, commit: sourceSha },
        validation: { workflow: '.github/workflows/ci.yml', runId: String(env.VALIDATED_CI_RUN_ID) },
        operation,
      },
      internalParameters: {
        github: {
          event_name: env.GITHUB_EVENT_NAME,
          repository_id: env.GITHUB_REPOSITORY_ID,
          repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
          runner_environment: env.RUNNER_ENVIRONMENT,
          execution_sha: executionSha,
        },
      },
      resolvedDependencies: [
        { uri: `git+${repositoryUrl}@${sourceSha}`, name: 'validated-source', digest: { gitCommit: sourceSha } },
        { uri: `git+${repositoryUrl}@${ref}`, name: 'publishing-workflow', digest: { gitCommit: workflowSha } },
        { uri: ciRun, name: firmware && env.GITHUB_EVENT_NAME === 'workflow_run' ? 'firmware-producer-ci-run' : 'successful-ci-validation' },
      ],
    },
    runDetails: {
      builder: { id: `${server}/${workflowRef}` },
      metadata: { invocationId: `${repositoryUrl}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { writeFileSync('publication-provenance.json', `${JSON.stringify(publicationProvenance(process.env))}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

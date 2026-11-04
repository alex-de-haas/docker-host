import { execFileSync } from 'node:child_process';
import { fullCommit, canonical } from './context.mjs';

export const predicateType = 'https://hosty.dev/attestations/release-artifact/v1';
export function artifactPredicate({ sourceCommit, inputFingerprint, repository, validationRunId, artifactId, platforms }) {
  if (!fullCommit(sourceCommit) || !/^[a-f0-9]{64}$/.test(inputFingerprint) || !/^[1-9]\d*$/.test(String(validationRunId)) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Incomplete artifact provenance.');
  return { schemaVersion: 'hosty-artifact-provenance.0.1', repository, sourceCommit, inputFingerprint,
    artifactId, platforms, validation: { workflow: '.github/workflows/ci.yml', runId: String(validationRunId) } };
}
export function verifyProvenance(subject, receipt, repository, { run = execFileSync } = {}) {
  const output = run('gh', ['attestation', 'verify', subject, '--repo', repository,
    '--signer-workflow', `${repository}/.github/workflows/ready-releases.yml`, '--source-ref', 'refs/heads/main',
    '--predicate-type', predicateType, '--deny-self-hosted-runners', '--format', 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const results = JSON.parse(output);
  const match = results.find(result => {
    const predicate = result.verificationResult?.statement?.predicate;
    return predicate?.schemaVersion === 'hosty-artifact-provenance.0.1' && predicate.repository === repository
      && predicate.artifactId === receipt.artifactId
      && canonical(predicate.platforms?.slice().sort()) === canonical((receipt.platforms ?? [receipt.rid]).slice().sort())
      && predicate.sourceCommit === receipt.buildSourceCommit && predicate.inputFingerprint === receipt.inputFingerprint
      && predicate.validation?.workflow === '.github/workflows/ci.yml' && /^[1-9]\d*$/.test(predicate.validation?.runId ?? '');
  });
  if (!match) throw new Error('Signed artifact provenance does not match the retained source/input fingerprint.');
  return match.verificationResult.statement.predicate;
}

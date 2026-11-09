import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pendingNativeRelease, nativeReleaseRequest } from './native-release.mjs';
import { ALL_JOBS, COMPONENTS, evaluateGate } from '../../../scripts/ci-policy.mjs';

// Retained format-1 evidence can describe checks removed from today's workflow.
// Exact-SHA and successful-attempt validation still happens before this schema check.
const historicalProfiles = new Set(['core-windows-process-control', 'workspace-native-activation',
  'core-transport', 'harness-worker', 'whisper-native']);

export function validateSelection(manifest, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('Publication selection requires a full source SHA.');
  const keys = ['format', 'sourceSha', 'baseSha', 'components', 'profiles', 'required'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).length !== keys.length || keys.some(key => !Object.hasOwn(manifest, key))
    || manifest.format !== 1 || manifest.sourceSha !== sourceSha
    || !(manifest.baseSha === null || /^[a-f0-9]{40}$/.test(manifest.baseSha ?? ''))) {
    throw new Error('CI selection manifest schema or source SHA does not match the validated run.');
  }
  const plan = { version: 1, components: manifest.components, profiles: manifest.profiles,
    required: manifest.required, reasons: {} };
  for (const field of ['components', 'profiles', 'required']) {
    if (!Array.isArray(plan[field]) || new Set(plan[field]).size !== plan[field].length) {
      throw new Error('Invalid CI selection manifest: missing or duplicate ' + field);
    }
  }
  for (const job of historicalProfiles) {
    if (plan.profiles.includes(job) !== plan.required.includes(job)) {
      throw new Error('Invalid CI selection manifest: inconsistent historical profile ' + job);
    }
  }
  const current = { ...plan,
    profiles: plan.profiles.filter(job => !historicalProfiles.has(job)),
    required: plan.required.filter(job => !historicalProfiles.has(job)),
  };
  // Reuse the CI gate's own component/profile/required consistency rules. These synthetic results
  // only validate schema: the preceding gate already verifies the real successful CI attempt.
  const needs = Object.fromEntries(ALL_JOBS.map(job => [job,
    { result: Array.isArray(plan.required) && plan.required.includes(job) ? 'success' : 'skipped' }]));
  const errors = evaluateGate(current, needs);
  if (errors.length) throw new Error(`Invalid CI selection manifest: ${errors.join('; ')}`);
  return plan;
}

export function publicationSelected(event, components, manifest, sourceSha) {
  if (!components.length || components.some(value => !COMPONENTS.includes(value))) {
    throw new Error('Publication requires known component selectors.');
  }
  if (event === 'workflow_dispatch' || event === 'push') return true;
  if (event !== 'workflow_run') throw new Error('Automatic publication requires a completed CI change selection.');
  const plan = validateSelection(manifest, sourceSha);
  return components.some(component => plan.components.includes(component));
}

export function selectPublication({ context, components, manifestPath,
  readManifest = path => JSON.parse(readFileSync(path, 'utf8')) }) {
  const manifest = context.event === 'workflow_run' ? readManifest(manifestPath) : undefined;
  return publicationSelected(context.event, components, manifest, context.sha);
}

export async function selectPublicationWithRecovery(options, nativeRelease = {}) {
  const selected = selectPublication(options);
  if (selected || !nativeRelease.releaseTag) return selected;
  if (options.components.some(component => !['core', 'cli'].includes(component))) {
    throw new Error('Native release recovery is only available to Core/CLI publication.');
  }
  return pendingNativeRelease({ ...nativeRelease, sourceSha: options.context.sha });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const publish = await selectPublicationWithRecovery({
      context: { event: process.env.GITHUB_EVENT_NAME, sha: process.env.CI_GATE_SOURCE_SHA },
      components: (process.env.CI_GATE_COMPONENTS ?? '').split(',').map(value => value.trim()),
      manifestPath: process.env.CI_GATE_SELECTION_PATH,
    }, {
      repository: process.env.GITHUB_REPOSITORY, releaseTag: process.env.CI_GATE_NATIVE_RELEASE_TAG,
      request: path => nativeReleaseRequest({
        token: process.env.CI_GATE_TOKEN, apiUrl: process.env.GITHUB_API_URL,
      })(path),
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub Actions output file.');
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALL_JOBS, BASE_JOBS, fullPlan, evaluateGate } from './ci-policy.mjs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = Object.fromEntries([...workflow.split('\njobs:\n')[1].matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));

test('all workflow jobs participate in the stable aggregate and policy', () => {
  assert.deepEqual(Object.keys(jobs).filter(job => job !== 'ci-required').sort(), [...ALL_JOBS].sort());
  const dependencies = jobs['ci-required'].match(/    needs: \[([^\]]+)\]/)[1].split(',').map(value => value.trim());
  assert.deepEqual(dependencies.sort(), [...ALL_JOBS].sort());
  assert.match(jobs['ci-required'], /if: always\(\)/);
  assert.match(jobs['ci-required'], /CI_NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  const outputs = jobs.changes;
  for (const job of ALL_JOBS.filter(job => !BASE_JOBS.includes(job))) {
    const key = job === 'actionlint' ? 'workflows' : job.replaceAll('-', '_');
    assert.match(outputs, new RegExp(`^      ${key}:`, 'm'), `Missing selection output for ${job}`);
    assert.ok(jobs[job].includes(`if: needs.changes.outputs.${key} == 'true'`), `Missing policy condition for ${job}`);
  }
  const results = Object.fromEntries(ALL_JOBS.map(job => [job, { result: 'success' }]));
  assert.deepEqual(evaluateGate(fullPlan(), results), []);
  for (const job of ALL_JOBS) {
    assert.ok(evaluateGate(fullPlan(), { ...results, [job]: { result: 'skipped' } }).length, `Gate accepted unexpectedly skipped ${job}`);
  }
});

test('qualification checks selected source and cannot cancel main push validation', () => {
  for (const [job, content] of Object.entries(jobs)) {
    if (job === 'changes') continue;
    if (['ci-policy', 'ci-required'].includes(job)) {
      assert.match(content, /ref: \$\{\{ github.sha \}\}/, `${job} must use the executing workflow policy even for older manual source`);
      continue;
    }
    assert.match(content, /ref: \$\{\{ needs.changes.outputs.sha(?: \|\| github.sha)? \}\}/, `${job} checks a different revision`);
  }
  assert.match(workflow, /group: .*github.event_name/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \|\| github.event_name == 'workflow_dispatch' \}\}/);
  assert.match(jobs['core-aot'], /needs: changes/);
  assert.doesNotMatch(jobs['core-aot'], /needs: (?:\[.*core|core\s)/);
  assert.doesNotMatch(workflow, /^  workspaces:/m);
});

"""Submit the real application task through Harness and retain observable outcomes."""
import json
import time
from api import ROOT, request

state = json.loads((ROOT / 'coordinator/session.json').read_text())
runtime = json.loads((ROOT / 'coordinator/runtime.json').read_text())
evidence = ROOT / 'evidence'
record_path = ROOT / 'core-instance/apps/hosty.harness/data/sessions' / state['session_id'] / 'record.json'
route = '/api/sessions/' + state['session_id']
phase_path = ROOT / 'agent-data/benchmark-phase'
def phase(value):
    (evidence / 'phase').write_text(value)
    print(json.dumps({'phase':value}), flush=True)

phase('idle_before_work')
time.sleep(30)
prompt = f'''Continue the operator-authorized Docker/Harness experiment in the already registered Demo App workspace. This is a disposable integration experiment; do not publish, create commits or PRs, change runtime selection, or touch installed app data. The generic live-host preamble is not the environment for this test. Core owns this workspace: {runtime['workspace']}.

Use hosty-workspaces prepare (appId com.haas.demo-app, a fresh UUID requestId) to confirm/reuse the existing binding, and inspect status. Then read the applicable repository instructions. Perform this small real bug fix in apps/demo-app/src/lib/demo-config.ts: DEMO_REFRESH_SECONDS must accept positive finite integers; missing, blank/whitespace, zero, negative, fractional, NaN/text and infinite values must fall back to 30. Preserve valid positive integers, including values with surrounding whitespace. Add meaningful regression coverage through getDemoConfig in apps/demo-app/test/demo-config.test.ts, restoring environment after each test. This trial patch stays uncommitted and is not a release; no version bump is needed for the disposable experiment.

Use the real repository packages and production build. At repository root, install locked dependencies with npm ci --workspace @haas/hosty-demo-app --workspace @hosty-sdk/app --include=dev --no-audit --no-fund. Do not change dependency versions or the lockfile. After installation read any relevant installed Next.js guide if changing framework code. Before the source fix, run the new regression tests and confirm they fail for the invalid values. Then fix the code. Run the entire Demo App test suite, its lint and npm run build --workspace @haas/hosty-demo-app. Do not claim success unless each command actually exits 0. Do not launch a browser or dev server.

For measurement, before each stage write just its name to {phase_path}: dependencies, regression_red, editing, tests, lint, build, or complete. This file is authorized agent data. Keep command logs and exit statuses under {ROOT / 'agent-data/verification'}; do not hide exit failures behind pipes. Use a separate command per stage. You may add a concise doc note for this bug fix if repository policy requires it, but keep changes scoped. Use no more than 2 test workers if needed for the container's CPU budget. Do not read credentials or contact Core directly; use the scoped workspace tools. Finish with hosty-workspaces status and a concise report of the exact commands, outcomes and changed paths.'''
(evidence / 'task.txt').write_text(prompt)
phase('agent_task_start')
started = time.monotonic()
request(state['origin'], route + '/messages', {'text':prompt})
last = None
while time.monotonic() - started < 1200:
    time.sleep(1)
    current = phase_path.read_text().strip() if phase_path.exists() else 'agent_task_start'
    if current != last:
        phase(current);last=current
    record = json.loads(record_path.read_text())
    if record['status'] in ['idle','failed','cancelled','awaiting_approval','awaiting_question']:
        outcome={'status':record['status'],'seconds':time.monotonic()-started,'harnessSessionId':record.get('harnessSessionId')}
        (evidence/'workload-result.json').write_text(json.dumps(outcome,indent=2));print(json.dumps(outcome),flush=True)
        break
else:
    raise RuntimeError('Experiment exceeded 20 minutes; inspect the session before continuing.')
phase('idle_after_work')
time.sleep(30)
workspace=request(state['origin'],route+'/workspaces',{'action':'status','workspaceId':runtime['workspaceId']})
(evidence/'workspace-after.json').write_text(json.dumps(workspace,indent=2))
print(json.dumps({'workspace_state':workspace.get('observation',{}).get('state'),'leases':workspace.get('leases'),'phase':'captured'}),flush=True)

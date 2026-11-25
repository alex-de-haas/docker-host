"""Exercise the v2 provider through a real Core Local installation and its signed-in Harness consumer."""
import collections
import json
from pathlib import Path
import sqlite3
import urllib.error
import urllib.request
import uuid

from agent_provider_acceptance import execution_stopped


def native_proof(data, target):
    """Read only the committed identities, effect counts and independently issued physical receipts."""
    run_id, generation, session_id = target['ref']['id'], target['generation'], target['sessionId']
    database = (data / 'agent-sessions' / 'execution-v2.sqlite').resolve()
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        public = json.loads(db.execute('SELECT body FROM execution_runs WHERE session=? AND id=?', (session_id, run_id)).fetchone()[0])
        session = json.loads(db.execute('SELECT body FROM execution_sessions WHERE id=?', (session_id,)).fetchone()[0])
        native = json.loads(db.execute('SELECT payload FROM native_attempts WHERE id=?', (run_id,)).fetchone()[0])
    assert public['snapshot']['ref'] == target['ref'] and public['snapshot']['generation'] == generation
    assert session['id'] == session_id and native['receipt']['runId'] == run_id
    root = data / 'native-processes' / run_id / generation
    manifest = json.loads((root / 'manifest.json').read_text())
    assert (manifest['runId'], manifest['generation']) == (run_id, generation)
    receipts = []
    for nonce in manifest['spawns']:
        recovered = root / (nonce+'.closed.json')
        receipt = json.loads((recovered if recovered.is_file() else root / (nonce+'.json')).read_text())
        assert (receipt['nonce'], receipt['runId'], receipt['generation']) == (nonce, run_id, generation)
        receipts.append({key: receipt.get(key) for key in ('nonce', 'state', 'treeStopped', 'writerPid', 'nativePid', 'mechanism')})
    return {'runId': run_id, 'generation': generation, 'sessionId': session_id,
        'nativeId': session.get('nativeId'), 'activeRun': (session['session'].get('activeRun') or {}).get('id'),
        'nativeGeneration': native['receipt']['generation'], 'nativeState': native['receipt']['state'],
        'effectIds': sorted((native['receipt'].get('effects') or {}).keys()),
        'eventCounts': dict(collections.Counter(frame['event']['type'] for frame in native['events'])),
        'producerNonce': manifest['producerNonce'], 'producerPid': manifest['producerPid'],
        'spawns': manifest['spawns'], 'receipts': receipts}


def assert_same_attempt(original, later):
    for key in ('runId', 'generation', 'sessionId', 'nativeId', 'nativeGeneration', 'producerNonce', 'spawns'):
        assert later[key] == original[key], 'A service restart changed ' + key
    for event in ('harness_session', 'execution_model', 'tool_use'):
        assert later['eventCounts'].get(event, 0) == original['eventCounts'].get(event, 0), 'The attempt replayed ' + event


def assert_closed(proof):
    assert proof['activeRun'] is None and proof['spawns']
    assert len(proof['receipts']) == len(proof['spawns'])
    assert all(receipt['state'] == 'stopped' and receipt['treeStopped'] is True for receipt in proof['receipts'])


def check(context, app, app_origin, call, timed, link, client):
    providers, wait, say = (context[key] for key in ('agentProviders', 'wait_for', 'say'))
    connection = providers.configure_for_harness(app_origin, call, 'codex',
        'Scripted public session recovery', secret='synthetic-public-session-fixture-only')
    assert connection['available'] and connection['kind'] == 'agent'
    assert {'session.resume', 'runs.retire'} <= set(connection['capabilities'])
    session = call(app_origin, '/api/sessions', {'title': 'Independent provider continuity', 'connectionId': connection['id']})
    route = '/api/sessions/'+session['id']
    def current(): return call(app_origin, route)
    def snapshot(): return (current().get('providerExecution') or {}).get('run') or {}
    def pending():
        state = snapshot()
        return state if state.get('pending') and not state.get('stopConfirmed') else None
    qualified = 'scope.workspace-writers' in connection['capabilities']
    gate_prompt = 'write' if qualified else 'question-blocking'
    gate_kind = 'approval' if qualified else 'question'
    gate_route = '/approvals/' if qualified else '/questions/'
    gate_event = 'approval_request' if qualified else 'question_request'
    gate_key = 'approvalId' if qualified else 'questionId'
    answer = {'decision': 'allow'} if qualified else {'answers': {'first': 'fixture choice', 'second': 'fixture answer'}}
    request = {'text': gate_prompt, 'clientRequestId': str(uuid.uuid4())}
    admitted = call(app_origin, route+'/messages', request)
    assert admitted['state'] == 'accepted'
    before = wait(pending, 90)
    run_id, provider_session = before['ref']['id'], before['sessionId']
    assert run_id != session['id'] and provider_session != session['id']
    assert before['ref']['provider'] == {key: connection['provider'][key] for key in ('appId', 'installationId', 'key')}
    provider = providers.entries['codex']
    pid_file = context['root']/'apps'/provider['appId']/'run/api.json'
    provider_pid = json.loads(pid_file.read_text())['pid']
    timed('restart')
    assert call(app_origin, route+'/credentials', {}) == {'updated': True}, 'Reattach with the original signed-in operator, as the conversation UI does'
    assert json.loads(pid_file.read_text())['pid'] == provider_pid, 'Restarting Harness must not restart its provider'
    resumed = wait(lambda: pending() if snapshot().get('ref', {}).get('id') == run_id else None, 90)
    assert resumed['sessionId'] == provider_session and resumed['generation'] == before['generation']
    assert call(app_origin, route+'/messages', request) == admitted, 'Consumer retry must retain the original receipt'
    assert snapshot()['ref']['id'] == run_id
    approval = next(item for item in resumed['pending'] if item['kind'] == gate_kind)
    card_id = 'agent-decision-' + json.dumps([run_id, approval['id']], separators=(',', ':'), ensure_ascii=False).encode().hex()
    # Harness cards are run-qualified; the provider's raw decision ID is not its API route ID.
    # Read the replayed public event so this check exercises the same card as the browser.
    with client.open(app_origin + route + '/events?after=0', timeout=30) as response:
        for raw in response:
            if not raw.startswith(b'data: '):
                continue
            envelope = json.loads(raw[6:])
            event = envelope.get('event', envelope)
            if event.get('type') == gate_event and event.get(gate_key) == card_id:
                break
        else:
            raise AssertionError('The exact run-qualified approval must survive consumer restart and SSE replay')
    call(app_origin, route+gate_route+card_id, answer)
    wait(lambda: execution_stopped(current()), 90)
    completed = snapshot()
    assert completed['ref']['id'] == run_id and completed['state'] == 'succeeded'
    assert completed['result']['status'] == 'succeeded'
    say('PASS: real Harness restart preserves provider PID, exact pending run, immutable input receipt and live decision completion')

    data = context['root'] / 'apps' / provider['appId'] / 'data'
    # Kill the HTTP service while the native agent is waiting for a decision. No operator
    # attestation enters the protocol. Stop after restart applies to the exact original attempt.
    call(app_origin, route+'/messages', {'text': gate_prompt, 'clientRequestId': str(uuid.uuid4())})
    crash = wait(pending, 90)
    before_crash = native_proof(data, crash)
    assert before_crash['spawns'] and before_crash['nativeId']
    harness_identity = context['harnessRuntimeIdentity']()
    try:
        providers.restart('codex')
    except Exception:
        runtime_log = context['root'] / 'apps' / provider['appId'] / 'logs' / 'api.log'
        if runtime_log.is_file():
            with runtime_log.open('rb') as stream:
                stream.seek(max(0, runtime_log.stat().st_size - 12000))
                tail = stream.read().decode('utf-8', errors='replace')
            say('Provider restart log: ' + context['sanitize_diagnostic'](tail))
        raise
    assert context['harnessRuntimeIdentity']() == harness_identity
    after_crash = native_proof(data, crash)
    assert_same_attempt(before_crash, after_crash)
    def after_restart():
        value = snapshot()
        if value.get('ref') != crash['ref'] or value.get('generation') != crash['generation']:
            return None
        return value if value.get('pending') or value.get('stopConfirmed') else None
    attached = wait(after_restart, 90)
    if not attached['stopConfirmed']:
        acknowledgement = call(app_origin, route+'/cancel', {})
        assert isinstance(acknowledgement.get('cancelled'), bool)
    def closed_target():
        value = snapshot()
        assert value.get('ref') == crash['ref'] and value.get('generation') == crash['generation']
        return value if value.get('stopConfirmed') else None
    try:
        stopped = wait(closed_target, 90)
    except Exception:
        latest = snapshot()
        say('Stop evidence: ' + json.dumps({'state':latest.get('state'),'phase':latest.get('phase'),
            'stopConfirmed':latest.get('stopConfirmed'),'private':native_proof(data,crash)}))
        raise
    assert stopped['ref'] == crash['ref'] and stopped['generation'] == crash['generation'] and stopped['pending'] == []
    assert stopped['state'] in ('cancelled', 'failed')
    closed = native_proof(data, stopped)
    assert_same_attempt(before_crash, closed)
    assert_closed(closed)
    obsolete_id = 'agent-decision-' + json.dumps([crash['ref']['id'], crash['pending'][0]['id']], separators=(',', ':')).encode().hex()
    try:
        call(app_origin, route + gate_route + obsolete_id, answer)
    except urllib.error.HTTPError as error:
        assert error.code == 409 and json.load(error)['code'] in ('approval_not_pending', 'question_not_pending', 'run_fenced', 'stale_decision')
    else:
        raise AssertionError('A physically closed attempt accepted its obsolete decision.')
    call(app_origin, route+'/messages', {'text': 'hello', 'clientRequestId': str(uuid.uuid4())})
    def completed_turn():
        value = snapshot()
        return value if value.get('ref', {}).get('id') != crash['ref']['id'] and value.get('stopConfirmed') else None
    continued = wait(completed_turn, 90)
    assert continued['state'] == 'succeeded' and continued['sessionId'] == provider_session
    assert native_proof(data, continued)['nativeId'] == before_crash['nativeId']
    say('PASS: provider restart and Stop close the original native tree, reject its obsolete decision, and preserve the next chat turn.')

    fresh = call(app_origin, '/api/sessions', {'title': 'Independent stopped-effect conversation', 'connectionId': connection['id'], 'profileId': None})
    fresh_route = '/api/sessions/'+fresh['id']
    call(app_origin, fresh_route+'/messages', {'text': 'completed-with-unknown-search', 'clientRequestId': str(uuid.uuid4())})
    def incomplete_result():
        value = (call(app_origin, fresh_route).get('providerExecution') or {}).get('run') or {}
        return value if value.get('stopConfirmed') and value.get('effects', {}).get('unresolvedCallIds') else None
    partial = wait(incomplete_result, 90)
    assert partial['state'] == 'succeeded' and partial['effects']['certainty'] == 'unknown'
    proof = native_proof(data, partial)
    assert_closed(proof)
    assert len(proof['effectIds']) == len(partial['effects']['unresolvedCallIds']) == 1
    call(app_origin, fresh_route+'/messages', {'text': 'hello', 'clientRequestId': str(uuid.uuid4())})
    def resumed_partial():
        value = (call(app_origin, fresh_route).get('providerExecution') or {}).get('run') or {}
        return value if value.get('ref', {}).get('id') != partial['ref']['id'] and value.get('stopConfirmed') else None
    resumed = wait(resumed_partial, 90)
    assert resumed['state'] == 'succeeded' and resumed['sessionId'] == partial['sessionId']
    say('PASS: an unanswered tool outcome remains recorded on the original attempt and does not reserve the session.')

    disposable = call(app_origin, '/api/sessions', {'title': 'Owner-selected deletion', 'connectionId': connection['id'], 'profileId': None})
    delete_route = '/api/sessions/'+disposable['id']
    tree = call(app_origin, delete_route+'/workspaces', {'action': 'prepare', 'requestId': str(uuid.uuid4()),
        'appId': app, 'targetBranch': 'main', 'name': 'Retain source during stopped session deletion'})
    workspace_route = '/api/development-workspaces/'+tree['workspaceId']
    participants = call(app_origin, workspace_route+'/participants')
    call(app_origin, delete_route+'/workspaces', {'action': 'attach', 'requestId': str(uuid.uuid4()),
        'workspaceId': tree['workspaceId'], 'expectedRevision': participants['revision']})
    worktree_route = workspace_route+'/worktrees/'+tree['id']
    original_leases = set(call(app_origin, worktree_route)['leases'])
    tree_path = Path(tree['path']).resolve()
    assert tree_path.is_relative_to(context['root'].resolve())
    dirty_file = tree_path/'retirement-fixture.txt'
    dirty_file.write_text('Preserve this uncommitted work.')
    if 'scope.workspace-writers' in connection['capabilities']:
        call(app_origin, delete_route+'/messages', {'text': gate_prompt, 'clientRequestId': str(uuid.uuid4())})
        def waiting_writer():
            value = (call(app_origin, delete_route).get('providerExecution') or {}).get('run') or {}
            return value if value.get('pending') and not value.get('stopConfirmed') else None
        writer = wait(waiting_writer, 90)
        assert original_leases < set(call(app_origin, worktree_route)['leases'])
    else:
        writer = None
        say('The host offers no verified workspace writer scope. Resource-free attempts and source retention run on this profile.')
    delete = urllib.request.Request(app_origin+delete_route, headers={'Origin': app_origin}, method='DELETE')
    with client.open(delete, timeout=60) as response:
        result = json.load(response)
        assert response.status in (200, 202) and result['deleted'] and result['requestId']
    wait(lambda: call(app_origin, delete_route+'/deletion').get('state') == 'removed', 90)
    if writer:
        assert_closed(native_proof(data, writer))
    assert dirty_file.read_text() == 'Preserve this uncommitted work.'
    assert set(call(app_origin, worktree_route)['leases']) == original_leases
    assert not any(item['sessionId'] == disposable['id'] and item['attached'] for item in call(app_origin, workspace_route+'/participants')['sessions'])
    assert call(app_origin, route)['id'] == session['id']
    say('PASS: confirmed session deletion completes cleanup while preserving separately owned workspace files and the sibling conversation.')
    return {'before': before_crash, 'after': after_crash, 'quiescentStopped': closed, 'quiescentResumed': resumed,
        'completedChatId': fresh['id'], 'otherChatId': session['id'], 'retainedTree': tree}

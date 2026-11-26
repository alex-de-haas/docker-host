"""Exercise the v2 provider through a real Core Local installation and its signed-in Harness consumer."""
import collections
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import sys
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
    stop_time = next((event['occurredAt'] for event in public['events']
        if event['type'] == 'run.updated' and event['data']['snapshot']['phase'] == 'terminal'
        and event['data']['snapshot']['stopConfirmed']), None)
    return {'runId': run_id, 'generation': generation, 'sessionId': session_id,
        'nativeId': session.get('nativeId'), 'activeRun': (session['session'].get('activeRun') or {}).get('id'),
        'nativeGeneration': native['receipt']['generation'], 'nativeState': native['receipt']['state'],
        'effectIds': sorted((native['receipt'].get('effects') or {}).keys()),
        'eventCounts': dict(collections.Counter(frame['event']['type'] for frame in native['events'])),
        'stopConfirmedAt': stop_time, **native_process_receipts(data, target)}


def native_process_receipts(data, target):
    """Read the exact runner scope and OS receipts independently of the removable chat payload."""
    run_id, generation = target['ref']['id'], target['generation']
    root = data / 'native-processes' / run_id / generation
    manifest = json.loads((root / 'manifest.json').read_text())
    assert (manifest['runId'], manifest['generation']) == (run_id, generation)
    receipts = []
    for nonce in manifest['spawns']:
        recovered = root / (nonce+'.closed.json')
        receipt = json.loads((recovered if recovered.is_file() else root / (nonce+'.json')).read_text())
        assert (receipt['nonce'], receipt['runId'], receipt['generation']) == (nonce, run_id, generation)
        receipts.append({key: receipt.get(key) for key in
            ('nonce', 'state', 'treeStopped', 'writerPid', 'nativePid', 'mechanism', 'observedAt')})
    return {'producerNonce': manifest['producerNonce'], 'producerPid': manifest['producerPid'],
        'spawns': manifest['spawns'], 'receipts': receipts}


def assert_same_attempt(original, later):
    for key in ('runId', 'generation', 'sessionId', 'nativeId', 'nativeGeneration', 'producerNonce', 'spawns'):
        assert later[key] == original[key], 'A service restart changed ' + key
    for event in ('harness_session', 'execution_model', 'tool_use'):
        assert later['eventCounts'].get(event, 0) == original['eventCounts'].get(event, 0), 'The attempt replayed ' + event


def physically_closed(data, target):
    proof = native_proof(data, target)
    if proof['activeRun'] is None and groups_closed(proof):
        return proof
    return None


def groups_closed(proof):
    return bool(proof['spawns']) and len(proof['receipts']) == len(proof['spawns']) and all(
        receipt['state'] == 'stopped' and receipt['treeStopped'] is True for receipt in proof['receipts'])


def check_mac_workspace_continuation(context, app, app_origin, call, client, connection):
    if sys.platform != 'darwin' or context.get('scenario') != 'agent-providers':
        return
    wait, say = context['wait_for'], context['say']
    capabilities = set(connection['capabilities'])
    assert 'workspace.edit' in capabilities and 'scope.workspace-writers' not in capabilities

    chat = call(app_origin, '/api/sessions',
        {'title': 'Ordinary macOS worktree editing', 'connectionId': connection['id'], 'profileId': None})
    route = '/api/sessions/' + chat['id']
    tree = call(app_origin, route + '/workspaces', {'action': 'prepare', 'requestId': str(uuid.uuid4()),
        'appId': app, 'targetBranch': 'main', 'name': 'Edit and continue an ordinary Mac chat'})
    workspace = '/api/development-workspaces/' + tree['workspaceId']
    participants = call(app_origin, workspace + '/participants')
    call(app_origin, route + '/workspaces', {'action': 'attach', 'requestId': str(uuid.uuid4()),
        'workspaceId': tree['workspaceId'], 'expectedRevision': participants['revision']})
    source = Path(tree['path']).resolve()
    assert source.is_relative_to(context['root'].resolve()), 'The edit must target the disposable Core worktree'
    marker = uuid.uuid4().hex
    edited = source / ('workspace-edit-' + marker + '.txt')
    heartbeat = edited.with_name(edited.name + '.heartbeat')
    data = context['root'] / 'apps' / context['agentProviders'].entries['codex']['appId'] / 'data'
    queue_route = route + '/message-queue'

    def enqueue(phase):
        queue = call(app_origin, queue_route)
        assert not queue['entries']
        if queue['paused']:
            call(app_origin, queue_route + '/commands', {'requestId': str(uuid.uuid4()),
                'expectedRevision': queue['revision'], 'command': {'type': 'resume'}})
            queue = call(app_origin, queue_route)
        entry_id = str(uuid.uuid4())
        queued = call(app_origin, queue_route + '/commands', {'requestId': str(uuid.uuid4()),
            'expectedRevision': queue['revision'], 'command': {'type': 'enqueue', 'entryId': entry_id,
                'text': f'MAC_WORKSPACE_EDIT:{marker}:{phase}', 'attachments': []}})
        assert queued['queue']['entries'][0]['id'] == entry_id
        return entry_id

    def observation(entry_id):
        entry = next((row for row in call(app_origin, queue_route)['entries'] if row['id'] == entry_id), None)
        if entry:
            assert entry['state'] not in ('unknown', 'failed'), ('Ordinary chat admission failed', (entry.get('error') or {}).get('code'))
            return None, {}
        current = call(app_origin, route)
        assert current.get('agentProfile') is None, 'The native execution must not require a profile'
        return current, (current.get('providerExecution') or {}).get('run') or {}

    first_entry = enqueue('initial')
    def running_edit():
        _, run = observation(first_entry)
        return run if run.get('state') == 'running' and run.get('effects', {}).get('unresolvedCallIds') and heartbeat.is_file() else None
    first = wait(running_edit, 90)
    assert edited.read_text() == 'Initial edit\n'
    requested = call(app_origin, route + '/cancel', {})
    assert isinstance(requested.get('cancelled'), bool)

    def cancelled():
        current, run = observation(first_entry)
        if not current or current['status'] != 'cancelled':
            return None
        assert run['ref'] == first['ref'] and run['generation'] == first['generation']
        assert run['stopConfirmed'] and not current.get('stopUnconfirmed')
        assert run['effects']['unresolvedCallIds'] == first['effects']['unresolvedCallIds']
        return run
    stopped = wait(cancelled, 90)

    second_entry = enqueue('follow-up')
    def continued():
        current, run = observation(second_entry)
        if not current or run.get('ref') == first['ref'] or current['status'] != 'idle' or not run.get('stopConfirmed'):
            return None
        assert run['state'] == 'succeeded' and run['sessionId'] == stopped['sessionId']
        return run
    wait(continued, 90)
    proof = wait(lambda: physically_closed(data, stopped), 90)
    # HTTP and background cleanup can finish between observations. Compare the committed
    # public terminal event with writes by the descendant and closure of its actual group.
    beats = [tuple(map(int, line.split())) for line in heartbeat.read_text().splitlines()]
    app_server_pid, last_write = beats[-1]
    receipt = next(item for item in proof['receipts'] if item['nativePid'] == app_server_pid)
    stop_time = datetime.fromisoformat(proof['stopConfirmedAt']).timestamp()
    group_closed = datetime.fromisoformat(receipt['observedAt']).timestamp()
    assert stop_time < last_write / 1000 <= group_closed, (
        'Expected an owned descendant to write after public Stop and before group closure',
        {'stop': proof['stopConfirmedAt'], 'lastWriteMs': last_write, 'groupClosed': receipt['observedAt']})
    assert edited.read_text() == 'Initial edit\nFollow-up edit\n'

    # Chat removal is logical. It must not erase the independently selected source tree.
    with client.open(urllib.request.Request(app_origin + route, headers={'Origin': app_origin}, method='DELETE'), timeout=60) as response:
        assert response.status in (200, 202) and json.load(response)['deleted']
    assert all(item['id'] != chat['id'] for item in call(app_origin, '/api/sessions')['sessions'])
    assert edited.read_text() == 'Initial edit\nFollow-up edit\n'
    say('PASS: native macOS edited the selected worktree without a profile, confirmed Stop before an owned descendant stopped writing, cleaned up its group, and accepted another edit in the same chat')


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
    workspace_edit = bool({'workspace.edit', 'scope.workspace-writers'}.intersection(connection['capabilities']))
    gate_prompt = 'write' if workspace_edit else 'question-blocking'
    gate_kind = 'approval' if workspace_edit else 'question'
    gate_route = '/approvals/' if workspace_edit else '/questions/'
    gate_event = 'approval_request' if workspace_edit else 'question_request'
    gate_key = 'approvalId' if workspace_edit else 'questionId'
    answer = {'decision': 'allow'} if workspace_edit else {'answers': {'first': 'fixture choice', 'second': 'fixture answer'}}
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

    check_mac_workspace_continuation(context, app, app_origin, call, client, connection)

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
    closed = wait(lambda: physically_closed(data, stopped), 90)
    assert_same_attempt(before_crash, closed)
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
    proof = wait(lambda: physically_closed(data, partial), 90)
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
    if workspace_edit:
        call(app_origin, delete_route+'/messages', {'text': gate_prompt, 'clientRequestId': str(uuid.uuid4())})
        def waiting_writer():
            value = (call(app_origin, delete_route).get('providerExecution') or {}).get('run') or {}
            return value if value.get('pending') and not value.get('stopConfirmed') else None
        writer = wait(waiting_writer, 90)
        writer_scope = native_process_receipts(data, writer)
        assert writer_scope['spawns']
        assert original_leases < set(call(app_origin, worktree_route)['leases'])
    else:
        writer = None
        say('The provider offers no workspace editing on this host. The resource-free attempt and source retention checks still run.')
    delete = urllib.request.Request(app_origin+delete_route, headers={'Origin': app_origin}, method='DELETE')
    with client.open(delete, timeout=60) as response:
        result = json.load(response)
        assert response.status in (200, 202) and result['deleted'] and result['requestId']
    wait(lambda: call(app_origin, delete_route+'/deletion').get('state') == 'removed', 90)
    if writer:
        def writer_groups_closed():
            proof = native_process_receipts(data, writer)
            assert proof['producerNonce'] == writer_scope['producerNonce']
            assert set(writer_scope['spawns']) <= set(proof['spawns'])
            return groups_closed(proof)
        wait(writer_groups_closed, 90)
    assert dirty_file.read_text() == 'Preserve this uncommitted work.'
    wait(lambda: set(call(app_origin, worktree_route)['leases']) == original_leases, 90)
    assert not any(item['sessionId'] == disposable['id'] and item['attached'] for item in call(app_origin, workspace_route+'/participants')['sessions'])
    assert call(app_origin, route)['id'] == session['id']
    say('PASS: confirmed session deletion completes cleanup while preserving separately owned workspace files and the sibling conversation.')
    return {'before': before_crash, 'after': after_crash, 'quiescentStopped': closed, 'quiescentResumed': resumed,
        'completedChatId': fresh['id'], 'otherChatId': session['id'], 'retainedTree': tree}

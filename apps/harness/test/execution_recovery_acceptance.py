"""Public provider continuity, crash fencing and quiescent updates in an isolated child.

Only the app-owned synthetic Codex CLI is selected. Active Core Local restart is a
hard-stop/crash, not a graceful SDK shutdown. Private evidence is observed only;
no journal is seeded and no client assertion replaces provider-owned stop proof.
"""
import collections
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid

from agent_provider_acceptance import execution_stopped


def _owns_exit(proof):
    manifest = proof.get('manifest') or {}
    processes = proof.get('processes') or []
    return (manifest.get('sdkStopConfirmed') is True and manifest.get('sealed') is True
        and bool(manifest.get('spawns')) and len(processes) == len(manifest['spawns'])
        and all(item.get('state') == 'stopped' and item.get('treeStopped') is True for item in processes))


def _assert_private_crash_rejection(status, code, proof, target):
    assert proof['runId'] == target['ref']['id'] and proof['generation'] == target['generation']
    assert proof['sessionId'] == target['sessionId']
    assert proof['providerSession']['activeRun'] == target['ref']['id'], 'A crash fence must retain the exact provider session reservation'
    if (status, code) == (409, 'effects_unconfirmed'):
        assert proof['receipt']['effectIds'], 'HTTP409 effects_unconfirmed requires retained private unresolved effects'
    elif (status, code) == (503, 'exit_unconfirmed'):
        assert not _owns_exit(proof), 'HTTP503 exit_unconfirmed requires missing provider-owned SDK/process-tree proof'
    else:
        raise AssertionError('Crash recovery must reject with an evidence-backed guard; got '+str(status)+' '+str(code))


def _assert_crash_rejection(status, code, proof, state, target):
    _assert_private_crash_rejection(status, code, proof, target)
    assert state['ref'] == target['ref'] and state['generation'] == target['generation']
    assert state['sessionId'] == target['sessionId']
    assert state['state'] == 'unknown' and state['stopConfirmed'] is False
    if (status, code) == (409, 'effects_unconfirmed'):
        # NativeExecution checks effects before owned-stop receipts. Both exact-run
        # views must confirm uncertainty; a status alone is never evidence.
        assert state['effects']['unresolvedCallIds'], 'HTTP409 effects_unconfirmed requires retained public unresolved effects'


def _wait_crash_projection(read, target, minimum_revision, wait, say):
    observed = {}
    def ready():
        nonlocal observed
        state = read()
        observed = {key: state.get(key) for key in ('ref', 'sessionId', 'generation', 'revision', 'lastSequence', 'state', 'phase', 'freshness', 'stopConfirmed')}
        observed['unresolvedEffects'] = len((state.get('effects') or {}).get('unresolvedCallIds') or [])
        assert state['ref'] == target['ref'] and state['generation'] == target['generation']
        assert state['sessionId'] == target['sessionId']
        assert state['stopConfirmed'] is False, 'A crashed run without owned proof must remain reserved during reattachment'
        assert isinstance(state['revision'], str) and state['revision'].isascii() and state['revision'].isdecimal()
        return state if state['state'] == 'unknown' and int(state['revision']) >= int(minimum_revision) else None
    try:
        return wait(ready, 30)
    finally:
        # Bound diagnostics to state/identity metadata; never log messages, inputs or credentials.
        say('Crash public projection: '+json.dumps({'minimumRevision': minimum_revision, 'observed': observed}))



@contextmanager
def _deny_windows_replacement(path):
    """Keep exact aggregate reads available while denying its atomic replacement."""
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL
    # GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING.
    handle = create(str(path), 0x80000000, 0x3, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        close(handle)


def _check_windows_aggregate_replacement(context, app_origin, call, client, connection):
    providers, wait, say = (context[key] for key in ('agentProviders', 'wait_for', 'say'))
    provider_data = context['root']/'apps'/providers.entries['codex']['appId']/'data'
    aggregates = provider_data/'agent-sessions'
    assert aggregates.resolve().is_relative_to(context['root'].resolve())
    old = call(app_origin, '/api/sessions', {'title': 'Windows aggregate replacement failure',
        'connectionId': connection['id'], 'profileId': None})
    old_route = '/api/sessions/'+old['id']
    new = call(app_origin, '/api/sessions', {'title': 'Independent admission with an attachment',
        'connectionId': connection['id'], 'profileId': None})
    new_route = '/api/sessions/'+new['id']

    def snapshot(route):
        return (call(app_origin, route).get('providerExecution') or {}).get('run') or {}

    def pending(route):
        state = snapshot(route)
        return state if any(item['kind'] == 'approval' for item in state.get('pending', [])) and not state['stopConfirmed'] else None

    def send(route, attachments=()):
        result = call(app_origin, route+'/messages', {'text': 'write', 'clientRequestId': str(uuid.uuid4()),
            'attachments': list(attachments)})
        assert result['state'] == 'accepted'

    files = b'First message attachment from the isolated Windows fixture.'
    upload = urllib.request.Request(app_origin + new_route + '/attachments/replacement-fixture.txt',
        data=files, method='PUT', headers={'Origin': app_origin, 'Content-Type': 'application/octet-stream'})
    with client.open(upload, timeout=30) as response:
        assert response.status == 201
        attachment = json.load(response)['attachment']['name']

    send(old_route)
    original = wait(lambda: pending(old_route), 90)
    run_id = original['ref']['id']
    aggregate = aggregates/(original['sessionId']+'.json')
    approval_id = next(item['id'] for item in original['pending'] if item['kind'] == 'approval')

    def linked_approval():
        retained = json.loads(aggregate.read_bytes())
        return retained['runs'][run_id].get('decisionLinks', {}).get(approval_id)

    # Let the decision mirror finish its aggregate write before Stop is fault-injected.
    wait(linked_approval, 90)
    with _deny_windows_replacement(aggregate):
        original_bytes = aggregate.read_bytes()
        retained = json.loads(original_bytes)
        assert retained['session']['activeRun']['id'] == run_id
        control_ids = set(retained['runs'][run_id]['controls'])
        temp_pattern = aggregate.name+'.*.tmp'
        earlier_temps = set(aggregates.glob(temp_pattern))
        try:
            call(app_origin, old_route+'/cancel', {})
        except urllib.error.HTTPError as error:
            assert (error.code, json.load(error).get('code')) == (503, 'storage_uncertain')
        else:
            raise AssertionError('Stop must report unconfirmed storage when Windows denies replacing its aggregate')
        attempted, = set(aggregates.glob(temp_pattern)) - earlier_temps
        command_id, = set(json.loads(attempted.read_text(encoding='utf-8'))['runs'][run_id]['controls']) - control_ids

        send(new_route, (attachment,))
        independent = wait(lambda: pending(new_route), 90)
        assert independent['sessionId'] != original['sessionId'] and independent['ref']['id'] != run_id
        assert call(app_origin, new_route+'/cancel', {}) == {'cancelled': True}
        finished = wait(lambda: state if (state := snapshot(new_route)).get('stopConfirmed') else None, 90)
        assert finished['ref'] == independent['ref'] and finished['state'] == 'cancelled'
        committed = json.loads((aggregates/(independent['sessionId']+'.json')).read_text(encoding='utf-8'))
        provider_file, = committed['runs'][independent['ref']['id']]['input']['input']['attachments']
        assert provider_file['name'] == attachment and provider_file['sizeBytes'] == len(files)
        assert provider_file['digest'] == hashlib.sha256(files).hexdigest()

        # The exact prior commit proves that the attempted Stop was never admitted. The status
        # read can reopen the session from that evidence, without publishing the failed write.
        review = call(app_origin, old_route+'/execution-recovery')
        assert review is None or (review['runId'] == run_id and not review['recoverable'])
        current = snapshot(old_route)
        assert current['ref'] == original['ref'] and current['generation'] == original['generation']
        assert current['stopConfirmed'] is False
        assert aggregate.read_bytes() == original_bytes, 'A status read must not retry Stop or publish its temporary file'
        assert set(aggregates.glob(temp_pattern)) == earlier_temps | {attempted}

    assert call(app_origin, old_route+'/cancel', {}) == {'cancelled': True}
    stopped = wait(lambda: state if (state := snapshot(old_route)).get('stopConfirmed') else None, 90)
    assert stopped['ref'] == original['ref'] and stopped['state'] == 'cancelled'
    committed = json.loads(aggregate.read_text(encoding='utf-8'))
    assert set(committed['runs'][run_id]['controls']) - control_ids == {command_id}
    assert committed['session'].get('activeRun') is None
    say('PASS: Windows denied one provider aggregate replacement while another chat accepted a file, streamed and stopped. '
        'Checking status never replayed Stop. After unlock, the original Stop reached the provider exactly once.')

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
    request = {'text': 'write', 'clientRequestId': str(uuid.uuid4())}
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
    approval = next(item for item in resumed['pending'] if item['kind'] == 'approval')
    card_id = 'agent-decision-' + json.dumps([run_id, approval['id']], separators=(',', ':'), ensure_ascii=False).encode().hex()
    # Harness cards are run-qualified; the provider's raw decision ID is not its API route ID.
    # Read the replayed public event so this check exercises the same card as the browser.
    with client.open(app_origin + route + '/events?after=0', timeout=30) as response:
        for raw in response:
            if not raw.startswith(b'data: '):
                continue
            envelope = json.loads(raw[6:])
            event = envelope.get('event', envelope)
            if event.get('type') == 'approval_request' and event.get('approvalId') == card_id:
                break
        else:
            raise AssertionError('The exact run-qualified approval must survive consumer restart and SSE replay')
    call(app_origin, route+'/approvals/'+card_id, {'decision': 'allow'})
    wait(lambda: execution_stopped(current()), 90)
    completed = snapshot()
    assert completed['ref']['id'] == run_id and completed['state'] == 'succeeded'
    assert completed['result']['status'] == 'succeeded'
    say('PASS: real Harness restart preserves provider PID, exact pending run, immutable input receipt and live approval completion')

    # The provider restarts independently with its own durable public session/native binding.
    harness_identity = context['harnessRuntimeIdentity']()
    providers.restart('codex')
    assert context['harnessRuntimeIdentity']() == harness_identity
    call(app_origin, route+'/messages', {'text': 'hello', 'clientRequestId': str(uuid.uuid4())})
    next_run = wait(lambda: snapshot() if snapshot().get('ref', {}).get('id') != run_id else None, 90)
    assert next_run['sessionId'] == provider_session
    wait(lambda: execution_stopped(current()), 90)
    assert snapshot()['state'] == 'succeeded'
    say('PASS: independent provider restart preserves the public session and resumes through a fresh authorized run')

    # Core's normal Local Stop hard-kills its owned app group. An active restart
    # therefore exercises crash uncertainty; supported updates first quiesce runs.
    call(app_origin, route+'/messages', {'text': 'write', 'clientRequestId': str(uuid.uuid4())})
    interrupted = wait(pending, 90)
    def native_proof(stage, target=None):
        target = target or interrupted
        data = context['root']/'apps'/provider['appId']/'data'
        evidence = {'stage': stage, 'runId': target['ref']['id'], 'generation': target['generation'], 'sessionId': target['sessionId']}
        journal = data/'execution-journal'/(target['ref']['id']+'.json')
        if journal.exists():
            stored = json.loads(journal.read_text())
            receipt = stored['receipt']
            assert receipt['runId'] == target['ref']['id'], 'Native receipt must belong to the exact public run'
            evidence['receipt'] = {key: receipt.get(key) for key in ('state', 'exitConfirmed', 'revision', 'updatedAt', 'generation')}
            evidence['receipt']['effectIds'] = sorted((receipt.get('effects') or {}).keys())
            evidence['eventCounts'] = dict(collections.Counter(frame.get('event', {}).get('type') for frame in stored['events']))
            evidence['lastEvents'] = [{'type': frame.get('event', {}).get('type'), 'state': frame.get('event', {}).get('state')}
                for frame in stored['events'][-8:]]
        retained_file = data/'agent-sessions'/(target['sessionId']+'.json')
        if retained_file.exists():
            retained = json.loads(retained_file.read_text())
            assert retained['id'] == target['sessionId']
            evidence['providerSession'] = {'nativeId': retained.get('nativeId'),
                'activeRun': (retained['session'].get('activeRun') or {}).get('id'), 'runIds': sorted(retained['runs'])}
        native = data/'native-processes'/target['ref']['id']/target['generation']
        manifest_file = native/'manifest.json'
        if manifest_file.exists():
            manifest = json.loads(manifest_file.read_text())
            assert manifest.get('version') == 1 and manifest.get('runId') == target['ref']['id'] and manifest.get('generation') == target['generation']
            evidence['manifest'] = {key: manifest.get(key) for key in ('sealed', 'sdkStopConfirmed', 'producerPid', 'spawns')}
            evidence['processes'] = []
            for nonce in manifest.get('spawns', []):
                child = native/(nonce+'.json')
                if child.exists():
                    value = json.loads(child.read_text())
                    assert value.get('nonce') == nonce and value.get('runId') == target['ref']['id'] and value.get('generation') == target['generation']
                    evidence['processes'].append({key: value.get(key) for key in ('state', 'treeStopped', 'outputDrained', 'writerPid', 'groupPid', 'nativePid')})
        (context['base']/('provider-restart-'+stage+'.json')).write_text(json.dumps(evidence))
        say('Provider restart evidence: '+json.dumps(evidence))
        return evidence

    def no_replay(original, later):
        assert later['runId'] == original['runId'] and later['generation'] == original['generation']
        assert later['sessionId'] == original['sessionId']
        assert later['manifest']['spawns'] == original['manifest']['spawns'], 'A retained run must not start another native process'
        assert later['manifest']['producerPid'] == original['manifest']['producerPid']
        assert later['providerSession']['runIds'] == original['providerSession']['runIds'], 'Recovery must not create a replacement public run'
        assert later['providerSession']['nativeId'] == original['providerSession']['nativeId']
        assert later['receipt']['generation'] == original['receipt']['generation']
        for event in ('harness_session', 'execution_model', 'tool_use'):
            assert later['eventCounts'].get(event, 0) == original['eventCounts'].get(event, 0), 'Recovery must not replay native input or tools'

    before_crash = native_proof('before')
    assert before_crash.get('manifest', {}).get('spawns') and before_crash.get('providerSession', {}).get('nativeId')
    providers.restart('codex')
    after_crash = native_proof('after')
    no_replay(before_crash, after_crash)
    review_route = route+'/execution-recovery'
    def stopped_or_recoverable():
        state = current()
        if execution_stopped(state): return {'stopped': True}
        review = call(app_origin, review_route)
        return review if review and review.get('recoverable') else None
    review = wait(stopped_or_recoverable, 90)
    effects_remain = bool(after_crash['receipt']['effectIds'] or snapshot().get('effects', {}).get('unresolvedCallIds'))
    proof_permits_recovery = _owns_exit(after_crash) and not effects_remain
    recovery = None
    if review.get('stopped'):
        assert proof_permits_recovery, 'Process disappearance without SDK/effect proof must never release the retained execution'
    else:
        assert review['runId'] == interrupted['ref']['id'] and review['generation'] == interrupted['generation']
        recovery = {'requestId': str(uuid.uuid4()), 'runId': review['runId'],
            'generation': review['generation'], 'expectedRevision': review['expectedRevision'], 'consumerExitConfirmed': True}

    rejected_guards = []
    def recover_with_original_command():
        assert recovery, 'Only the originally reviewed recovery command may be repeated'
        if proof_permits_recovery:
            assert call(app_origin, review_route, recovery) == {'recovered': True}
            return
        # The first guard may be effects or owned exit, depending on retained state.
        # Each exact error needs current evidence; neither permits arbitrary 409/503.
        try:
            call(app_origin, review_route, recovery)
        except urllib.error.HTTPError as error:
            payload = json.load(error)
            code = payload.get('code') or (payload.get('error') or {}).get('code')
            proof = native_proof('recovery-rejected-'+str(len(rejected_guards)+1))
            no_replay(before_crash, proof)
            _assert_private_crash_rejection(error.code, code, proof, interrupted)
            rejected_guards.append((error.code, code, proof))
        else:
            raise AssertionError('A crashed run without exact provider-owned proof must remain fenced')

    if recovery:
        recover_with_original_command()
        recover_with_original_command()
    if proof_permits_recovery:
        wait(lambda: execution_stopped(current()), 90)
    else:
        assert after_crash['providerSession']['activeRun'] == interrupted['ref']['id'], 'An unproved run must retain its provider session reservation'
    rejected = native_proof('after-recovery-review')
    no_replay(before_crash, rejected)
    timed('restart')
    assert call(app_origin, route+'/credentials', {}) == {'updated': True}, 'Reconnect using the original operator after consumer restart'
    if recovery:
        recover_with_original_command()
    if not proof_permits_recovery:
        # Recovery GET reads the provider without projecting it into Harness. An
        # observer whose old connection ended can retain a pre-crash UI snapshot.
        # The already planned consumer restart/credentials reattaches that observer;
        # require its fresh exact-run projection before validating every rejection.
        fresh = _wait_crash_projection(snapshot, interrupted, review['expectedRevision'], wait, say)
        assert rejected_guards, 'The crash must actually exercise its public recovery fence'
        for status, code, proof in rejected_guards:
            _assert_crash_rejection(status, code, proof, fresh, interrupted)
    assert snapshot()['ref']['id'] == interrupted['ref']['id'] and snapshot()['sessionId'] == provider_session
    assert snapshot()['generation'] == interrupted['generation']
    after_consumer = native_proof('after-consumer-restart')
    no_replay(before_crash, after_consumer)
    if proof_permits_recovery:
        assert execution_stopped(current())
        say('PASS: retained provider-owned SDK/tree/effect proof permits immutable reconciliation without native replay')
    else:
        assert snapshot()['state'] == 'unknown' and not execution_stopped(current())
        assert after_consumer['providerSession']['activeRun'] == interrupted['ref']['id']
        guards = sorted({'HTTP'+str(status)+' '+code for status, code, _ in rejected_guards})
        say('PASS: active Local restart is a crash; exact missing SDK/effect proof keeps the original run reserved across consumer restart ('+', '.join(guards)+')')

    # Supported provider update: the operator cancels through the public consumer API
    # and observes authoritative stop BEFORE Core hard-stops the idle provider.
    fresh = call(app_origin, '/api/sessions', {'title': 'Quiescent provider update', 'connectionId': connection['id'], 'profileId': None})
    fresh_route = '/api/sessions/'+fresh['id']
    def fresh_current(): return call(app_origin, fresh_route)
    def fresh_snapshot(): return (fresh_current().get('providerExecution') or {}).get('run') or {}
    def fresh_pending():
        value = fresh_snapshot()
        return value if value.get('pending') and not value.get('stopConfirmed') else None
    call(app_origin, fresh_route+'/messages', {'text': 'write', 'clientRequestId': str(uuid.uuid4())})
    cancel_target = wait(fresh_pending, 90)
    assert cancel_target['sessionId'] != provider_session
    before_cancel = native_proof('quiescent-before-cancel', cancel_target)
    assert call(app_origin, fresh_route+'/cancel', {}) == {'cancelled': True}
    wait(lambda: execution_stopped(fresh_current()), 90)
    cancelled = fresh_snapshot()
    assert cancelled['ref']['id'] == cancel_target['ref']['id'] and cancelled['generation'] == cancel_target['generation']
    assert cancelled['state'] == 'cancelled' and cancelled['effects']['certainty'] == 'known' and not cancelled['effects']['unresolvedCallIds']
    cancelled_proof = native_proof('quiescent-stopped', cancelled)
    assert _owns_exit(cancelled_proof) and not cancelled_proof['receipt']['effectIds']
    assert cancelled_proof['receipt']['exitConfirmed'] is True and cancelled_proof['providerSession']['activeRun'] is None
    harness_identity = context['harnessRuntimeIdentity']()
    providers.restart('codex')
    assert context['harnessRuntimeIdentity']() == harness_identity
    updated_proof = native_proof('quiescent-after-provider-restart', cancelled)
    no_replay(cancelled_proof, updated_proof)
    call(app_origin, fresh_route+'/messages', {'text': 'hello', 'clientRequestId': str(uuid.uuid4())})
    def fresh_resumed():
        value = fresh_snapshot()
        return value if value.get('ref', {}).get('id') != cancelled['ref']['id'] else None
    continued = wait(fresh_resumed, 90)
    assert continued['sessionId'] == cancel_target['sessionId']
    wait(lambda: execution_stopped(fresh_current()), 90)
    assert fresh_snapshot()['state'] == 'succeeded'
    resumed_proof = native_proof('quiescent-resumed', fresh_snapshot())
    assert resumed_proof['providerSession']['nativeId'] == before_cancel['providerSession']['nativeId'], 'A quiescent update must preserve the exact native context'
    assert resumed_proof['providerSession']['activeRun'] is None
    no_replay(before_crash, native_proof('abrupt-run-after-quiescent-update'))
    if not proof_permits_recovery:
        assert not execution_stopped(current()) and snapshot()['ref']['id'] == interrupted['ref']['id']
    data = context['root']/'apps'/app/'data'
    events = [json.loads(line) for line in (data/'sessions'/session['id']/'events.ndjson').read_text().splitlines() if line.strip()]
    assert sum(event.get('type') == 'user_message' and event.get('text') == 'hello' for event in events) == 1
    assert sum(event.get('type') == 'user_message' and event.get('text') == 'write' for event in events) == 2
    assert not (data/'worker-service').exists(), 'The consumer must not create a private native execution journal'
    say('PASS: public Cancel proves SDK/tree/effect stop before provider update, and the same public/native session resumes afterward')
    # Reproduce the retained terminal shape using a real child process and provider
    # journal, including the missing tool outcome. Restart before using owner Delete.
    disposable = call(app_origin, '/api/sessions', {'title': 'Stopped turn with an unknown search outcome',
        'connectionId': connection['id'], 'profileId': None})
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
    call(app_origin, delete_route+'/messages', {'text': 'completed-with-unknown-search', 'clientRequestId': str(uuid.uuid4())})

    def unresolved_search():
        value = (call(app_origin, delete_route).get('providerExecution') or {}).get('run') or {}
        if value.get('state') == 'unknown' and len(value.get('effects', {}).get('unresolvedCallIds', [])) == 1:
            return value
        return None

    stopped = wait(unresolved_search, 90)
    assert stopped['stopConfirmed'] is False
    retained = native_proof('unknown-outcome-before-retirement', stopped)
    assert _owns_exit(retained) and retained['receipt']['state'] == 'completed'
    assert retained['receipt']['exitConfirmed'] is True and len(retained['receipt']['effectIds']) == 1
    assert retained['providerSession']['activeRun'] == stopped['ref']['id']
    retained_leases = set(call(app_origin, worktree_route)['leases'])
    assert original_leases < retained_leases, 'The unresolved run must still have its own workspace lease'
    providers.restart('codex')
    no_replay(retained, native_proof('unknown-outcome-after-restart', stopped))

    delete_request = urllib.request.Request(app_origin + delete_route, headers={'Origin': app_origin}, method='DELETE')
    try:
        with client.open(delete_request, timeout=60) as response:
            assert json.load(response) == {'deleted': True}, 'One owner Delete request must retire a proven-stopped run with incomplete results'
    except urllib.error.HTTPError as error:
        payload = json.load(error)
        code = payload.get('code') or (payload.get('error') or {}).get('code')
        raise AssertionError(f'Owner Delete failed for the proven-stopped fixture: HTTP {error.code} {code}') from error
    try:
        call(app_origin, delete_route)
    except urllib.error.HTTPError as error:
        assert error.code == 404
    else:
        raise AssertionError('The selected conversation still exists after Delete')
    retired = native_proof('unknown-outcome-after-retirement', stopped)
    no_replay(retained, retired)
    assert retired['receipt'] == retained['receipt'], 'Retirement must preserve the exact native receipt and unresolved outcome'
    assert retired['providerSession']['activeRun'] is None
    settled_tree = call(app_origin, worktree_route)
    assert settled_tree['branch'] == tree['branch'] and set(settled_tree['leases']) == original_leases
    assert dirty_file.read_text() == 'Preserve this uncommitted work.'
    assert not any(entry['sessionId'] == disposable['id'] and entry['attached']
        for entry in call(app_origin, workspace_route+'/participants')['sessions'])
    assert fresh_current()['id'] == fresh['id'], 'Deleting the stopped session must keep other conversations'
    say('PASS: one authenticated Delete retires a previously retained proven-stopped run, preserves unknown evidence and deletes only its Harness conversation')
    if os.name == 'nt':
        _check_windows_aggregate_replacement(context, app_origin, call, client, connection)
    return {'before': before_crash, 'after': after_crash, 'afterConsumer': after_consumer,
        'quiescentStopped': cancelled_proof, 'quiescentResumed': resumed_proof, 'retired': retired,
        'completedChatId': fresh['id'], 'otherChatId': session['id'], 'retainedTree': tree}

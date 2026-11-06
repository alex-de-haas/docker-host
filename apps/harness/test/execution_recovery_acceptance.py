"""Recover a synthetic legacy Local run only in the disposable parent-managed child."""
import datetime
import hashlib
import json
import os
import pathlib
import time
import urllib.error
import uuid


def check(context, app, app_origin, call, timed, link):
    root, run, say = (context[key] for key in ('root', 'run', 'say'))
    app_root = root/'apps'/app
    session = call(app_origin, '/api/sessions', {'title': 'Interrupted execution recovery acceptance'})
    session_id, run_id = session['id'], str(uuid.uuid4())
    run([context['cli'], '--data-root', root, 'apps', 'stop', app])
    # No provider was launched. Seed only while this isolated app's services are stopped.
    data = app_root/'data'
    record_path = data/'sessions'/session_id/'record.json'
    record = json.loads(record_path.read_text())
    record.update(status='running', harnessSessionId='synthetic-retained-native-session', workerRun={'id':run_id, 'sequence':0})
    record_path.write_text(json.dumps(record))
    events_path = record_path.parent/'events.ndjson'
    existing = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()]
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    preserved = {'type':'user_message', 'seq':max((e['seq'] for e in existing), default=0)+1,
        'ts':now, 'text':'Preserve the interrupted request without replaying it.'}
    with events_path.open('a') as output:
        output.write(json.dumps(preserved)+'\n')
    journal_path = data/'worker-service'/'runs'/(run_id+'.json')
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    journal_path.write_text(json.dumps({'version':1, 'hash':'synthetic-legacy-recovery', 'controls':{}, 'events':[], 'bytes':0,
        'receipt':{'runId':run_id, 'conversationId':session_id, 'generation':str(uuid.uuid4()), 'boundary':'local',
            'state':'running', 'revision':0, 'selection':{'model':None, 'reasoningEffort':None}, 'createdAt':now, 'updatedAt':now}}))
    source = context['workspace']/'apps/harness/src/sessions/manager.ts'
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    timed('start')
    route = '/api/sessions/'+session_id+'/execution-recovery'
    review = call(app_origin, route)
    assert review['recoverable'] and review['runId'] == run_id
    try:
        call(app_origin, '/api/sessions/'+session_id+'/cancel', {})
        raise AssertionError('Stop silently confirmed a legacy execution')
    except urllib.error.HTTPError as error:
        assert json.load(error)['code'] == 'exit_unconfirmed'
    assert not json.loads(journal_path.read_text())['receipt'].get('exitConfirmed')
    if path := os.environ.get('HOSTY_EXECUTION_RECOVERY_REVIEW'):
        review_path = pathlib.Path(path)
        descriptor = os.open(review_path, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'core':context['origin'], 'harness':app_origin, 'link':link,
                'email':'activation-fixture@example.test', 'password':context['password'], 'sessionId':session_id}, output)
        say('RECOVERY_BROWSER_REVIEW_READY: '+str(review_path))
        continuation = pathlib.Path(path+'.continue')
        try:
            deadline = time.monotonic()+1200
            while not continuation.exists():
                if time.monotonic()>deadline: raise TimeoutError('Recovery browser review timed out')
                time.sleep(.5)
        finally:
            review_path.unlink(missing_ok=True)
            continuation.unlink(missing_ok=True)
        receipt = json.loads(journal_path.read_text())['receipt']
        request_id = receipt['recovery']['requestId']
    else:
        request_id = str(uuid.uuid4())
        call(app_origin, route, {'requestId':request_id, 'runId':run_id, 'generation':review['generation'],
            'expectedRevision':review['expectedRevision'], 'consumerExitConfirmed':True})
    request = {'requestId':request_id, 'runId':run_id, 'generation':review['generation'],
        'expectedRevision':review['expectedRevision'], 'consumerExitConfirmed':True}
    result = call(app_origin, '/api/sessions/'+session_id)
    assert result['status'] == 'cancelled' and not result.get('workerRun')
    assert result['workerRecovery']['state'] == 'completed'
    receipt = json.loads(journal_path.read_text())['receipt']
    assert receipt['state'] == 'cancelled' and receipt['exitConfirmed'] and receipt['recovery']['requestId'] == request_id
    events = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()]
    assert sum(e.get('text') == preserved['text'] for e in events) == 1
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    call(app_origin, route, request)
    timed('restart')
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    assert call(app_origin, '/api/sessions/'+session_id)['status'] == 'cancelled'
    call(app_origin, route, request)
    observed = json.loads((data/'agent-observations.json').read_text())
    assert all(value['stopConfirmed'] for value in observed['runs'] if value['conversation'] == session_id)
    say('PASS: legacy Local interruption, failed Stop, explicit exact-run recovery, native stop observation, preserved transcript/source and durable replay across real restart')

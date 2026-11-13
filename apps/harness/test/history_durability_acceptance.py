"""Accepted input and damaged-record isolation in the disposable parent-managed child."""
import json
import urllib.error
import urllib.request
import uuid


def check(context, app, app_origin, client, call, timed):
    root, run, say = (context[key] for key in ('root', 'run', 'say'))
    session = call(app_origin, '/api/sessions', {'title': 'History durability acceptance'})
    session_id = session['id']
    data = root/'apps'/app/'data'
    queue_path = '/api/sessions/'+session_id+'/message-queue'
    queue = call(app_origin, queue_path)
    pause = {'requestId': str(uuid.uuid4()), 'expectedRevision': queue['revision'], 'command': {'type': 'pause'}}
    paused = call(app_origin, queue_path+'/commands', pause)['queue']
    upload_id = str(uuid.uuid4())
    upload = urllib.request.Request(app_origin+queue_path+'/uploads/'+upload_id+'?name=retained.txt',
        data=b'durable synthetic attachment', method='PUT',
        headers={'Content-Type': 'application/octet-stream', 'Origin': app_origin})
    with client.open(upload, timeout=30) as response:
        assert response.status == 201
        attachment = json.load(response)['attachment']
    command = {'requestId': str(uuid.uuid4()), 'expectedRevision': paused['revision'],
        'command': {'type': 'enqueue', 'entryId': str(uuid.uuid4()),
                    'text': 'Retain this accepted queued input after restart.', 'attachments': [attachment['name']]}}
    accepted = call(app_origin, queue_path+'/commands', command)
    assert accepted['queue']['paused'] and len(accepted['queue']['entries']) == 1
    assert not call(app_origin, '/api/sessions/'+session_id).get('workerRun')
    manifest = data/'conversation-history-v2'/'manifest.json'
    assert manifest.is_file()
    assert command['command']['text'] not in manifest.read_text()
    timed('restart')
    replay = call(app_origin, queue_path+'/commands', command)
    assert replay['result'] == accepted['result']
    assert replay['queue']['paused'] and len(replay['queue']['entries']) == 1
    assert replay['queue']['entries'][0]['text'] == command['command']['text']
    with client.open(app_origin+queue_path+'/attachments/'+attachment['id'], timeout=30) as response:
        assert response.read() == b'durable synthetic attachment'
    assert not call(app_origin, '/api/sessions/'+session_id).get('workerRun')
    say('PASS: acknowledged queue input, immutable attachment, original UUID receipt and pause survive a real API/Worker restart without inference')

    damaged = call(app_origin, '/api/sessions', {'title': 'Synthetic damaged storage'})
    run([context['cli'], '--data-root', root, 'apps', 'stop', app])
    # Inject corruption only while these disposable services are stopped. Retain original bytes.
    record = data/'sessions'/damaged['id']/'record.json'
    original = record.read_bytes()
    evidence = record.with_name('fixture-original-record.json.evidence')
    evidence.write_bytes(original)
    record.write_bytes(b'\0'*64)
    bad_run = data/'worker-service'/'runs'/'damaged-fixture.json'
    bad_run.parent.mkdir(parents=True, exist_ok=True)
    bad_run.write_bytes(b'{"torn":')
    timed('start')
    issues = call(app_origin, '/api/storage-recovery')['issues']
    assert any(issue['sessionId'] == damaged['id'] for issue in issues)
    assert call(app_origin, '/api/sessions/'+session_id)['id'] == session_id
    healthy_queue = call(app_origin, queue_path)
    assert healthy_queue['paused'] and len(healthy_queue['entries']) == 1
    assert not call(app_origin, '/api/sessions/'+session_id).get('workerRun')
    try:
        call(app_origin, '/api/sessions/'+damaged['id'])
        raise AssertionError('Corrupt source record was treated as a usable or missing conversation')
    except urllib.error.HTTPError as error:
        assert error.code == 503 and json.load(error)['code'] == 'session_storage_corrupt'
    assert record.read_bytes() == b'\0'*64 and evidence.read_bytes() == original
    assert bad_run.read_bytes() == b'{"torn":'
    say('PASS: one corrupt session and Worker run remain fenced with intact evidence while healthy accepted input stays accessible')

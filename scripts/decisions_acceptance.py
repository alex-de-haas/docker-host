"""Decisions through real Core/Harness/Worker with an explicitly scripted provider."""
import uuid
import json

def check(c):
    try: _check(c)
    except Exception:
        for file in (c['root']/'apps'/'hosty.harness').glob('**/decision-waits/*.json'):
            data=json.loads(file.read_text())
            c['say']('Wait diagnosis: '+json.dumps({k:data.get(k) for k in ['state','error','reason','control','native','core','inbox']}))
        for file in (c['root']/'apps'/'hosty.harness').glob('**/events.ndjson'):
            for line in file.read_text().splitlines()[-8:]:
                data=json.loads(line); c['say']('Event diagnosis: '+json.dumps({k:data.get(k) for k in ['type','message','text','error','status','questionId']}))
        raise

def _check(c):
    h, wait, say = c['h'], c['wait_for'], c['say']
    # Authenticate both the private source coordinator and the independent operator client.
    h('/decisions')
    session = h('/sessions', {'title':'Decision live acceptance', 'profileId':c['profile']['id']})
    h('/sessions/'+session['id']+'/messages', {'text':'DECISIONS_ACCEPTANCE:LIVE', 'clientRequestId':str(uuid.uuid4())}, expected=202)
    def find(sid):
        return next((row for row in h('/decisions')['items'] if (row.get('input') or {}).get('subject',{}).get('id')==sid), None)
    try: wait(lambda: find(session['id']), 60)
    except Exception:
        observed = h('/sessions/'+session['id'])
        say('Decision session: '+json.dumps({k:observed.get(k) for k in ['id','status','harnessKind','harnessSessionId','lastError']}))
        for file in (c['root']/'apps'/'hosty.harness').glob('**/decision-waits/*.json'):
            data=json.loads(file.read_text()); say('Decision wait: '+json.dumps({k:data.get(k) for k in ['state','error','reason','native','snapshot']}))
        for file in (c['root']/'apps'/'hosty.harness').glob('**/events.ndjson'):
            for line in file.read_text().splitlines()[-12:]:
                data=json.loads(line)
                say('Decision event: '+json.dumps({k:data.get(k) for k in ['type','message','text','error','status','questionId']}))
        raise
    row = find(session['id'])
    first, second = row['input']['questions']
    assert first['id'] != second['id'] and first['question'] == second['question']
    assert first['options'][0]['id'] != first['options'][1]['id']
    command = {'requestId':str(uuid.uuid4()), 'expectedRevision':row['revision'], 'answers':{
        first['id']:{'optionIds':[first['options'][1]['id']]}, second['id']:{'text':'Independent client answer'}}}
    route = '/api/decisions/v1/requests/'+row['id']+'/resolve'
    result = c['call'](c['origin'], route, command)
    assert c['call'](c['origin'], route, command) == result
    h('/decisions/'+row['id']+'/resolve', {**command, 'requestId':str(uuid.uuid4())}, expected=409)
    wait(lambda: (h('/decisions/'+row['id']).get('continuation') or {}).get('state')=='completed', 60)
    answers = h('/decisions/'+row['id'])['resolution']['answers']
    assert answers[first['id']]['optionIds']==command['answers'][first['id']]['optionIds']
    assert answers[second['id']]['text']==command['answers'][second['id']]['text']
    say('PASS: ordinary native question, duplicate IDs/labels, independent Core response, immutable replay and one live continuation')

    task = c['action'](c['create']('Parked decision task', c['assignee'], markdown='TASK_ACCEPTANCE:QUESTION'), 'ready')
    def waiting():
        current = c['read'](task)
        return current['attempts'] and current['attempts'][0].get('receipt',{}).get('state')=='awaiting_input'
    wait(waiting, 60)
    task = c['read'](task); attempt = task['attempts'][0]; execution = attempt['executionId']
    sid = attempt['receipt']['sessionRef']['id']
    wait(lambda: find(sid), 60); row = find(sid)
    local = '/decisions/waits/'+row['input']['waitReference']
    # The production deadline is exercised; no test-only shorter parking policy.
    wait(lambda: h(local)['state']=='parked', 360)
    task = c['read'](task)
    assert task['attempts'][0]['receipt']['state']=='awaiting_input' and not task['attempts'][0]['receipt']['stopConfirmed']
    wait(lambda: c['read'](task)['attempts'][0]['receipt'].get('nativeStopConfirmed') is True, 30)
    c['run']([c['cli'],'--data-root',c['root'],'apps','restart','hosty.harness'])
    wait(lambda: c['request']('/api/apps/hosty.harness/health')['status']=='healthy',180)
    c['login_app'](); h('/decisions')
    assert h(local)['state']=='parked'
    first, second = row['input']['questions']
    command = {'requestId':str(uuid.uuid4()), 'expectedRevision':row['revision'], 'answers':{
        first['id']:{'optionIds':[first['options'][0]['id']]}, second['id']:{'text':'TASK_ACCEPTANCE:RESULT'}}}
    h('/decisions/'+row['id']+'/resolve', command)
    completed = c['settle'](task)
    assert len(completed['attempts'])==1 and completed['attempts'][0]['executionId']==execution
    assert completed['result'] and completed['attempts'][0]['receipt']['stopConfirmed']
    wait(lambda: h('/decisions/'+row['id'])['continuation']['state']=='completed',60)
    say('PASS: five-minute parking, API/Worker restart, durable answer and same task attempt with explicit result')

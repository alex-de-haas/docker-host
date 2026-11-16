"""Decisions through real Core, Harness and an independently scripted Local provider."""
import uuid
import json
from agent_provider_acceptance import execution_stopped

def check(c):
    try: _check(c)
    except Exception:
        app = c.get('harnessAppId') or json.loads((c['workspace']/'apps/harness/manifest.json').read_text())['id']
        for file in (c['root']/'apps'/app).glob('**/task-decision-waits-v2/*.json'):
            data=json.loads(file.read_text())
            c['say']('Wait diagnosis: '+json.dumps({k:data.get(k) for k in ['state','error','reason','control','native','core','inbox']}))
        for file in (c['root']/'apps'/app).glob('**/events.ndjson'):
            for line in file.read_text().splitlines()[-8:]:
                data=json.loads(line); c['say']('Event diagnosis: '+json.dumps({k:data.get(k) for k in ['type','message','text','error','status','questionId']}))
        raise

def _check(c):
    h, wait, say = c['h'], c['wait_for'], c['say']
    app = c.get('harnessAppId') or json.loads((c['workspace']/'apps/harness/manifest.json').read_text())['id']
    # The operator sees both provider-owned native questions and Harness-owned task input.
    h('/decisions')
    session = h('/sessions', {'title':'Decision live acceptance', 'profileId':c['profile']['id']})
    h('/sessions/'+session['id']+'/messages', {'text':'DECISIONS_ACCEPTANCE:LIVE', 'clientRequestId':str(uuid.uuid4())}, expected=202)
    def find(sid, kind='agent-run'):
        run_id = (h('/sessions/'+sid).get('providerExecution') or {}).get('runId')
        subject_id = run_id if kind == 'agent-run' else sid
        return next((row for row in h('/decisions')['items']
            if (row.get('input') or {}).get('subject', {}).get('kind') == kind
            and (row.get('input') or {}).get('subject', {}).get('id') == subject_id), None)
    try: wait(lambda: find(session['id']), 60)
    except Exception:
        observed = h('/sessions/'+session['id'])
        say('Decision session: '+json.dumps({k:observed.get(k) for k in ['id','status','harnessKind','harnessSessionId','lastError']}))
        for file in (c['root']/'apps'/app).glob('**/task-decision-waits-v2/*.json'):
            data=json.loads(file.read_text()); say('Decision wait: '+json.dumps({k:data.get(k) for k in ['state','error','reason','native','snapshot']}))
        for file in (c['root']/'apps'/app).glob('**/events.ndjson'):
            for line in file.read_text().splitlines()[-12:]:
                data=json.loads(line)
                say('Decision event: '+json.dumps({k:data.get(k) for k in ['type','message','text','error','status','questionId']}))
        raise
    row = find(session['id'])
    assert row['input']['subject']['kind'] == 'agent-run'
    assert row['input']['subject']['id'] == h('/sessions/'+session['id'])['providerExecution']['runId']
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
    wait(lambda: execution_stopped(h('/sessions/'+session['id'])), 60)
    answers = h('/decisions/'+row['id'])['resolution']['answers']
    assert answers[first['id']]['optionIds']==command['answers'][first['id']]['optionIds']
    assert answers[second['id']]['text']==command['answers'][second['id']]['text']
    say('PASS: provider-owned native question, duplicate IDs/labels, independent Core response, immutable replay and one live continuation')

    required = c['action'](c['create']('Required setup task', c['assignee'], markdown='TASK_ACCEPTANCE:REQUIRED'), 'ready')
    wait(lambda: c['read'](required)['attempts'] and c['read'](required)['attempts'][0].get('receipt',{}).get('state')=='awaiting_input', 60)
    required = c['read'](required); attempt = required['attempts'][0]; sid = attempt['receipt']['sessionRef']['id']
    wait(lambda: find(sid, 'conversation'), 60); question = find(sid, 'conversation')
    assert required['status']=='Blocked' and question['input']['title'].startswith(required['number'])
    assert question['input']['reason']=='The isolated setup prerequisite is missing.'
    assert question['notificationPending'] is False
    wait(lambda: h('/sessions/'+sid).get('taskBarrier',{}).get('state')=='parked', 60)
    wait(lambda: c['read'](required)['attempts'][0]['receipt'].get('nativeStopConfirmed') is True, 30)
    assert not c['read'](required)['attempts'][0]['receipt']['stopConfirmed']
    h('/decisions/'+question['id']+'/resolve', {'requestId':str(uuid.uuid4()), 'expectedRevision':question['revision'], 'answers':{'setup':{'text':'TASK_ACCEPTANCE:RESULT'}}})
    finished = c['settle'](required)
    assert len(finished['attempts'])==1 and finished['attempts'][0]['executionId']==attempt['executionId']
    assert finished['attempts'][0]['receipt']['sessionRef']['id']==sid
    failure = c['settle'](c['action'](c['create']('Explicit unsuccessful task', c['assignee'], markdown='TASK_ACCEPTANCE:FAIL'), 'ready'), 'Blocked')
    wait(lambda: c['read'](failure)['attempts'][0]['receipt'].get('stopConfirmed') is True, 30)
    failure = c['read'](failure)
    assert failure['attempts'][0]['receipt']['state']=='failed' and failure.get('resultRef') is None
    wait(lambda: any(row.get('taskId')==failure['ref']['id'] for row in h('/decisions/projections')['items']), 30)
    say('PASS: required task Decision, notification, confirmed boundary, same-attempt answer and truthful unsuccessful outcome')

    task = c['action'](c['create']('Parked decision task' , c['assignee'], markdown='TASK_ACCEPTANCE:QUESTION'), 'ready')
    def waiting():
        current = c['read'](task)
        return current['attempts'] and current['attempts'][0].get('receipt',{}).get('state')=='awaiting_input'
    wait(waiting, 60)
    task = c['read'](task); attempt = task['attempts'][0]; execution = attempt['executionId']
    sid = attempt['receipt']['sessionRef']['id']
    wait(lambda: find(sid, 'conversation'), 60); row = find(sid, 'conversation')
    local = '/decisions/waits/'+row['input']['waitReference']
    # The production deadline is exercised; no test-only shorter parking policy.
    wait(lambda: h(local)['state']=='parked', 360)
    task = c['read'](task)
    assert task['attempts'][0]['receipt']['state']=='awaiting_input' and not task['attempts'][0]['receipt']['stopConfirmed']
    wait(lambda: c['read'](task)['attempts'][0]['receipt'].get('nativeStopConfirmed') is True, 30)
    provider = c['agentProviders'].entries['codex']
    provider_pid_file = c['root']/'apps'/provider['appId']/'run/api.json'
    provider_pid = json.loads(provider_pid_file.read_text())['pid']
    c['run']([c['cli'],'--data-root',c['root'],'apps','restart',app])
    wait(lambda: c['request']('/api/apps/'+app+'/health')['status']=='healthy',180)
    assert json.loads(provider_pid_file.read_text())['pid'] == provider_pid
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
    say('PASS: five-minute parking, independent consumer restart, durable answer and same task attempt with explicit result')

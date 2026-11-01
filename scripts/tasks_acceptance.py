"""Basic tasks in a disposable managed Core. Only scripted providers and synthetic credentials."""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[k] for k in ('base','root','workspace'))
    run, request, say, wait_for = (context[k] for k in ('run','request','say','wait_for'))
    origin, password, cli = (context[k] for k in ('origin','password','cli'))
    app = 'hosty.harness'
    manifest = json.loads((workspace/'apps/harness/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    next(s for s in manifest['services'] if s['key']=='worker')['runtimes']['docker']['environment']['HOSTY_HARNESS_CODEX_COMMAND'] = '/repo/apps/harness/test/fake-codex-server.mjs'
    for permission in ['providers.tasks','providers.task-executor']:
        manifest['optionalCorePermissions'].remove(permission); manifest['corePermissions'].append(permission)
    target = base/'harness-manifest.json'; target.write_text(json.dumps(manifest))
    run([cli,'--data-root',root,'apps','install',target,'--runtime','docker','--no-autostart'])
    run([cli,'--data-root',root,'apps','start',app])
    wait_for(lambda: request('/api/apps/'+app+'/health')['status']=='healthy',180)
    link = json.loads(run([cli,'--data-root',root,'apps','open',app,'--format','json']))['url']
    app_origin = urllib.parse.urlunparse(urllib.parse.urlparse(link)._replace(path='',query='',fragment=''))
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
    csrf = None
    def call(host,path,body=None,method=None,expected=200,extra=None):
        headers = {'Content-Type':'application/json','Origin':host,**(extra or {})}
        if csrf and host==origin: headers['X-Hosty-CSRF']=csrf
        req = urllib.request.Request(host+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        try:
            with client.open(req,timeout=180) as response: status,raw=response.status,response.read()
        except urllib.error.HTTPError as error: status,raw=error.code,error.read()
        value=json.loads(raw) if raw else None
        assert status==expected,(path,status,value)
        return value
    def h(path,body=None,method=None,expected=200): return call(app_origin,'/api'+path,body,method,expected)
    h('/tasks/v1/tasks',expected=401)
    form=urllib.parse.urlencode({'email':'activation-fixture@example.test','password':password,'returnTo':'/api/auth/session'}).encode()
    with client.open(urllib.request.Request(origin+'/login',data=form,headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}),timeout=30) as response: response.read()
    user=call(origin,'/api/auth/session')['user']['id']; csrf=call(origin,'/api/auth/csrf')['token']
    def login_app():
        verifier=uuid.uuid4().hex+uuid.uuid4().hex
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        code=call(origin,'/api/apps/'+app+'/launch-code',{'redirectUri':link,'codeChallenge':challenge,'codeChallengeMethod':'S256'})['code']
        h('/auth/app-code',{'code':code,'codeVerifier':verifier})
        context['diagnostic_secrets'].update(cookie.value for cookie in jar)
    login_app()
    directory=h('/tasks/v1/directory'); provider=directory['provider']
    assert any(u['id']==user for u in directory['users'])
    caps=h('/tasks/v1/capabilities'); assert caps['statuses']==['Draft','Ready','InProgress','Blocked','Done','Cancelled']
    def create(title,assignee,review=False,markdown='Plain Markdown task.',workspace_id=None):
        payload={'requestId':str(uuid.uuid4()),'input':{'title':title,'markdown':markdown,'assignee':assignee,'requiresReview':review,'resources':[]}}
        if workspace_id: payload['input']['workspaceId']=workspace_id
        task=h('/tasks/v1/tasks',payload,expected=201)
        assert h('/tasks/v1/tasks',payload,expected=201)==task
        return task
    def read(task): return h('/tasks/v1/tasks/'+task['ref']['id'])
    def action(task,name,**kw):
        task=read(task); payload={'requestId':str(uuid.uuid4()),'expectedRevision':task['revision'],'action':name,**kw}
        route='/tasks/v1/tasks/'+task['ref']['id']+'/actions'; result=h(route,payload)
        assert h(route,payload)==result
        return result
    human={'kind':'human','userId':user,'name':'Fixture owner'}
    task=create('Manual review journey',human,True); number=task['number']; assert number.startswith(caps['prefix']+'-')
    task=action(task,'ready'); assert not task['attempts'] and task['status']=='Ready'
    task=action(action(task,'start'),'complete',result={'markdown':'First result','resources':[]}); assert task['blocked']['reason']=='needs_review'
    task=action(task,'request_changes',resultInputRevision=task['resultInputRevision'],feedback='Include the conclusion.')
    assert task['status']=='Draft' and 'Include the conclusion.' in task['markdown']
    task=action(action(task,'ready'),'start'); task=action(task,'complete',result={'markdown':'Revised result','resources':[]})
    task=action(task,'accept',resultInputRevision=task['resultInputRevision']); assert task['status']=='Done'
    task=action(task,'draft'); assert task['status']=='Draft' and task['number']==number
    assert action(task,'cancel')['status']=='Cancelled'
    say('PASS: human assignment, numbering/replay, review/rework, reopen and cancellation')
    connection=h('/connections',{'name':'Scripted acceptance connection','kind':'codex','auth':'api-key','secret':'synthetic-task-fixture-only'},expected=201)
    h('/connections/'+connection['id']+'/test',{})
    profiles=h('/profiles'); config={'name':'Acceptance writer','description':'Scripted native adapter','instructions':'Complete the requested task.','connectionId':connection['id'],'model':'fixture-default','reasoningEffort':'medium','skillIds':[]}
    profiles=h('/profiles',{'expectedRevision':profiles['revision'],'profile':config},expected=201)
    profile=next(p for p in profiles['profiles'] if p['name']==config['name'])
    assignee={'kind':'app','executor':provider,'optionId':profile['id']}
    def settle(task,wanted='Done',approve=True,timeout=100):
        last=None
        def ready():
            nonlocal last
            last=read(task)
            if approve and last['attempts']:
                receipt=last['attempts'][-1].get('receipt') or {}; sid=(receipt.get('sessionRef') or {}).get('id')
                if sid:
                    session=h('/sessions/'+sid)
                    for approval in session.get('mcpPendingApprovals',[]):
                        assert 'task_result' in approval['tool'],approval
                        h('/sessions/'+sid+'/approvals/'+approval['id'],{'decision':'allow'})
            if last['status']==wanted: return True
            if last['status']=='Blocked' and last.get('blocked',{}).get('reason')=='execution_failed' and wanted!='Blocked': raise AssertionError(('Execution failed',last))
            return False
        try: wait_for(ready,timeout)
        except Exception:
            say('Task observation: '+json.dumps(last))
            for log in (root/'apps'/app/'logs').glob('*.log'):
                say(log.name+': '+log.read_text()[-6000:])
            for events in (root/'apps'/app).glob('**/events.jsonl'):
                for line in events.read_text().splitlines():
                    event=json.loads(line)
                    if event.get('type') in ['error','notice']: say('Session event: '+json.dumps(event))
            raise
        return last
    task=settle(action(create('Native profile without workspace',assignee,markdown='TASK_ACCEPTANCE:RESULT'),'ready'))
    first_id=task['attempts'][0]['executionId']; assert task['attempts'][0]['receipt']['stopConfirmed'] and len(task['attempts'])==1
    sid=task['attempts'][0]['receipt']['sessionRef']['id']; session=h('/sessions/'+sid)
    assert not session.get('workspaceAssociation') and not session.get('developmentWorkspaces')
    assert h('/sessions/'+sid+'/messages',{'text':'Extra turn','clientRequestId':str(uuid.uuid4())},expected=409)['code']=='task_managed_session'
    bad=settle(action(create('A chat turn is not an outcome',assignee,markdown='TASK_ACCEPTANCE:NO_OUTCOME'),'ready'),'Blocked')
    assert bad['blocked']['reason']=='execution_failed' and bad['attempts'][0]['receipt']['stopConfirmed']
    waiting=settle(action(create('Cancel running work',assignee,markdown='TASK_ACCEPTANCE:WAIT'),'ready'),'InProgress',False)
    assert settle(action(waiting,'cancel'),'Cancelled',False)['attempts'][0]['receipt']['stopConfirmed']
    say('PASS: Worker/native protocol, task-scoped MCP approval/result, ordinary-turn refusal and confirmed cancellation')
    source_session=h('/sessions',{'title':'Existing workspace selection'})
    tree=h('/sessions/'+source_session['id']+'/workspaces',{'action':'prepare','requestId':str(uuid.uuid4()),'appId':app,'targetBranch':'main'})
    task=settle(action(create('Existing workspace',assignee,markdown='TASK_ACCEPTANCE:RESULT',workspace_id=tree['workspaceId']),'ready'))
    selected=h('/sessions/'+task['attempts'][0]['receipt']['sessionRef']['id'])
    assert selected['workspaceAssociation']['id']==tree['workspaceId'] and any(w['id']==tree['id'] for w in selected['developmentWorkspaces'])
    assert any(w['id']==tree['id'] for w in h('/sessions/'+source_session['id']+'/workspaces',{'action':'list'})['workspaces'])
    say('PASS: existing workspace reused and retained after completion')
    # The canonical Core entry point retains the original caller and admits a workspace-bound
    # execution without giving the executor a general browser or MCP credential.
    canonical_input={'provider':provider,'input':{'requestId':str(uuid.uuid4()),'input':{
        'title':'Canonical Core workspace task','markdown':'TASK_ACCEPTANCE:RESULT','assignee':assignee,
        'workspaceId':tree['workspaceId'],'requiresReview':False,'resources':[]}}}
    canonical=call(origin,'/api/tasks/v1/create',canonical_input)
    assert call(origin,'/api/tasks/v1/create',canonical_input)==canonical
    canonical_action={'taskRef':canonical['ref'],'input':{'requestId':str(uuid.uuid4()),'expectedRevision':canonical['revision'],'action':'ready'}}
    canonical=call(origin,'/api/tasks/v1/action',canonical_action)
    canonical=settle(canonical)
    assert len(canonical['attempts'])==1 and canonical['attempts'][0]['receipt']['stopConfirmed']
    canonical_session=h('/sessions/'+canonical['attempts'][0]['receipt']['sessionRef']['id'])
    assert canonical_session['workspaceAssociation']['id']==tree['workspaceId']
    assert any(w['id']==tree['id'] for w in canonical_session['developmentWorkspaces'])
    canonical_read=call(origin,'/api/tasks/v1/get',{'taskRef':canonical['ref']})
    assert canonical_read['status']=='Done' and canonical_read['ref']==canonical['ref']
    conversation={'provider':provider,'id':canonical_session['id']}
    history=call(origin,'/api/history/v1/entries/query',{'conversation':conversation})
    assert any(entry['data']['kind']=='message' for entry in history['entries'])
    search=call(origin,'/api/history/v1/search',{'providers':[provider],'conversations':[conversation],'q':'TASK_ACCEPTANCE'})
    assert search['hits']
    native=call(origin,'/api/agent-sessions/v1/sessions/query',{'provider':provider,'conversation':conversation})
    assert native['availability']=='available' and native['sessions']
    assert all(row['conversation']==conversation for row in native['sessions'])
    say('PASS: canonical Core task replay, receipt-bound native workspace admission, explicit stopped result and common history/search/session projection')
    image=next(s for s in manifest['services'] if s['key']=='api')['runtimes']['docker']['image']; fixture_id='example.task-conformance'
    fixture_image='hosty-tasks-conformance:'+uuid.uuid4().hex
    image_context=base/'task-fixture-image'; image_context.mkdir()
    (image_context/'Dockerfile').write_text('FROM '+image+'\nCMD ["node", "--import", "tsx", "test/task-provider-fixture.mjs"]\n')
    run(['docker','build','-q','-t',fixture_image,image_context]); context['task_fixture_image']=fixture_image
    fixture={'schemaVersion':'app.0.1','id':fixture_id,'name':'Task conformance fixture','version':'1.0.0','description':'Disposable independent task producer/executor',
        'runtimeProfiles':[{'key':'docker','type':'docker','default':True}],'defaultRuntime':'docker',
        'services':[{'key':'api','runtimes':{'docker':{'type':'docker','image':fixture_image,'ports':[{'key':'http','containerPort':3410,'protocol':'http','public':True}],
            'healthcheck':{'type':'exec','command':"node -e \"fetch('http://127.0.0.1:3410/healthz').then(r=>process.exit(r.ok?0:1))\"",'intervalSeconds':5,'timeoutSeconds':5,'retries':3,'gracePeriodSeconds':10}}}}],
        'data':{'enabled':True,'targets':[{'runtime':'docker','service':'api','containerPath':'/app/data','environment':'HOSTY_APP_DATA_DIR'}]},
        'endpoints':[{'key':'http','service':'api','port':'http','protocol':'http','public':True}],
        'provides':['task-executor'],'interfaces':{'task-executor':[{'key':'default','endpoint':'http','path':'/v1','version':1,'capabilities':['markdown']}]},
        'corePermissions':['providers.tasks','providers.task-executor'],'ui':{'entrypoint':{'endpoint':'http','path':'/healthz'}}}
    target=base/'independent-tasks-manifest.json'; target.write_text(json.dumps(fixture))
    run([cli,'--data-root',root,'apps','install',target,'--runtime','docker','--no-autostart'])
    try: run([cli,'--data-root',root,'apps','start',fixture_id])
    except Exception:
        for log in (root/'apps'/fixture_id/'logs').glob('*.log'): say(log.name+': '+log.read_text()[-6000:])
        raise
    wait_for(lambda: request('/api/apps/'+fixture_id+'/health')['status']=='healthy',180)
    fixture_link=json.loads(run([cli,'--data-root',root,'apps','open',fixture_id,'--format','json']))['url']
    fixture_origin=urllib.parse.urlunparse(urllib.parse.urlparse(fixture_link)._replace(path='',query='',fragment='')); external=call(fixture_origin,'/healthz')
    identity=run([cli,'--data-root',root,'apps','identity',fixture_id,'--user','activation-fixture@example.test','--format','token']).strip(); context['diagnostic_secrets'].add(identity)
    payload={'provider':provider,'request':{'requestId':str(uuid.uuid4()),'input':{'title':'Independent producer/executor','markdown':'No Harness profile','assignee':{'kind':'app','executor':external},'requiresReview':False,'resources':[]}}}
    task=call(fixture_origin,'/produce',payload,expected=201,extra={'X-Hosty-User-Token':identity}); assert task['createdBy']['appId']==fixture_id
    assert call(fixture_origin,'/produce',payload,expected=201,extra={'X-Hosty-User-Token':identity})==task
    task=settle(action(task,'ready')); assert task['attempts'][0]['executor']==external and 'Independent executor' in task['result']['markdown']
    eid=str(uuid.uuid4()); invocation={'executor':provider,'id':eid,'operation':'cancel','requestId':str(uuid.uuid4())}
    assert call(fixture_origin,'/invoke',invocation,extra={'X-Hosty-User-Token':identity})['state']=='cancelled'
    invocation.update(operation='accept',input={'taskRef':{**external,'id':str(uuid.uuid4())},'taskRevision':1,'executorOptionId':profile['id'],'input':{'title':'Must never launch','markdown':'TASK_ACCEPTANCE:RESULT','requiresReview':False,'resources':[]}})
    assert call(fixture_origin,'/invoke',invocation,extra={'X-Hosty-User-Token':identity})['state']=='cancelled'
    invocation.update(id=str(uuid.uuid4()),operation='accept')
    invocation['input']['input'].update(title='Cross-app conversation',markdown='TASK_ACCEPTANCE:WAIT')
    accepted=call(fixture_origin,'/invoke',invocation,extra={'X-Hosty-User-Token':identity})
    conversation=accepted['sessionRef']['path']; parsed=urllib.parse.urlparse(conversation); harness=urllib.parse.urlparse(app_origin)
    assert parsed.scheme==harness.scheme and parsed.netloc==harness.netloc and parsed.path=='/assistant', conversation
    assert urllib.parse.parse_qs(parsed.query)['session']==[accepted['sessionRef']['id']]
    with client.open(conversation,timeout=30) as response: assert response.status==200 and response.read()
    invocation.update(operation='cancel',requestId=str(uuid.uuid4()))
    call(fixture_origin,'/invoke',invocation,extra={'X-Hosty-User-Token':identity})
    invocation.update(operation='get')
    wait_for(lambda: call(fixture_origin,'/invoke',invocation,extra={'X-Hosty-User-Token':identity})['stopConfirmed'],30)
    say('PASS: independent SDK producer/executor, cross-app conversation URL, attributed Core tokens and cancel-before-accept fencing')
    recovering=settle(action(create('Interrupted native work',assignee,markdown='TASK_ACCEPTANCE:WAIT'),'ready'),'InProgress',False)
    recovery_id=recovering['attempts'][0]['executionId']
    run([cli,'--data-root',root,'apps','restart',app]); wait_for(lambda: request('/api/apps/'+app+'/health')['status']=='healthy',180); login_app()
    recovering=settle(recovering,'Blocked',False)
    assert len(recovering['attempts'])==1 and recovering['attempts'][0]['executionId']==recovery_id
    say('PASS: restart during execution retains one attempt and exposes interruption without replacement')
    assert read(task)['status']=='Done' and first_id in json.dumps(h('/tasks/v1/tasks'))
    with client.open(app_origin+'/tasks/',timeout=30) as response: html=response.read().decode()
    assets=re.findall(r'(?:src|href)="(/_next/[^"]+)"',html); assert assets
    for asset in assets:
        with client.open(app_origin+asset,timeout=30) as response: assert response.status==200 and response.read()
    say('PASS: API/Worker restart preserves task history/IDs and serves compiled Tasks UI')
    # Browser checks receive the synthetic password through stdin only; never save credentials.
    if os.environ.get('HOSTY_TASKS_BROWSER'):
        import subprocess
        result=subprocess.run(['node',str(workspace/'scripts/tasks-browser-acceptance.mjs')],input=json.dumps({'core':origin,'harness':app_origin,'email':'activation-fixture@example.test','password':password,'link':link}),text=True,cwd=workspace)
        assert result.returncode==0,'Browser acceptance failed'
    say('Task acceptance complete; parent owner will Finish the child and verify removal')

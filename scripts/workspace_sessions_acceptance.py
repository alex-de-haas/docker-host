"""Multi-user Harness acceptance inside check-workspace-activation's managed child Core.

Only isolated test credentials and data are used. Both provider adapters are covered by
`test:integration -- worker`; this journey deliberately dispatches no paid provider prompt.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    from core_mcp_acceptance import empty_core, harness_history
    empty_core(context)
    app = 'hosty.harness'
    def app_summary(app_id):
        return next(row for row in request('/api/apps')['apps'] if row['id'] == app_id)
    manifest = json.loads((workspace/'apps/harness/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    # Release tags are pulled and can replace a locally built image. Use local-only acceptance tags.
    for service in manifest['services']:
        service['runtimes']['docker']['image'] = 'hosty-harness-'+service['key']+'-acceptance:local'
    manifest_path = base/'harness-manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    run([cli, '--data-root', root, 'apps', 'install', manifest_path, '--runtime', 'docker', '--no-autostart'])
    run([cli, '--data-root', root, 'apps', 'start', app])
    def healthy():
        return request('/api/apps/'+app+'/health')['status'] == 'healthy'
    wait_for(healthy, 180)
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))

    class Browser:
        def __init__(self, email, name, invited=False, role="host.admin"):
            self.jar = http.cookiejar.CookieJar()
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
            self.csrf = None
            if invited:
                invitation = request('/api/auth/invitations', {'email': email, 'displayName': name, 'role': role}, confirm_settings=True)
                context['diagnostic_secrets'].add(invitation['token'])
                self.call(origin, '/api/auth/invitations/accept', {'setupToken': invitation['token'], 'displayName': name, 'password': password})
            self.jar.clear()
            data = urllib.parse.urlencode({'email': email, 'password': password, 'returnTo': '/api/auth/session'}).encode()
            with self.client.open(urllib.request.Request(origin+'/login', data=data,
                    headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': origin}), timeout=30) as response:
                response.read()
            identity = self.call(origin, '/api/auth/session')
            assert identity['authenticated']
            self.user = identity['user']['id']
            self.csrf = self.call(origin, '/api/auth/csrf')['token']
            verifier = uuid.uuid4().hex + uuid.uuid4().hex
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
            launch = self.call(origin, '/api/apps/'+app+'/launch-code', {'redirectUri': link,
                'codeChallenge': challenge, 'codeChallengeMethod': 'S256'}, expected=(200, 403) if role != 'host.admin' else 200)
            if role != 'host.admin':
                if 'code' in launch and 'message' not in launch:
                    self.call(app_origin, '/api/auth/app-code', {'code': launch['code'], 'codeVerifier': verifier}, expected=403)
                return
            self.call(app_origin, '/api/auth/app-code', {'code': launch['code'], 'codeVerifier': verifier})
            context['diagnostic_secrets'].update(cookie.value for cookie in self.jar)

        def call(self, host, path, body=None, method=None, expected=200):
            headers = {'Content-Type': 'application/json', 'Origin': host}
            if self.csrf and host == origin: headers['X-Hosty-CSRF'] = self.csrf
            req = urllib.request.Request(host+path, data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers, method=method)
            try:
                with self.client.open(req, timeout=180) as response:
                    status, raw = response.status, response.read()
            except urllib.error.HTTPError as error:
                status, raw = error.code, error.read()
            value = json.loads(raw) if raw else None
            assert status in (expected if isinstance(expected, tuple) else (expected,)), (path, status, {key: value.get(key) for key in ('code', 'message')} if isinstance(value, dict) else None)
            return value

        def harness(self, path, body=None, method=None, expected=200):
            return self.call(app_origin, '/api'+path, body, method, expected)

    # Source preparation is independent of runtime state. These fixtures stay stopped and use
    # an already-built local image so source admission needs no registry/provider credentials.
    image = next(service for service in manifest['services'] if service['key'] == 'api')['runtimes']['docker']['image']
    def install_source_fixture(relative, repository, override_id=None, source=True):
        value = json.loads((workspace/relative).read_text())
        if override_id:
            value['id'] = override_id
            value.pop('agent', None)  # This synthetic app has no published skill identity.
        if source: value['source']['repository'] = repository
        else: value.pop('source', None)
        for service in value['services']:
            for runtime in service['runtimes'].values():
                if 'image' in runtime: runtime['image'] = image
        # This fixture relocates the manifest; preserve its portable skill packages beside it.
        for skill in value.get('agent', {}).get('skills', []):
            shutil.copytree((workspace/relative).parent/skill['path'], base/skill['path'], dirs_exist_ok=True)
        target = base/(value['id']+'-manifest.json')
        target.write_text(json.dumps(value))
        run([cli, '--data-root', root, 'apps', 'install', target, '--runtime', 'docker', '--no-autostart'])
        return value['id']
    stopped_app = install_source_fixture('apps/demo-app/manifest.json', context['repository'])
    no_source_app = install_source_fixture('apps/demo-app/manifest.json', context['repository'], 'test.context.no-source', False)
    another_remote = context['remote']/'context-other.git'
    run(['git', 'clone', '--bare', str(context['remote']), str(another_remote)])
    run(['git', '--git-dir', str(another_remote), 'update-server-info'])
    another_repository = context['repository'].removesuffix('/.git')+'/context-other.git'
    another_app = install_source_fixture('apps/marketplace/manifest.json', another_repository)
    assert app_summary(stopped_app)['runtimeState'] == 'stopped'
    owner = Browser('activation-fixture@example.test', 'Owner')
    member = Browser('workspace-member@example.test', 'Member', invited=True)
    outsider = Browser('workspace-outsider@example.test', 'Outsider', invited=True)
    Browser('workspace-ordinary@example.test', 'Ordinary user', invited=True, role='host.user')
    say('PASS: ordinary password user cannot enter administrator-only Harness; no service-user fallback')
    preferences = owner.harness('/preferences/prompt-suggestions')
    assert preferences == {'enabled':True, 'revision':0}
    saved = owner.harness('/preferences/prompt-suggestions', {'enabled':False, 'revision':0}, method='PUT')
    assert saved == {'enabled':False, 'revision':1}
    assert member.harness('/preferences/prompt-suggestions') == {'enabled':True, 'revision':0}
    assert owner.harness('/preferences/prompt-suggestions', {'enabled':True, 'revision':0}, method='PUT', expected=409)['code'] == 'preference_changed'
    say('PASS: personal suggestion preferences are isolated and reject stale writes')
    first = owner.harness('/sessions', {'title': 'Owner implementation'})
    harness_history(context, owner, member, first)
    def action(browser, session, kind, **payload):
        return browser.harness('/sessions/'+session['id']+'/workspaces', {'action': kind, **payload})
    tree = action(owner, first, 'prepare', requestId=str(uuid.uuid4()), appId=stopped_app, targetBranch='main')
    same_repository = action(owner, first, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
    assert same_repository['id'] == tree['id'] and same_repository['path'] == tree['path']
    for unavailable, expected_code in [(no_source_app, 'workspace_source_missing'), ('missing.context.app', 'workspace_app_missing')]:
        denied = owner.harness('/sessions/'+first['id']+'/workspaces',
            {'action': 'prepare', 'appId': unavailable, 'requestId': str(uuid.uuid4())}, expected=409)
        assert denied['code'] == expected_code, denied.get('code')
    assert app_summary(stopped_app)['runtimeState'] == 'stopped'
    assert owner.harness('/sessions/'+first['id'])['appIds'] == []
    original_runtime = app_summary(app)['runtimeState']
    context_input = {'appIds': [app], 'expectedRevision': 0, 'requestId': str(uuid.uuid4())}
    changed = action(owner, first, 'context-add', **context_input)
    assert changed['current']['appIds'] == [app] and changed['outcome']['revision'] == 1
    assert action(owner, first, 'context-list')['revision'] == 1
    assert any(row['id'] == app for row in action(owner, first, 'context-search', search=app)['apps'])
    owner.harness('/sessions/'+first['id']+'/apps', {'appIds': [], 'expectedRevision': 1}, method='PUT')
    replay = action(owner, first, 'context-add', **context_input)
    assert replay['replayed'] and replay['outcome']['appIds'] == [app] and replay['current']['appIds'] == []
    assert app_summary(app)['runtimeState'] == original_runtime
    say('PASS: empty chat prepares source without attachment; context tools preserve manual removal on replay and do not change runtime')
    workspace_id = tree['workspaceId']
    participants_path = '/development-workspaces/'+workspace_id+'/participants'
    state = owner.harness(participants_path)
    member.harness(participants_path)
    assert outsider.harness('/development-workspaces/'+workspace_id+'/worktrees/'+tree['id'])['id'] == tree['id']
    creation = {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']}
    second = member.harness('/workspace-sessions', creation)
    assert member.harness('/workspace-sessions', creation)['id'] == second['id']
    assert second['status'] == 'idle'
    shared = action(member, second, 'list')['workspaces']
    assert len(shared) == 1 and shared[0]['id'] == tree['id'] and shared[0]['path'] == tree['path']
    assert shared[0]['branch'] == tree['branch'] and shared[0].get('sourceGrant') is None
    cleared = action(member, second, 'context-remove', appIds=second.get('appIds', []),
        expectedRevision=second.get('appContextRevision', 0), requestId=str(uuid.uuid4()))
    assert cleared['current']['appIds'] == []
    assert action(member, second, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')['id'] == tree['id']
    added = action(member, second, 'context-add', appIds=[app, another_app],
        expectedRevision=cleared['current']['revision'], requestId=str(uuid.uuid4()))
    assert added['current']['appIds'] == [app, another_app]
    other_tree = action(member, second, 'prepare', requestId=str(uuid.uuid4()), appId=another_app, targetBranch='main')
    assert other_tree['id'] != tree['id'] and other_tree['workspaceId'] == tree['workspaceId']
    assert action(owner, first, 'prepare', requestId=str(uuid.uuid4()), appId=another_app, targetBranch='main')['id'] == other_tree['id']
    say('PASS: any authorized participant can add an installed repository to the selected workspace without creator approval')
    member.harness('/sessions/'+second['id'], {'title': 'Member review'}, method='PATCH')
    state = member.harness(participants_path)
    assert next(row for row in state['sessions'] if row['sessionId'] == second['id'])['title'] == 'Member review'
    assert all(not row['canOpen'] and not row.get('viewerPath') for row in state['sessions'] if row['userId'] == owner.user)
    for suffix in ['', '/events', '/models', '/retention', '/attachments/missing.txt']:
        member.harness('/sessions/'+first['id']+suffix, expected=404)
    member.harness('/sessions/'+first['id'], {'title': 'overwrite'}, method='PATCH', expected=404)
    outsider.harness('/sessions/'+second['id'], expected=404)
    assert all(row['id'] != first['id'] for row in member.harness('/sessions')['sessions'])
    # Authorized native edits target the one registered fixture directory. They do not simulate
    # provider completion or imply automatic same-file conflict protection.
    source = pathlib.Path(tree['path'])
    (source/'owner-acceptance.txt').write_text('owner edit\n')
    (source/'member-acceptance.txt').write_text('member edit\n')
    diff = action(member, second, 'diff', workspaceId=tree['id'], path='owner-acceptance.txt')
    assert 'owner edit' in diff['combined']
    diff = action(owner, first, 'diff', workspaceId=tree['id'], path='member-acceptance.txt')
    assert 'member edit' in diff['combined']
    say('PASS: three password logins, collection authority, one directory/branch, idle idempotent session creation, cross-user route privacy and shared edits')
    assert action(member, second, 'status', workspaceId=tree['id'])['id'] == tree['id']
    empty = outsider.harness('/sessions', {'title': 'Collection operator without a primary workspace'})
    inventory = action(outsider, empty, 'workspace-inventory')
    assert any(item['id'] == workspace_id for item in inventory['workspaces'])
    assert (source/'owner-acceptance.txt').read_text() == 'owner edit\n'
    member.harness('/sessions/'+second['id'], method='DELETE')
    owner.harness('/sessions/'+first['id'], method='DELETE')
    state = owner.harness(participants_path)
    assert not any(row['attached'] for row in state['sessions'])
    assert source.exists() and (source/'member-acceptance.txt').exists()
    third = owner.harness('/workspace-sessions', {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']})
    assert next(row for row in action(owner, third, 'list')['workspaces'] if row['id'] == tree['id'])['path'] == str(source)
    say('PASS: all-workspace access survives creator-chat deletion; deleting both chats preserves dirty source; sessionless workspace accepts a new idle chat')
    # External allocation can host private assistant sessions without becoming a synthetic chat.
    # Pause must still retain the independent external lease until its verified recovery.
    development = request('/api/core/development')
    external_source = request('/api/core/source', {'revision': development['source']['revision'], 'overridePath': None,
        'repository': {'repositoryUrl': context['repository'], 'ref': 'main', 'projectPath': context['project'], 'connectionId': None}}, method='PUT', confirm_settings=True)
    lease = str(uuid.uuid4())
    external = request('/api/core/source/workspaces', {'requestId': str(uuid.uuid4()), 'taskId': 'external-pause-fixture', 'leaseId': lease,
        'sourceRevision': external_source['revision'], 'targetBranch': 'main', 'label': 'External pause fixture', 'principalLabel': 'Pause acceptance'})
    external_path = '/development-workspaces/'+external['workspaceId']
    external_file = pathlib.Path(external['path'])/'retained-pause.txt'
    external_file.write_text('unfinished external work\n')
    external_participants = external_path+'/participants'
    state = owner.harness(external_participants)
    assert state['sessions'] == []
    def external_session(browser, title):
        state = browser.harness(external_participants)
        command = {'requestId': str(uuid.uuid4()), 'workspaceId': external['workspaceId'], 'expectedRevision': state['revision']}
        session = browser.harness('/workspace-sessions', command)
        assert browser.harness('/workspace-sessions', command)['id'] == session['id']
        assert session['status'] == 'idle'
        browser.harness('/sessions/'+session['id'], {'title': title}, method='PATCH')
        shared = action(browser, session, 'list')['workspaces']
        assert len(shared) == 1 and shared[0]['id'] == external['id']
        assert shared[0]['path'] == external['path'] and shared[0]['branch'] == external['branch']
        assert lease in shared[0]['leases']
        return session
    internal_first = external_session(owner, 'External implementation')
    internal_second = external_session(owner, 'External review')
    internal_foreign = external_session(member, 'Private external review')
    aggregate = next(w for w in owner.harness('/development-workspaces')['workspaces'] if w['id'] == external['workspaceId'])
    assert aggregate['owner']['kind'] == 'external'
    roster = aggregate['participation']['sessions']
    assert len(roster) == 3 and sum(s['canOpen'] for s in roster) == 2
    assert all(not s['canOpen'] and not s.get('viewerPath') for s in roster if s['userId'] == member.user)
    member.harness('/sessions/'+internal_first['id'], expected=404)
    owner.harness('/sessions/'+internal_foreign['id'], expected=404)
    assert 'unfinished external work' in action(owner, internal_first, 'diff', workspaceId=external['id'], path=external_file.name)['combined']
    state = owner.harness(external_participants)
    action(owner, internal_first, 'detach', workspaceId=external['workspaceId'], requestId=str(uuid.uuid4()), expectedRevision=state['revision'])
    assert action(owner, internal_first, 'list')['workspaces'] == []
    owner.harness('/sessions/'+internal_second['id'], method='DELETE')
    assert action(member, internal_foreign, 'list')['workspaces'][0]['path'] == external['path']
    member.harness('/sessions/'+internal_foreign['id'], method='DELETE')
    assert external_file.read_text() == 'unfinished external work\n'
    assert lease in owner.harness(external_path+'/worktrees/'+external['id'])['leases']
    say('PASS: external allocation hosts independent idle chats; exact creation replay, shared dirty source, private routes and detach/delete preserve external lease and source')
    workflow = owner.harness(external_path+'/workflow')
    pause = {'requestId': str(uuid.uuid4()), 'expectedRevision': workflow['revision']}
    refusal = owner.harness(external_path+'/workflow/pause', pause, expected=409)
    assert refusal['code'] == 'workspace_in_use', refusal.get('code')
    workflow = owner.harness(external_path+'/workflow')
    assert workflow['closure'] == 'closing'
    assert next(op for op in workflow['operations'] if op['id'] == pause['requestId'])['state'] == 'pending'
    detail = owner.harness(external_path+'/worktrees/'+external['id'])
    recovery = {'requestId': str(uuid.uuid4()), 'expectedHead': detail['observation']['head'], 'leaseId': lease, 'consumerExitConfirmed': True}
    owner.harness(external_path+'/worktrees/'+external['id']+'/recover-lease', recovery)
    closed = owner.harness(external_path+'/workflow/pause', pause)
    assert closed['closure'] == 'closed'
    assert next(op for op in closed['operations'] if op['id'] == pause['requestId'])['state'] == 'succeeded'
    assert owner.harness(external_path+'/workflow/pause', pause)['closure'] == 'closed'
    assert external_file.read_text() == 'unfinished external work\n'
    say('PASS: external pause reaches Core lease refusal; verified recovery finishes the original request and retains dirty source')
    completed = owner.harness('/sessions', {'title': 'Completed cleanup candidate'})
    completed_tree = action(owner, completed, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
    completed_workflow = action(owner, completed, 'workflow-status')
    verified = action(owner, completed, 'workflow-complete', requestId=str(uuid.uuid4()), expectedRevision=completed_workflow['revision'])
    assert verified['state'] == 'completed'
    inventory = action(outsider, empty, 'workspace-inventory')
    # A conditional maintenance task applies its own requested predicate before invoking Delete.
    selected = [row['id'] for row in inventory['workspaces'] if (row.get('workflow') or {}).get('state') == 'completed']
    assert selected == [completed_tree['workspaceId']]
    conditional = action(outsider, empty, 'delete-workspace', requestId=str(uuid.uuid4()), workspaceIds=selected)
    assert all(item['state'] == 'removed' for item in conditional['targets'])
    assert source.exists() and external_file.exists(), 'Conditional cleanup removed unfinished candidates'
    owner.harness('/sessions/'+completed['id'], method='DELETE')
    say('PASS: completed-and-merged cleanup selects only verified completion and preserves unfinished/unknown candidates')
    if '--hold-ui' in context['sys'].argv:
        owner.harness('/sessions/'+third['id'], {'title': 'Implementation'}, method='PATCH')
        owner.harness('/sessions', {'title': 'Standalone chat'})
        retained = owner.harness('/sessions', {'title': 'Retained workspace', 'appIds': [app]})
        retained_tree = action(owner, retained, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
        owner.harness('/sessions/'+retained['id'], method='DELETE')
        state = owner.harness(participants_path)
        colleague = member.harness('/workspace-sessions', {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']})
        member.harness('/sessions/'+colleague['id'], {'title': 'Private member review'}, method='PATCH')
        development = request('/api/core/development')
        source_settings = request('/api/core/source', {'revision': development['source']['revision'], 'overridePath': None,
            'repository': {'repositoryUrl': context['repository'], 'ref': 'main', 'projectPath': context['project'], 'connectionId': None}}, method='PUT', confirm_settings=True)
        external_lease = str(uuid.uuid4())
        external = request('/api/core/source/workspaces', {'requestId': str(uuid.uuid4()), 'taskId': 'navigation-external-fixture', 'leaseId': external_lease,
            'sourceRevision': source_settings['revision'], 'targetBranch': 'main', 'label': 'External checkout', 'principalLabel': 'Navigation acceptance'})
        (pathlib.Path(external['path'])/'delete-ui-fixture.txt').write_text('Disposable unfinished source for Delete UI acceptance.\n')
        shell = json.loads((workspace/'apps/shell/manifest.json').read_text())
        shell['services'][0]['runtimes']['docker']['image'] = 'hosty-shell-acceptance:local'
        shell_manifest = base/'shell-manifest.json'
        shell_manifest.write_text(json.dumps(shell))
        run([cli, '--data-root', root, 'apps', 'install', shell_manifest, '--runtime', 'docker', '--no-autostart'])
        run([cli, '--data-root', root, 'apps', 'start', 'hosty.shell'])
        wait_for(lambda: request('/api/apps/hosty.shell/health')['status'] == 'healthy', 120)
        shell_summary = next(a for a in request('/api/apps')['apps'] if a['id'] == 'hosty.shell')
        shell_endpoint = next(e for e in shell_summary['endpoints'] if e['key'] == 'web')
        shell_link = shell_endpoint.get('browserOrigin') or shell_endpoint.get('publicOrigin') or shell_endpoint['url']
        # Test-only credentials live in the owned fixture, never logs or repository artifacts.
        access = base/'browser-access.json'
        access.write_text(json.dumps({'core': origin, 'url': link, 'email': 'activation-fixture@example.test',
            'password': password, 'sessionId': third['id'], 'workspaceId': workspace_id, 'shell': shell_link, 'retainedWorkspaceId': retained_tree['workspaceId'], 'externalWorkspaceId': external['workspaceId']}))
        os.chmod(access, 0o600)
        say('UI READY: '+str(access)+'; create '+str(base/'finish-ui')+' after browser checks')
        deadline = time.time()+1200
        while time.time() < deadline and not (base/'finish-ui').exists(): time.sleep(.5)
        assert (base/'finish-ui').exists(), 'Browser acceptance did not acknowledge completion'
        access.unlink()
    # This fixture owns every child-Core workspace. Dirty source and a live activity claim
    # are consequences to display, not separate confirmations or workflow prerequisites.
    removed = outsider.harness('/development-workspaces/'+workspace_id+'/delete', {'requestId': str(uuid.uuid4())})
    assert removed['state'] == 'removed', removed.get('error')
    assert not source.exists()
    batch_request = {'requestId': str(uuid.uuid4()), 'all': True}
    batch = outsider.harness('/development-workspaces/delete', batch_request)
    assert batch['targets'] and all(item['state'] == 'removed' for item in batch['targets']), batch
    later = owner.harness('/sessions', {'title': 'Created after batch acceptance'})
    later_tree = action(owner, later, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
    replay = outsider.harness('/development-workspaces/delete', batch_request)
    assert [item['workspaceId'] for item in replay['targets']] == [item['workspaceId'] for item in batch['targets']]
    assert pathlib.Path(later_tree['path']).exists()
    final_delete = action(outsider, empty, 'delete-workspace', workspaceId=later_tree['workspaceId'], requestId=str(uuid.uuid4()))
    assert final_delete['state'] == 'removed'
    say('PASS: another operator deletes dirty active source with one request; bulk replay preserves later workspaces; sessionless collection Delete uses the same backend')
    say('Provider prompts were not dispatched; no provider credentials were copied into this sandbox')

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
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    app = 'hosty.harness'
    manifest = json.loads((workspace/'apps/harness/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
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
        def __init__(self, email, name, invited=False):
            self.jar = http.cookiejar.CookieJar()
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
            self.csrf = None
            if invited:
                invitation = request('/api/auth/invitations', {'email': email, 'displayName': name, 'role': 'host.admin'}, confirm_settings=True)
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
            code = self.call(origin, '/api/apps/'+app+'/launch-code', {'redirectUri': link,
                'codeChallenge': challenge, 'codeChallengeMethod': 'S256'})['code']
            self.call(app_origin, '/api/auth/app-code', {'code': code, 'codeVerifier': verifier})
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
            assert status == expected, (path, status, value.get('code') if isinstance(value, dict) else None)
            return value

        def harness(self, path, body=None, method=None, expected=200):
            return self.call(app_origin, '/api'+path, body, method, expected)

    owner = Browser('activation-fixture@example.test', 'Owner')
    member = Browser('workspace-member@example.test', 'Member', invited=True)
    outsider = Browser('workspace-outsider@example.test', 'Outsider', invited=True)
    first = owner.harness('/sessions', {'title': 'Owner implementation', 'appIds': [app]})
    def action(browser, session, kind, **payload):
        return browser.harness('/sessions/'+session['id']+'/workspaces', {'action': kind, **payload})
    tree = action(owner, first, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
    workspace_id = tree['workspaceId']
    participants_path = '/development-workspaces/'+workspace_id+'/participants'
    state = owner.harness(participants_path)
    member.harness(participants_path, expected=403)
    outsider.harness('/development-workspaces/'+workspace_id+'/worktrees/'+tree['id'], expected=403)
    state = owner.harness(participants_path+'/grant', {'requestId': str(uuid.uuid4()), 'expectedRevision': state['revision'],
        'userId': member.user, 'worktreeIds': [tree['id']]})
    creation = {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']}
    second = member.harness('/workspace-sessions', creation)
    assert member.harness('/workspace-sessions', creation)['id'] == second['id']
    assert second['status'] == 'idle'
    shared = action(member, second, 'list')['workspaces']
    assert len(shared) == 1 and shared[0]['id'] == tree['id'] and shared[0]['path'] == tree['path']
    assert shared[0]['branch'] == tree['branch'] and shared[0].get('sourceGrant') is None
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
    say('PASS: three password logins, explicit sharing, one directory/branch, idle idempotent session creation, cross-user route privacy and shared edits')
    state = owner.harness(participants_path)
    owner.harness(participants_path+'/revoke', {'requestId': str(uuid.uuid4()), 'expectedRevision': state['revision'], 'userId': member.user})
    member.harness(participants_path, expected=403)
    assert member.harness('/sessions/'+second['id']+'/workspaces', {'action': 'list'})['workspaces'] == []
    member.harness('/sessions/'+second['id']+'/workspaces', {'action': 'status', 'workspaceId': tree['id']}, expected=403)
    assert (source/'owner-acceptance.txt').read_text() == 'owner edit\n'
    member.harness('/sessions/'+second['id'], method='DELETE')
    owner.harness('/sessions/'+first['id'], method='DELETE')
    state = owner.harness(participants_path)
    assert not any(row['attached'] for row in state['sessions'])
    assert source.exists() and (source/'member-acceptance.txt').exists()
    third = owner.harness('/workspace-sessions', {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']})
    assert action(owner, third, 'list')['workspaces'][0]['path'] == str(source)
    say('PASS: revocation fences reads; deleting both chats preserves dirty source; sessionless workspace accepts a new idle chat')
    # External work has no participant roster. Pause must still reach Core's lease checks,
    # and recovering a verified stopped fixture lease must finish the original request.
    development = request('/api/core/development')
    external_source = request('/api/core/source', {'revision': development['source']['revision'], 'overridePath': None,
        'repository': {'repositoryUrl': context['repository'], 'ref': 'main', 'projectPath': context['project'], 'connectionId': None}}, method='PUT', confirm_settings=True)
    lease = str(uuid.uuid4())
    external = request('/api/core/source/workspaces', {'requestId': str(uuid.uuid4()), 'taskId': 'external-pause-fixture', 'leaseId': lease,
        'sourceRevision': external_source['revision'], 'targetBranch': 'main', 'label': 'External pause fixture', 'principalLabel': 'Pause acceptance'})
    external_path = '/development-workspaces/'+external['workspaceId']
    external_file = pathlib.Path(external['path'])/'retained-pause.txt'
    external_file.write_text('unfinished external work\n')
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
    if '--hold-ui' in context['sys'].argv:
        owner.harness('/sessions/'+third['id'], {'title': 'Implementation'}, method='PATCH')
        owner.harness('/sessions', {'title': 'Standalone chat'})
        retained = owner.harness('/sessions', {'title': 'Retained workspace', 'appIds': [app]})
        retained_tree = action(owner, retained, 'prepare', requestId=str(uuid.uuid4()), appId=app, targetBranch='main')
        owner.harness('/sessions/'+retained['id'], method='DELETE')
        state = owner.harness(participants_path)
        state = owner.harness(participants_path+'/grant', {'requestId': str(uuid.uuid4()), 'expectedRevision': state['revision'], 'userId': member.user, 'worktreeIds': [tree['id']]})
        colleague = member.harness('/workspace-sessions', {'requestId': str(uuid.uuid4()), 'workspaceId': workspace_id, 'expectedRevision': state['revision']})
        member.harness('/sessions/'+colleague['id'], {'title': 'Private member review'}, method='PATCH')
        development = request('/api/core/development')
        source_settings = request('/api/core/source', {'revision': development['source']['revision'], 'overridePath': None,
            'repository': {'repositoryUrl': context['repository'], 'ref': 'main', 'projectPath': context['project'], 'connectionId': None}}, method='PUT', confirm_settings=True)
        external_lease = str(uuid.uuid4())
        external = request('/api/core/source/workspaces', {'requestId': str(uuid.uuid4()), 'taskId': 'navigation-external-fixture', 'leaseId': external_lease,
            'sourceRevision': source_settings['revision'], 'targetBranch': 'main', 'label': 'External checkout', 'principalLabel': 'Navigation acceptance'})
        request('/api/development/workspaces/'+external['id']+'/operations/release-lease', {'requestId': str(uuid.uuid4()), 'leaseId': external_lease})
        shell_manifest = workspace/'apps/shell/manifest.json'
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
    say('Provider prompts were not dispatched; no provider credentials were copied into this sandbox')

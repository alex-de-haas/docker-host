"""Repository PR acceptance through normal identity in a Core-managed child environment.

Uses a test-only provider executable; never copies production credentials or calls real GitHub.
--hold-ui retains this disposable environment for browser verification until finish-ui exists.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
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
    manifest['source']['repository'] = 'https://github.com/hosty-fixture/shared.git'
    for service in manifest['services']:
        service['runtimes']['docker']['image'] = 'hosty-harness-'+service['key']+'-acceptance:local'
    def install(value):
        path = base/(value['id']+'.json'); path.write_text(json.dumps(value))
        run([cli, '--data-root', root, 'apps', 'install', path, '--runtime', 'docker', '--no-autostart'])
    install(manifest)
    run([cli, '--data-root', root, 'apps', 'start', app])
    wait_for(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    for id, repo in [('thirdparty.pr.monorepo', 'shared'), ('thirdparty.pr.denied', 'denied')]:
        fixture = json.loads((workspace/'apps/demo-app/manifest.json').read_text())
        fixture['id'] = id; fixture.pop('agent', None)
        fixture['source']['repository'] = 'https://github.com/hosty-fixture/'+repo+'.git'
        for service in fixture['services']:
            for runtime in service['runtimes'].values():
                if 'image' in runtime: runtime['image'] = 'hosty-harness-api-acceptance:local'
        install(fixture)
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

    owner = Browser('activation-fixture@example.test', 'Owner')
    other = Browser('pr-other@example.test', 'Other', invited=True)
    Browser('pr-member@example.test', 'Member', invited=True, role='host.user')
    connection = owner.call(origin, '/api/source-connections/pat', {'provider':'github', 'label':'Acceptance provider', 'token':'hosty-pr-fixture-alice'})
    other.call(origin, '/api/source-connections/pat', {'provider':'github', 'label':'Denied provider', 'token':'hosty-pr-fixture-bob'})
    owner.harness('/pull-requests/repositories')
    other.harness('/pull-requests/repositories')
    wait_for(lambda: len(owner.harness('/pull-requests')['items']) == 2, 90)
    inventory = owner.harness('/pull-requests/repositories')
    assert len(inventory['repositories']) == 1, inventory
    repo = inventory['repositories'][0]
    assert {a['id'] for a in repo['apps']} == {app, 'thirdparty.pr.monorepo'}
    wait_for(lambda: any(c['state']=='access_denied' for c in owner.harness('/pull-requests/repositories')['coverage']), 60)
    page = owner.harness('/pull-requests?bot=true')
    assert len(page['items']) == 1 and page['items'][0]['number'] == 12
    wait_for(lambda: owner.harness('/pull-requests?bot=true')['items'][0]['checks']['completeness'] == 'complete', 90)
    page = owner.harness('/pull-requests?bot=true')
    assert page['items'][0]['reference']['schemaVersion'] == 1
    assert owner.harness('/sessions')['sessions'] == []
    assert other.harness('/pull-requests')['items'] == []
    other.harness('/pull-requests/'+repo['id']+'/12', expected=404)
    detail = owner.harness('/pull-requests/'+repo['id']+'/12')
    assert detail['description'] and detail['links'] == []
    checks = owner.harness('/pull-requests/'+repo['id']+'/12/checks')
    assert {c['state'] for c in checks['items']} == {'passed', 'running', 'skipped'}
    review = owner.harness('/pull-requests/'+repo['id']+'/12/review')
    assert review['items'][0]['state'] == 'unresolved'
    pr = detail['pullRequest']
    diff = owner.harness('/pull-requests/'+repo['id']+'/12/diff?head='+pr['head']+'&base='+pr['base'])
    assert diff['head'] == pr['head'] and len(diff['files']) == 1
    owner.harness('/pull-requests/'+repo['id']+'/12/diff?head='+('c'*40)+'&base='+pr['base'], expected=409)
    # A direct API consumer uses the same normal administrator session and one-use Core SSE handle.
    scope = {'allInstalled':True, 'pullRequests':[{'repositoryId':repo['id'], 'number':12}]}
    ticket = owner.call(origin, '/api/pull-requests/subscriptions', scope)
    with owner.client.open(origin+'/api/pull-requests/events?subscriptionId='+ticket['id'], timeout=20) as stream:
        frame = b''
        while b'\n\n' not in frame: frame += stream.readline()
        assert b'event: stream.ready' in frame, frame
    owner.call(origin, '/api/pull-requests/events?subscriptionId='+ticket['id'], expected=409)
    # Exercise writes only against the test provider's separate PR; keep #12 for the browser journey.
    action_path = '/pull-requests/'+repo['id']+'/13/actions'
    capability = owner.harness(action_path)
    assert capability['updateBranch']['enabled'] and not capability['merge']['enabled']
    other.harness(action_path, expected=404)
    command = {'requestId':str(uuid.uuid4()), 'action':'update-branch', 'head':capability['head'], 'base':capability['base']}
    assert owner.harness(action_path, command)['state'] == 'pending'
    assert owner.harness(action_path)['pendingCommand']['requestId'] == command['requestId']
    assert owner.harness(action_path+'/recover', command)['state'] == 'updated'
    capability = owner.harness(action_path)
    assert capability['merge']['enabled'] and not capability['updateBranch']['enabled']
    command = {'requestId':str(uuid.uuid4()), 'action':'merge', 'head':capability['head'], 'base':capability['base']}
    assert owner.harness(action_path, command)['state'] == 'merged'
    assert owner.harness(action_path, command)['state'] == 'merged'
    owner.harness(action_path, {**command, 'head':'f'*40}, expected=409)
    say('PASS: actor-bound PR actions through Harness, accepted branch update, durable recovery, merge, replay and conflicting request denial (fixture provider only)')
    say('PASS: installed monorepo deduplication, stopped app, Dependabot, detailed checks/review/exact-head diff, cross-user denial and independent scoped SSE consumer')
    if '--hold-ui' in context['sys'].argv:
        shell = json.loads((workspace/'apps/shell/manifest.json').read_text())
        shell['source']['repository'] = 'https://github.com/hosty-fixture/shared.git'
        shell['services'][0]['runtimes']['docker']['image'] = 'hosty-shell-acceptance:local'
        install(shell); run([cli, '--data-root', root, 'apps', 'start', shell['id']])
        wait_for(lambda: request('/api/apps/'+shell['id']+'/health')['status'] == 'healthy', 180)
        shell_record = next(a for a in request('/api/apps')['apps'] if a['id'] == shell['id'])
        shell_endpoint = next(e for e in shell_record['endpoints'] if e['key'] == 'web')
        shell_link = shell_endpoint.get('browserOrigin') or shell_endpoint.get('publicOrigin') or shell_endpoint['url']
        access = base/'browser-access.json'
        access.write_text(json.dumps({'core':origin,'url':link,'shell':shell_link,'email':'activation-fixture@example.test','password':password,'repositoryId':repo['id']}))
        os.chmod(access, 0o600)
        say('UI READY: '+str(access)+'; create '+str(base/'finish-ui')+' after browser checks')
        deadline = time.time()+1200
        while time.time()<deadline and not (base/'finish-ui').exists(): time.sleep(.5)
        assert (base/'finish-ui').exists(), 'Browser acceptance did not acknowledge completion'
        access.unlink()
    owner.call(origin, '/api/source-connections/'+connection['id'], method='DELETE')
    assert owner.harness('/pull-requests')['items'] == []
    owner.harness('/pull-requests/'+repo['id']+'/12', expected=404)
    say('PASS: disconnected connection immediately hides cached descriptions and PR rows; parent owner will Finish the isolated sandbox')

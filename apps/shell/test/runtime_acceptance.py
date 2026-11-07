"""Docker Shell acceptance in a managed child Core with separate identity and source."""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid


def check(context):
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    manifest = json.loads((workspace/'apps/shell/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    # A test-only image name never replaces the operator's installed Shell image tag.
    manifest['services'][0]['runtimes']['docker']['image'] = 'hosty-shell-acceptance:local'
    target = base/'shell-manifest.json'
    target.write_text(json.dumps(manifest))
    shutil.copytree(workspace/'apps/shell/assets', base/'assets', dirs_exist_ok=True)
    run([cli, '--data-root', root, 'apps', 'install', target, '--runtime', 'docker', '--no-autostart'])
    began = time.monotonic()
    run([cli, '--data-root', root, 'apps', 'start', 'hosty.shell'])
    wait_for(lambda: request('/api/apps/hosty.shell/health')['status'] == 'healthy', 180)
    say('Shell healthy after '+str(round(time.monotonic()-began, 2))+' seconds')
    shell_origin = wait_for(lambda: request('/control/v1/core/status', control=True)['shellPublicOrigin'])
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', 'hosty.shell',
        '--redirect-uri', shell_origin+'/dashboard', '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(host, route, body=None, csrf=None):
        headers = {'Content-Type':'application/json','Origin':host}
        if csrf: headers['X-Hosty-CSRF'] = csrf
        with client.open(urllib.request.Request(host+route, data=json.dumps(body).encode() if body is not None else None, headers=headers), timeout=60) as response:
            return json.load(response)
    form = urllib.parse.urlencode({'email':'activation-fixture@example.test','password':password,'returnTo':'/account/tokens'}).encode()
    with client.open(urllib.request.Request(origin+'/login', data=form,
        headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response: response.read()
    assert call(origin, '/api/auth/session')['authenticated']
    csrf = call(origin, '/api/auth/csrf')['token']
    verifier = uuid.uuid4().hex + uuid.uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    code = call(origin, '/api/apps/hosty.shell/launch-code',
        {'redirectUri':link,'codeChallenge':challenge,'codeChallengeMethod':'S256'}, csrf)['code']
    call(app_origin, '/api/auth/app-code', {'code':code,'codeVerifier':verifier})
    assert call(app_origin, '/api/core/api/auth/session')['authenticated']
    # Review fixture workspace metadata and update-source access through the ordinary Core approval page.
    # No user data, provider permission or ordinary Core grant participates in this test.
    review = request('/api/installations', {'permissionsAppId':'hosty.shell'})
    request('/api/installations/'+review['id']+'/submit', {})
    review_path = '/install/confirm/'+review['id']
    with context['browser'].open(origin+review_path, timeout=30) as page:
        html = page.read().decode()
    nonce = re.search(r'name=nonce value="([^"]+)"', html)
    assert nonce and all(permission in html for permission in ['apps.workspaces.read', 'apps.sources.full']), 'Missing fixture source permission review'
    context['diagnostic_secrets'].add(nonce.group(1))
    decision = urllib.parse.urlencode([('nonce',nonce.group(1)), ('decision','approve'),
        ('optionalPermission','apps.workspaces.read'), ('optionalPermission','apps.sources.full')]).encode()
    with context['browser'].open(urllib.request.Request(origin+review_path, data=decision,
        headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response: response.read()
    wait_for(lambda: request('/api/installations/'+review['id'])['status'] == 'succeeded')
    assert isinstance(call(app_origin, '/api/core/api/apps/execution-targets')['apps'], list)
    assert isinstance(call(app_origin, '/api/core/api/development/activation-workspaces')['workspaces'], list)
    say('PASS: Docker Shell, password login, Core launch identity and both workspace inventory endpoints')

    # Exercise storage through Shell's own authenticated management facade. Synthetic files
    # belong only to this managed child; Finish removes them with the rest of the fixture.
    cache = root/'apps'/'hosty.shell'/'cache'
    cache.mkdir(parents=True, exist_ok=True)
    (cache/'storage-acceptance.bin').write_bytes(b's' * 8192)
    unknown = root/'storage-acceptance-unclassified'
    unknown.mkdir()
    (unknown/'payload.bin').write_bytes(b'u' * 3072)
    outside = base/'storage-acceptance-outside'
    outside.mkdir()
    (outside/'excluded.bin').write_bytes(b'x' * 65536)
    (root/'storage-acceptance-link').symlink_to(outside, target_is_directory=True)
    state = call(app_origin, '/api/core/api/storage')
    assert state['snapshot'] is None and not state['isScanning'], 'Storage GET started acquisition'
    storage_csrf = call(app_origin, '/api/core/api/auth/csrf')['token']
    context['diagnostic_secrets'].add(storage_csrf)
    storage_request = {'requestId':str(uuid.uuid4())}
    call(app_origin, '/api/core/api/storage/refresh', storage_request, storage_csrf)
    def storage_complete():
        current = call(app_origin, '/api/core/api/storage')
        assert not current.get('lastError'), 'Storage acquisition failed'
        return current if current['snapshot'] is not None and not current['isScanning'] else None
    state = wait_for(storage_complete, 90)
    snapshot = state['snapshot']
    assert snapshot['excludedSymlinkCount'] >= 1
    assert any(resource['category'] == 'apps' and resource['appId'] == 'hosty.shell'
        and resource['logicalBytes'] >= 8192 for resource in snapshot['resources'])
    assert any(resource['category'] == 'other' and
        resource['relativePath'] == 'storage-acceptance-unclassified' and
        resource['logicalBytes'] >= 3072 for resource in snapshot['resources'])
    assert not any(resource['relativePath'] == 'storage-acceptance-link'
        for resource in snapshot['resources'])
    assert snapshot['logicalBytes'] == sum(category['logicalBytes'] for category in snapshot['categories'])
    assert snapshot['logicalBytes'] == sum(resource['logicalBytes'] for resource in snapshot['resources'])
    if snapshot['allocatedBytes'] is not None:
        assert snapshot['allocatedBytes'] == sum(category['allocatedBytes'] for category in snapshot['categories'])
        assert snapshot['allocatedBytes'] == sum(resource['allocatedBytes'] for resource in snapshot['resources'])
    replay = call(app_origin, '/api/core/api/storage/refresh', storage_request, storage_csrf)
    assert not replay['isScanning'] and replay['snapshot']['id'] == snapshot['id']
    say('PASS: Shell storage permission, explicit refresh, cached replay, category totals, app cache, unknown files and excluded symlink')

    # This local fixture intentionally has no feed. The proxy must preserve the structured
    # absence code consumed by App Details, and migration reads must not alter the installation.
    before_source_read = next(app for app in request('/api/apps')['apps'] if app['id'] == 'hosty.shell')
    try:
        call(app_origin, '/api/core/api/apps/hosty.shell/feeds')
        raise AssertionError('An unbound installation unexpectedly acquired a feed')
    except urllib.error.HTTPError as error:
        assert json.load(error)['code'] == 'app_feeds_not_configured'
    suggestions = call(app_origin, '/api/core/api/apps/update-source/suggestions')['suggestions']
    assert not any(item['migration']['appId'] == 'hosty.shell' for item in suggestions)
    after_source_read = next(app for app in request('/api/apps')['apps'] if app['id'] == 'hosty.shell')
    for key in ['version', 'selectedRuntime', 'runtimeState', 'followedFeedId', 'installationId']:
        assert before_source_read.get(key) == after_source_read.get(key), key
    say('PASS: unbound feed state and source suggestions through authenticated Shell without installation changes')

    # A different authenticated client changes the managed inventory while Shell keeps one stream.
    # Payloads must contain final state without any inventory GET by the consumer.
    def stream_snapshot(stream, predicate):
        while True:
            line = stream.readline().decode().strip()
            if not line: continue
            if line != 'event: sandbox.snapshot': continue
            data = stream.readline().decode()
            assert data.startswith('data: '), data
            snapshot = json.loads(data[6:])
            if predicate(snapshot): return snapshot
    with client.open(app_origin+'/api/core/api/events?topics=sandboxes', timeout=60) as stream:
        initial_snapshot = stream_snapshot(stream, lambda data: True)
        assert initial_snapshot['environments'] == [] and 'instances' not in initial_snapshot
        sandbox = request('/api/core-environments', {'requestId':str(uuid.uuid4()), 'label':'SSE lifecycle QA', 'mode':'current'})
        def observed(state):
            return lambda data: any(item['id'] == sandbox['id'] and item['state'] == state for item in data['environments'])
        stream_snapshot(stream, observed('stopped'))
        try:
            for kind, state in [('start', 'running'), ('stop', 'stopped'), ('finish', 'finished')]:
                sandbox = request('/api/core-environments/'+sandbox['id']+'/operations/'+kind,
                    {'requestId':str(uuid.uuid4()), 'expectedRevision':sandbox['revision']})
                assert sandbox['state'] == state, sandbox
                stream_snapshot(stream, observed(state))
                if state == 'running':
                    assert sandbox['coreVersion'] == request('/control/v1/core/status', control=True)['version']
                    # Access remains available for an agent-created child before and after setup.
                    access_path = '/api/core/api/core-environments/'+sandbox['id']+'/access-link'
                    shell_csrf = call(app_origin, '/api/core/api/auth/csrf')['token']
                    context['diagnostic_secrets'].add(shell_csrf)
                    access = call(app_origin, access_path, {}, shell_csrf)
                    context['diagnostic_secrets'].add(access['token'])
                    child_origin = sandbox['previewUrl']
                    assert access['setupUrl'].startswith(child_origin+'/setup?setupToken=') and not access['recoveryUrl']
                    child_password = uuid.uuid4().hex+'aA1!'
                    context['diagnostic_secrets'].add(child_password)
                    first = call(child_origin, '/api/auth/bootstrap', {'setupToken':access['token'],
                        'email':'agent-admin@example.test', 'displayName':'Agent admin', 'password':child_password})['user']
                    access = call(app_origin, access_path, {}, shell_csrf)
                    context['diagnostic_secrets'].add(access['token'])
                    assert access['recoveryUrl'].startswith(child_origin+'/recovery?recoveryToken=') and not access['setupUrl']
                    recovery = {'recoveryToken':access['token'], 'email':'owner-admin@example.test',
                        'displayName':'Environment owner', 'password':child_password}
                    try:
                        call(origin, '/api/auth/recovery', recovery)
                        raise AssertionError('A child recovery token authorized its parent')
                    except urllib.error.HTTPError as error:
                        assert error.code == 404
                    second = call(child_origin, '/api/auth/recovery', recovery)['user']
                    assert second['id'] != first['id'] and second['role'] == 'host.admin'
                    try:
                        call(child_origin, '/api/auth/recovery', recovery)
                        raise AssertionError('Recovery token was reusable')
                    except urllib.error.HTTPError as error:
                        assert error.code == 404
                    # Exercise real password login for both accounts; recovery must preserve the agent.
                    for email, expected in [('agent-admin@example.test', first), ('owner-admin@example.test', second)]:
                        form = urllib.parse.urlencode({'email':email, 'password':child_password, 'returnTo':'/api/auth/session'}).encode()
                        with client.open(urllib.request.Request(child_origin+'/login', data=form,
                            headers={'Content-Type':'application/x-www-form-urlencoded','Origin':child_origin}), timeout=30) as response:
                            response.read()
                        assert call(child_origin, '/api/auth/session')['user']['id'] == expected['id']
                    assert call(origin, '/api/auth/session')['user']['email'] == 'activation-fixture@example.test'
                    say('PASS: Shell owner access, ordinary setup and recovery, two password logins, one-use and cross-instance rejection')

                    def child_resource():
                        history = request('/api/core/resources')['history']
                        return next((sample for frame in history[-1:] for sample in frame['services']
                                     if sample.get('environmentId') == sandbox['id']), None)
                    sample = wait_for(child_resource, 30)
                    assert sample['memoryBytes'] > 0 and sample['processIdentity']
                    assert 'ownerUserId' not in sample

            assert not pathlib.Path(root/'environments'/sandbox['id']).exists()
        finally:
            if sandbox['state'] != 'finished':
                current = request('/api/core-environments/'+sandbox['id'])
                request('/api/core-environments/'+sandbox['id']+'/operations/finish',
                    {'requestId':str(uuid.uuid4()), 'expectedRevision':current['revision']})
    with client.open(app_origin+'/api/core/api/events?topics=sandboxes', timeout=60) as stream:
        stream_snapshot(stream, observed('finished'))
    say('PASS: Shell SSE initial data, external create/start/stop/finish, reconnect and nested sandbox root removal')
    if review := os.environ.get('HOSTY_SHELL_BROWSER_REVIEW'):
        development = request('/api/core/development')
        source = request('/api/core/source', {'revision':development['source']['revision'], 'overridePath':None,
            'repository':{'repositoryUrl':context['repository'], 'ref':'main', 'projectPath':context['project'], 'connectionId':None}},
            method='PUT', confirm_settings=True)
        lease = str(uuid.uuid4())
        tree = request('/api/core/source/workspaces', {'requestId':str(uuid.uuid4()), 'taskId':'shell-refresh-acceptance',
            'leaseId':lease, 'sourceRevision':source['revision'], 'targetBranch':'main', 'name':'Verify Shell workspace refresh'})
        review_path = pathlib.Path(review)
        descriptor = os.open(review_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'origin':origin, 'appUrl':link, 'email':'activation-fixture@example.test', 'password':password,
                'dataRoot':str(root), 'pid':request('/api/core/development')['launch']['processId'],
                'worktree':tree['path'], 'workspaceId':tree['workspaceId']}, output)
        say('BROWSER_REVIEW_READY: '+str(review_path))
        continuation = pathlib.Path(review+'.continue')
        try:
            deadline = time.monotonic()+1200
            while not continuation.exists():
                if time.monotonic()>deadline: raise TimeoutError('Browser review was not completed within twenty minutes')
                time.sleep(.5)
        finally:
            review_path.unlink(missing_ok=True); continuation.unlink(missing_ok=True)
            request('/api/development/workspaces/'+tree['id']+'/operations/release-lease', {'requestId':str(uuid.uuid4()), 'leaseId':lease})
    say('No provider credentials or ordinary application data were used')

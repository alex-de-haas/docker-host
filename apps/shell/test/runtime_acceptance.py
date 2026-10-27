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
    # Review only fixture workspace metadata access through the ordinary Core approval page.
    # No user data, provider permission or ordinary Core grant participates in this test.
    review = request('/api/installations', {'permissionsAppId':'hosty.shell'})
    request('/api/installations/'+review['id']+'/submit', {})
    review_path = '/install/confirm/'+review['id']
    with context['browser'].open(origin+review_path, timeout=30) as page:
        html = page.read().decode()
    nonce = re.search(r'name=nonce value="([^"]+)"', html)
    assert nonce and 'apps.workspaces.read' in html, 'Missing fixture metadata permission review'
    context['diagnostic_secrets'].add(nonce.group(1))
    decision = urllib.parse.urlencode({'nonce':nonce.group(1), 'decision':'approve',
        'optionalPermission':'apps.workspaces.read'}).encode()
    with context['browser'].open(urllib.request.Request(origin+review_path, data=decision,
        headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response: response.read()
    wait_for(lambda: request('/api/installations/'+review['id'])['status'] == 'succeeded')
    assert isinstance(call(app_origin, '/api/core/api/apps/execution-targets')['apps'], list)
    assert isinstance(call(app_origin, '/api/core/api/development/activation-workspaces')['workspaces'], list)
    say('PASS: Docker Shell, password login, Core launch identity and both workspace inventory endpoints')
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

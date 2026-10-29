"""Production local Harness lifecycle in a parent-managed child Core with disposable identity/data."""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    # Core guidance is available before any standard app has been installed in the child.
    core_skills = request('/api/skills')['skills']
    assert sorted(s['name'] for s in core_skills) == ['hosty-app-skill', 'hosty-platform']
    assert all(s['sourceKind'] == 'core' and s['coreVersion'] for s in core_skills)
    dev = next(s for s in core_skills if s['name'] == 'hosty-app-skill')
    selected = request('/control/v1/skills/exports',
        {'contextId':'core-platform-acceptance', 'skillIds':[dev['id']], 'includePlatform':True}, control=True)
    assert len(selected['skills']) == 2 and selected['platformIntroduction']['text']
    exported = pathlib.Path(selected['path'])
    assert (exported/'hosty-app-skill/references/sdk-and-app-creation.md').is_file()
    assert (exported/'hosty-platform/references/introduction.md').read_text() == selected['platformIntroduction']['text']
    request('/control/v1/skills/exports/'+selected['id'], method='DELETE', control=True)
    assert not exported.exists()
    say('PASS: empty-app Core catalog, versioned built-in packages, portable exports and platform introduction')
    manifest = json.loads((workspace/'apps/harness/manifest.json').read_text())
    app = manifest['id']
    manifest['source']['repository'] = context['repository']
    target = base/'harness-manifest.json'
    target.write_text(json.dumps(manifest))
    run([cli, '--data-root', root, 'apps', 'install', target, '--runtime', 'local', '--no-autostart'])
    def timed(action):
        began = time.monotonic()
        run([cli, '--data-root', root, 'apps', action, app])
        wait_for(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)
        return round(time.monotonic()-began, 3)
    cold = timed('start')
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(host, route, body=None, csrf=None):
        headers = {'Content-Type':'application/json','Origin':host}
        if csrf: headers['X-Hosty-CSRF'] = csrf
        with client.open(urllib.request.Request(host+route, data=json.dumps(body).encode() if body is not None else None, headers=headers), timeout=60) as response:
            return json.load(response)
    assert call(app_origin, '/api/auth/identity')['status'] != 'active'
    form = urllib.parse.urlencode({'email':'activation-fixture@example.test','password':password,'returnTo':'/api/auth/session'}).encode()
    with client.open(urllib.request.Request(origin+'/login', data=form,
        headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response: response.read()
    assert call(origin, '/api/auth/session')['authenticated']
    csrf = call(origin, '/api/auth/csrf')['token']
    verifier = uuid.uuid4().hex + uuid.uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    code = call(origin, '/api/apps/'+app+'/launch-code',
        {'redirectUri':link,'codeChallenge':challenge,'codeChallengeMethod':'S256'}, csrf)['code']
    call(app_origin, '/api/auth/app-code', {'code':code,'codeVerifier':verifier})
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    call(app_origin, '/api/sessions')
    connection = call(app_origin, '/api/connections', {'name':'Usage fixture', 'kind':'claude', 'auth':'api-key', 'secret':'synthetic-usage-fixture'})
    usage = call(app_origin, '/api/connections/'+connection['id']+'/usage?refresh=true')
    assert usage['state'] == 'unsupported' and usage['rows'] == [] and usage['connectionRevision'] == connection['revision']
    say('PASS: authenticated Local worker usage reports unsupported API-key telemetry without inference')
    local_usage = call(app_origin, '/api/connections', {'name':'Local quota fixture', 'kind':'ollama', 'auth':'none'})
    local_usage = call(app_origin, '/api/connections/'+local_usage['id']+'/usage?refresh=true')
    assert local_usage['state'] == 'not_applicable' and local_usage['rows'] == []
    say('PASS: local Ollama quota is not applicable without a provider request')
    catalog = call(app_origin, '/api/skills')['skills']
    assert sorted((s['name'], s['coreVersion']) for s in catalog if s['sourceKind'] == 'core') == sorted((s['name'], s['coreVersion']) for s in core_skills)
    with client.open(app_origin+'/assistant/', timeout=30) as response:
        html = response.read().decode()
    assets = re.findall(r'(?:src|href)="([^"]+/_next/[^"]+|/_next/[^"]+)"', html)
    assert assets, 'Static page contains no compiled assets'
    for asset in assets:
        with client.open(urllib.parse.urljoin(app_origin, asset), timeout=30) as response:
            assert response.status == 200 and len(response.read()) > 0
    say('PASS: production API/worker, password login, Core launch-code identity, sessions API and compiled static assets')

    if os.environ.get('HOSTY_OLLAMA_ACCEPTANCE'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ollama_acceptance', workspace/'apps/harness/test/ollama_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app_origin, client, call, timed)

    if os.environ.get('HOSTY_SUGGESTIONS_BROWSER'):
        import subprocess
        result = subprocess.run(['node', str(workspace/'apps/harness/test/suggestions-browser.mjs')],
            input=json.dumps({'core':origin, 'harness':app_origin, 'email':'activation-fixture@example.test', 'password':password, 'link':link}),
            text=True, cwd=workspace)
        assert result.returncode == 0, 'Suggestion browser acceptance failed'

    if review := os.environ.get('HOSTY_HARNESS_BROWSER_REVIEW'):
        shell_manifest = json.loads((workspace/'apps/shell/manifest.json').read_text())
        shell_manifest['source']['repository'] = context['repository']
        shell_source = base/'shell-manifest.json'
        shell_source.write_text(json.dumps(shell_manifest))
        run([cli, '--data-root', root, 'apps', 'install', shell_source, '--runtime', 'dev', '--no-autostart'])
        run([cli, '--data-root', root, 'apps', 'start', 'hosty.shell'])
        wait_for(lambda: request('/api/apps/hosty.shell/health')['status'] == 'healthy', 180)
        shell_summary = next(item for item in request('/api/apps')['apps'] if item['id'] == 'hosty.shell')
        shell_endpoint = next(item for item in shell_summary['endpoints'] if item['key'] == 'web')
        shell_url = shell_endpoint.get('browserOrigin') or shell_endpoint.get('publicOrigin') or shell_endpoint['url']
        development = request('/api/core/development')
        source = request('/api/core/source', {'revision':development['source']['revision'], 'overridePath':None,
            'repository':{'repositoryUrl':context['repository'], 'ref':'main', 'projectPath':context['project'], 'connectionId':None}},
            method='PUT', confirm_settings=True)
        lease = str(uuid.uuid4())
        tree = request('/api/core/source/workspaces', {'requestId':str(uuid.uuid4()), 'taskId':'harness-refresh-acceptance',
            'leaseId':lease, 'sourceRevision':source['revision'], 'targetBranch':'main', 'name':'Verify bounded workspace refresh'})
        review_path = pathlib.Path(review)
        descriptor = os.open(review_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'origin':origin, 'appUrl':link, 'shellUrl':shell_url, 'email':'activation-fixture@example.test', 'password':password,
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

    app_root = root/'apps'/app
    receipts = list(app_root.rglob('.local-runtime/*/bundle.json'))
    assert len(receipts) == 1, 'Expected exactly one isolated production generation'
    receipt = receipts[0]
    bundle = receipt.parent
    metadata = json.loads(receipt.read_text())
    stamped = receipt.stat().st_mtime_ns
    worker_log = app_root/'logs/worker.log'
    log = worker_log.read_text()
    assert log.count('Preparing production bundle') == 1
    # Runtime source was bundled; the process does not depend on the development TS tree.
    assert not (bundle/'apps/harness/src').exists()
    assert not (bundle/'apps/harness/web').exists()
    for package in ['next', 'react', 'typescript', 'tsx']:
        assert not (bundle/'node_modules'/package).exists(), 'Unexpected production dependency: '+package
    provider_probe = (
        "const {createRequire}=require('node:module');const real=require('node:fs').realpathSync;const r=createRequire(process.argv[1]);"
        "for(const name of ['@openai/codex/bin/codex.js','@anthropic-ai/claude-agent-sdk']){"
        "if(!real(r.resolve(name)).startsWith(real(process.argv[2])+require('node:path').sep))throw Error('External provider fallback');}"
    )
    run(['node', '-e', provider_probe, bundle/'worker.mjs', bundle])
    first_runtime = json.loads((app_root/'run/api.json').read_text())['pid']
    warm = timed('restart')
    second_runtime = json.loads((app_root/'run/api.json').read_text())['pid']
    assert first_runtime != second_runtime, 'Restart must replace the runtime processes'
    assert receipt.stat().st_mtime_ns == stamped
    log = worker_log.read_text()
    assert log.count('Preparing production bundle') == 1
    assert 'Reusing production bundle' in log
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    call(app_origin, '/api/sessions')
    say(f'PASS: cold start {cold:.3f}s; warm restart {warm:.3f}s; generation retained, no install/build')

    # Remove a real served asset while stopped, then let Core's setup recover the same source.
    run([cli, '--data-root', root, 'apps', 'stop', app])
    (bundle/'web/assistant/index.html').unlink()
    recovery = timed('start')
    assert (bundle/'web/assistant/index.html').is_file()
    assert json.loads(receipt.read_text())['key'] == metadata['key']
    assert worker_log.read_text().count('Preparing production bundle') == 2
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    say(f'PASS: missing-output recovery {recovery:.3f}s; same input identity, authenticated API restored')
    run([cli, '--data-root', root, 'apps', 'stop', app])
    say('PASS: local services stopped; parent fixture will Finish the child and verify resource removal')

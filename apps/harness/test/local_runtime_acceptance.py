"""Docker production and cached Local development acceptance in a managed child Core."""
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


def install_manifest(context, manifest):
    if context.get('scenario') == 'harness-local':
        # This suite runs native Harness. Publish that same recipe as the source-only
        # installed baseline so Return starts real Harness without pulling a Docker image.
        native = next(profile for profile in manifest['runtimeProfiles'] if profile['key'] == 'dev')
        manifest['runtimeProfiles'] = [{**native, 'default': True}]
        manifest['defaultRuntime'] = native['key']
        for service in manifest['services']:
            service['runtimes'] = {native['key']: service['runtimes'][native['key']]}
        for storage in ('cache', 'data'):
            manifest[storage]['targets'] = [t for t in manifest[storage]['targets'] if t['runtime'] == native['key']]
        path = 'apps/harness/manifest.json'
        manifest['source']['manifestPath'] = path
        remote = context['remote']
        (remote/path).write_text(json.dumps(manifest), encoding='utf-8')
        context['run'](['git', 'add', path], remote)
        context['run'](['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
                        'commit', '-m', 'Publish the disposable native Harness package'], remote)
        context['run'](['git', 'update-server-info'], remote)
        return context['repository'].removesuffix('/.git') + '/' + path
    target = context['base']/'harness-manifest.json'
    target.write_text(json.dumps(manifest))
    shutil.copytree(context['workspace']/'apps/harness/assets', context['base']/'assets', dirs_exist_ok=True)
    return target


def check_self_switch(context, app, app_origin, call):
    request, wait_for = context['request'], context['wait_for']
    api = '/api/apps/'+app
    select = api+'/execution-target'
    before_runtime = context['harnessRuntimeIdentity']()
    baseline = request(api+'/execution-targets')['current']
    assert baseline['kind'] == 'package', baseline
    session = call(app_origin, '/api/sessions', {'title': 'Verify Harness workspace recovery'})
    tree = call(app_origin, '/api/sessions/'+session['id']+'/workspaces', {
        'action': 'prepare', 'appId': app, 'requestId': str(uuid.uuid4()), 'name': 'Test Harness startup failure'})
    tree_id, workspace_id = tree['id'], tree['workspaceId']
    lease = str(uuid.uuid4())
    lease_api = '/api/development/workspaces/'+tree_id+'/operations/'
    request(lease_api+'lease', {'requestId': str(uuid.uuid4()), 'leaseId': lease})
    sentinel = context['root']/'apps'/app/'data'/'workspace-switch-acceptance.txt'
    error = 'Harness workspace setup failed on purpose'
    try:
        setup = pathlib.Path(tree['path'])/'apps/harness/scripts/local-runtime.mjs'
        assert setup.is_file()
        setup.write_text(
            'import { writeFileSync } from "node:fs";\n'
            'import { join } from "node:path";\n'
            'if (process.argv[2] !== "prepare") throw new Error("Expected ordinary setup");\n'
            'writeFileSync(join(process.env.HOSTY_APP_DATA_DIR, "workspace-switch-acceptance.txt"), "workspace");\n'
            f'throw new Error("{error}");\n', encoding='utf-8')
    finally:
        request(lease_api+'release-lease', {'requestId': str(uuid.uuid4()), 'leaseId': lease})
    sentinel.write_text('package', encoding='utf-8')

    def select_and_wait(target):
        request_id = str(uuid.uuid4())
        request(select, {'requestId': request_id, **target})
        def settled():
            result = request(select+'/'+request_id)
            return result if result['state'] != 'running' else None
        return wait_for(settled, 180)

    selected = select_and_wait({'kind': 'workspace', 'runtime': 'dev', 'worktreeId': tree_id, 'workspaceId': workspace_id})
    assert (selected['state'], selected.get('code')) == ('failed', 'dev_workspace_start_failed'), selected
    assert selected['app']['runtimeState'] == 'stopped' and error in selected['error'], selected
    # All recovery reads and both mutations use Dashboard's authenticated Core API.
    # Nothing below depends on a working Harness until its package is healthy again.
    current = request(api+'/execution-targets')['current']
    assert (current['kind'], current['workspaceId'], current['worktreeId']) == ('workspace', workspace_id, tree_id), current
    health = request(api+'/health')
    assert [(service['service'], service['status']) for service in health['services']] == [('api', 'stopped')], health
    assert error in request(api+'/logs?tail=100')['text']
    assert sentinel.read_text(encoding='utf-8') == 'workspace'
    backups = request(api+'/backups')['backups']
    backup_id, = [row['backupId'] for row in backups if row.get('isWorkspaceReturnBackup')]
    returned = select_and_wait({'kind': 'package', 'runtime': baseline['runtime']})
    assert returned['state'] == 'completed' and returned['app']['runtimeState'] == 'running', returned
    current = request(api+'/execution-targets')['current']
    assert (current['kind'], current['runtime']) == ('package', baseline['runtime']), current
    wait_for(lambda: request(api+'/health')['status'] == 'healthy', 90)
    assert context['harnessRuntimeIdentity']() != before_runtime
    assert sentinel.read_text(encoding='utf-8') == 'workspace', 'Return unexpectedly restored package data'
    assert any(row['backupId'] == backup_id and row.get('isWorkspaceReturnBackup') for row in request(api+'/backups')['backups'])
    assert any(row['id'] == session['id'] for row in call(app_origin, '/api/sessions')['sessions'])
    context['say']('PASS: Harness workspace setup failed after binding. Core served the logs and returned Harness to its healthy package with current data and the pre-switch backup.')


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
    from agent_provider_acceptance import ProviderAcceptance
    providers = context.get('agentProviders') or ProviderAcceptance(context).install_all(scripted_codex=True)
    manifest = json.loads((workspace/'apps/harness/manifest.json').read_text())
    app = manifest['id']
    context['harnessAppId'] = app
    manifest['source']['repository'] = context['repository']
    assert [service['key'] for service in manifest['services']] == ['api']
    docker_consumer = context.get('scenario') == 'agent-providers'
    runtime = 'docker' if docker_consumer else 'dev'
    assert not any(profile['key'] == 'local' for profile in manifest['runtimeProfiles'])
    if docker_consumer:
        manifest['services'][0]['runtimes']['docker']['image'] = os.environ.get(
            'HOSTY_AGENT_PROVIDERS_API_IMAGE', 'hosty-harness-api-acceptance:local')
    target = install_manifest(context, manifest)
    run([cli, '--data-root', root, 'apps', 'install', target, '--runtime', runtime, '--no-autostart'])
    def timed(action):
        began = time.monotonic()
        run([cli, '--data-root', root, 'apps', action, app])
        wait_for(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)
        return round(time.monotonic()-began, 3)
    def runtime_identity():
        service = next(service for service in request('/api/apps/'+app+'/health')['services'] if service['service'] == 'api')
        assert service.get('processId') or service.get('startedAt'), 'Core must identify the actual runtime process/start'
        return (service.get('processId'), service.get('startedAt'))
    context['harnessRuntimeIdentity'] = runtime_identity
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
    connection = providers.configure_for_harness(app_origin, call, 'claude', 'Usage fixture', secret='synthetic-usage-fixture')
    usage = call(app_origin, '/api/connections/'+connection['id']+'/usage?refresh=true')
    assert usage['state'] == 'unsupported' and usage['rows'] == [] and usage['connectionRevision'] == connection['revision']
    say('PASS: independent Claude provider settings and qualified usage report unsupported API-key telemetry without inference')
    if docker_consumer:
        # Exercise the same exact operations under one Harness grant across a reviewed provider update.
        previous_runtime = runtime_identity()
        grant = call(app_origin, '/api/auth/identity')['continuity']['grantId']
        provider_id = connection['provider']['appId']
        update_manifest = json.loads((base/'claude-code-provider-acceptance.json').read_text())
        version = update_manifest['version']
        prefix, patch = version.rsplit('.', 1)
        update_manifest['version'] = f'{prefix}.{int(patch) + 1}'
        candidate = base/'claude-code-provider-update.json'
        candidate.write_text(json.dumps(update_manifest))
        update_path = f'/control/v1/apps/{provider_id}/update'
        selection = {'manifestPath': str(candidate), 'selectedRuntime': 'local'}
        plan = request(update_path+'/plan', selection, control=True)
        assert (plan['appId'], plan['currentVersion'], plan['targetVersion'], plan['targetRuntime']) == (
            provider_id, version, update_manifest['version'], 'local')
        applied = request(update_path, {**selection, 'planDigest': plan['planDigest']}, control=True)
        assert applied['status'] == 'updated' and applied['app']['version'] == update_manifest['version']
        assert request(f'/api/apps/{provider_id}/health')['status'] == 'healthy'
        assert runtime_identity() == previous_runtime
        assert call(app_origin, '/api/auth/identity')['continuity']['grantId'] == grant
        roster = call(app_origin, '/api/connections')
        provider = next(row for row in roster['providers'] if row['appId'] == provider_id)
        assert provider['available'], provider.get('reason', 'Updated provider unavailable in Harness')
        refreshed = next((row for row in roster['connections'] if row['id'] == connection['id']), None)
        assert refreshed and refreshed['available'] and refreshed['provider'] == connection['provider']
        usage = call(app_origin, '/api/connections/'+connection['id']+'/usage?refresh=true')
        assert usage['state'] == 'unsupported' and usage['rows'] == [] and usage['connectionRevision'] == connection['revision']
        say('PASS: reviewed Claude update preserves discovery and usage with the same Harness runtime, grant and provider connection')
    local_usage = providers.configure_for_harness(app_origin, call, 'ollama', 'Local quota fixture', auth='none')
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
    say('PASS: production consumer API, three independent Local providers, password login, Core launch-code identity and compiled static assets')

    if os.environ.get('HOSTY_PROVIDER_PORT_CHANGE') == '1':
        import importlib.util
        spec = importlib.util.spec_from_file_location('provider_port_acceptance', workspace/'apps/harness/test/provider_port_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app, app_origin, call, client)

    if os.environ.get('HOSTY_SESSION_SUBAGENTS_BROWSER'):
        import subprocess
        connection = providers.configure_for_harness(app_origin, call, 'codex', 'Chat family acceptance', secret='synthetic-chat-family-fixture')
        from workspace_sessions_acceptance import session_browser
        verified = subprocess.run(['node', str(workspace/'apps/harness/test/session-subagents-browser.mjs')], check=True, cwd=workspace, stdout=subprocess.PIPE,
            input=json.dumps({'core': (context.get('child', {}).get('previewUrl') or origin).rstrip('/'), 'harness': app_origin,
                'harnessAppId': app, 'email': 'activation-fixture@example.test', 'password': password, 'link': link,
                'connectionId': connection['id']}), text=True)
        ids = json.loads(verified.stdout)
        assert len(set(ids)) == 3
        visitor = session_browser(context, app, app_origin, link)('subagent-visitor@example.test', 'Another operator', invited=True)
        assert set(ids).isdisjoint(row['id'] for row in visitor.harness('/sessions')['sessions'])
        for chat_id in ids:
            visitor.harness('/sessions/' + chat_id, expected=404)
        say('PASS: ordinary chat delegated implementation and verification, replayed spawn, opened both full histories, and kept all three chats private from another signed-in operator')

    if context.get('scenario') == 'agent-providers':
        from installation_history_acceptance import check as check_installation_history
        check_installation_history(context, app, app_origin, link, timed)
        if os.environ.get('HOSTY_LIVE_HISTORY_ACCEPTANCE') == '1':
            import subprocess
            connection = providers.harness_connection(app_origin, call, 'codex')
            subprocess.run(['node', str(workspace/'apps/harness/test/live-history-browser.mjs')], check=True, cwd=workspace,
                input=json.dumps({'core': origin, 'harness': app_origin, 'app': app, 'link': link, 'password': password,
                    'connection': connection['id'], 'root': str(root), 'cli': str(cli), 'policy': str(base/'range-policy.json'),
                    'provider': providers.entries['codex']['appId']}), text=True)

    if context.get('scenario') == 'agent-providers' or os.environ.get('HOSTY_EXECUTION_RECOVERY'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('execution_recovery_acceptance', workspace/'apps/harness/test/execution_recovery_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app, app_origin, call, timed, link, client)

    if context.get('scenario') == 'agent-providers' or os.environ.get('HOSTY_HISTORY_DURABILITY'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('history_durability_acceptance', workspace/'apps/harness/test/history_durability_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app, app_origin, client, call, timed)

    if os.environ.get('HOSTY_LONG_SPEECH_ACCEPTANCE'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('long_speech_acceptance', workspace/'apps/harness/test/long_speech_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app, app_origin, client, call, link)

    if context.get('scenario') == 'feedback':
        from feedback_acceptance import check as check_feedback
        check_feedback(context, app_origin, link)

    if os.environ.get('HOSTY_OLLAMA_ACCEPTANCE'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ollama_acceptance', workspace/'apps/harness/test/ollama_acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.check(context, app_origin, client, call, timed)

    if os.environ.get('HOSTY_CONTEXT_BROWSER'):
        import subprocess
        result = subprocess.run(['node', str(workspace/'apps/harness/test/context-browser.mjs')],
            input=json.dumps({'core':origin, 'harness':app_origin, 'email':'activation-fixture@example.test', 'password':password, 'link':link}),
            text=True, cwd=workspace)
        assert result.returncode == 0, 'Context browser acceptance failed'

    if os.environ.get('HOSTY_SUGGESTIONS_BROWSER'):
        import subprocess
        result = subprocess.run(['node', str(workspace/'apps/harness/test/suggestions-browser.mjs')],
            input=json.dumps({'core':(context.get('child', {}).get('previewUrl') or origin).rstrip('/'), 'harness':app_origin, 'appId':app, 'email':'activation-fixture@example.test', 'password':password, 'link':link}),
            text=True, cwd=workspace)
        assert result.returncode == 0, 'Suggestion browser acceptance failed'

    if os.environ.get('HOSTY_NATIVE_SUBAGENTS_BROWSER'):
        import subprocess
        connection = providers.configure_for_harness(app_origin, call, 'codex', 'Native child disclosure', secret='synthetic-native-child-fixture')
        result = subprocess.run(['node', str(workspace/'apps/harness/test/native-subagents-browser.mjs')],
            input=json.dumps({'core':(context.get('child', {}).get('previewUrl') or origin).rstrip('/'), 'harness':app_origin, 'appId':app,
                'email':'activation-fixture@example.test', 'password':password, 'link':link, 'connectionId':connection['id']}),
            text=True, cwd=workspace)
        assert result.returncode == 0, 'Native subagent browser acceptance failed'

    if os.environ.get('HOSTY_QUEUE_BROWSER'):
        import subprocess
        result = subprocess.run(['node', str(workspace/'apps/harness/test/message-queue-browser.mjs')],
            input=json.dumps({'core':(context.get('child', {}).get('previewUrl') or origin).rstrip('/'), 'harness':app_origin, 'appId':app, 'email':'activation-fixture@example.test', 'password':password, 'link':link,
                             'provider':providers.entries['ollama']}),
            text=True, cwd=workspace)
        assert result.returncode == 0, 'Message queue browser acceptance failed'

    if os.environ.get('HOSTY_WORK_BROWSER'):
        import subprocess
        browser_input = {'core':origin, 'harness':app_origin, 'email':'activation-fixture@example.test', 'password':password,
            'link':link, 'outputDirectory':os.environ.get('HOSTY_WORK_SCREENSHOTS')}
        if os.environ.get('HOSTY_WORK_SHELL_BROWSER'):
            shell = json.loads((workspace/'apps/shell/manifest.json').read_text())
            shell['source']['repository'] = context['repository']
            shell_source = base/'work-browser-shell-manifest.json'
            shell_source.write_text(json.dumps(shell))
            shutil.copytree(workspace/'apps/shell/assets', base/'assets', dirs_exist_ok=True)
            run([cli, '--data-root', root, 'apps', 'install', shell_source, '--runtime', 'dev', '--no-autostart'])
            run([cli, '--data-root', root, 'apps', 'start', shell['id']])
            wait_for(lambda: request('/api/apps/'+shell['id']+'/health')['status'] == 'healthy', 180)
            shell_summary = next(item for item in request('/api/apps')['apps'] if item['id'] == shell['id'])
            shell_endpoint = next(item for item in shell_summary['endpoints'] if item['key'] == shell['endpoints'][0]['key'])
            shell_origin = shell_endpoint.get('browserOrigin') or shell_endpoint.get('publicOrigin') or shell_endpoint['url']
            shell_link = json.loads(run([cli, '--data-root', root, 'apps', 'open', shell['id'],
                '--redirect-uri', shell_origin.rstrip('/')+'/dashboard', '--format', 'json']))['url']
            parsed_shell = urllib.parse.urlparse(shell_link)
            browser_input.update(shell=urllib.parse.urlunparse((parsed_shell.scheme, parsed_shell.netloc, '', '', '', '')),
                shellLink=shell_link, shellAppId=shell['id'])
            say('PASS: isolated source Shell started for Sessions embedding acceptance')
        result = subprocess.run(['node', str(workspace/'apps/harness/test/work-browser.mjs')],
            input=json.dumps(browser_input), text=True, cwd=workspace)
        assert result.returncode == 0, 'Work browser acceptance failed'

    if review := os.environ.get('HOSTY_HARNESS_BROWSER_REVIEW'):
        shell_manifest = json.loads((workspace/'apps/shell/manifest.json').read_text())
        shell_id = shell_manifest['id']
        shell_summary = next((item for item in request('/api/apps')['apps'] if item['id'] == shell_id), None)
        if shell_summary is None:
            shell_manifest['source']['repository'] = context['repository']
            shell_source = base/'shell-manifest.json'
            shell_source.write_text(json.dumps(shell_manifest))
            run([cli, '--data-root', root, 'apps', 'install', shell_source, '--runtime', 'dev', '--no-autostart'])
        if shell_summary is None or shell_summary['runtimeState'] not in ('running', 'starting'):
            run([cli, '--data-root', root, 'apps', 'start', shell_id])
        wait_for(lambda: request('/api/apps/'+shell_id+'/health')['status'] == 'healthy', 180)
        shell_summary = next(item for item in request('/api/apps')['apps'] if item['id'] == shell_id)
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
    if docker_consumer:
        first_runtime = runtime_identity()
        warm = timed('restart')
        assert runtime_identity() != first_runtime, 'Docker restart must report a replacement process/start identity'
        assert call(app_origin, '/api/auth/identity')['status'] == 'active'
        call(app_origin, '/api/sessions')
        assert not list(app_root.rglob('.local-runtime/*/bundle.json')), 'Production Docker must use the CI-built image, not build source at startup'
        say(f'PASS: Docker production cold start {cold:.3f}s; warm restart {warm:.3f}s; app identity and durable data retained')
        run([cli, '--data-root', root, 'apps', 'stop', app])
        say('PASS: Docker consumer stopped; parent fixture will Finish the child and verify resource removal')
        return
    receipts = list(app_root.rglob('.local-runtime/*/bundle.json'))
    assert len(receipts) == 1, 'Expected exactly one isolated production generation'
    receipt = receipts[0]
    bundle = receipt.parent
    metadata = json.loads(receipt.read_text())
    stamped = receipt.stat().st_mtime_ns
    runtime_log = app_root/'logs/api.log'
    log = runtime_log.read_text()
    assert log.count('Preparing production bundle') == 1
    # Runtime source was bundled; the process does not depend on the development TS tree.
    assert not (bundle/'apps/harness/src').exists()
    assert not (bundle/'apps/harness/web').exists()
    assert (bundle/'api.mjs').is_file() and not (bundle/'worker.mjs').exists()
    for package in ['next', 'react', 'typescript', 'tsx', '@openai/codex', '@anthropic-ai/claude-agent-sdk', '@haas/hosty-agent-provider-runtime']:
        assert not (bundle/'node_modules'/package).exists(), 'Unexpected production dependency: '+package
    # Keep the real browser's paused work and immutable attachment bytes across both lifecycle
    # paths below. The HTTP fixture has already closed, so a restarted queue must stay paused.
    retained_queues = {}
    if os.environ.get('HOSTY_QUEUE_BROWSER'):
        for session in call(app_origin, '/api/sessions')['sessions']:
            route = '/api/sessions/'+session['id']+'/message-queue'
            snapshot = call(app_origin, route)
            if not snapshot['entries']: continue
            assert snapshot['paused'] and all(entry['state'] == 'queued' for entry in snapshot['entries'])
            files = {}
            for entry in snapshot['entries']:
                for attachment in entry['attachments']:
                    path = route+'/attachments/'+urllib.parse.quote(attachment['id'], safe='')
                    with client.open(app_origin+path, timeout=30) as response:
                        files[path] = hashlib.sha256(response.read()).hexdigest()
            retained_queues[route] = (snapshot['entries'], files)
        assert retained_queues and any(files for _, files in retained_queues.values())
    def verify_retained_queues():
        for route, (entries, files) in retained_queues.items():
            snapshot = call(app_origin, route)
            assert snapshot['paused'] and snapshot['entries'] == entries
            for path, digest in files.items():
                with client.open(app_origin+path, timeout=30) as response:
                    assert hashlib.sha256(response.read()).hexdigest() == digest

    first_runtime = json.loads((app_root/'run/api.json').read_text())['pid']
    warm = timed('restart')
    second_runtime = json.loads((app_root/'run/api.json').read_text())['pid']
    assert first_runtime != second_runtime, 'Restart must replace the runtime processes'
    assert receipt.stat().st_mtime_ns == stamped
    log = runtime_log.read_text()
    assert log.count('Preparing production bundle') == 1
    assert 'Reusing production bundle' in log
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    call(app_origin, '/api/sessions')
    verify_retained_queues()
    say(f'PASS: cold start {cold:.3f}s; warm restart {warm:.3f}s; generation retained, no install/build')

    # Remove a real served asset while stopped, then let Core's setup recover the same source.
    run([cli, '--data-root', root, 'apps', 'stop', app])
    (bundle/'web/assistant/index.html').unlink()
    recovery = timed('start')
    assert (bundle/'web/assistant/index.html').is_file()
    assert json.loads(receipt.read_text())['key'] == metadata['key']
    assert runtime_log.read_text().count('Preparing production bundle') == 2
    assert call(app_origin, '/api/auth/identity')['status'] == 'active'
    verify_retained_queues()
    if retained_queues: say('PASS: paused queue entries and immutable attachment bytes survive warm restart and missing-output recovery')
    say(f'PASS: missing-output recovery {recovery:.3f}s; same input identity, authenticated API restored')
    if context.get('scenario') == 'harness-local':
        check_self_switch(context, app, app_origin, call)
    run([cli, '--data-root', root, 'apps', 'stop', app])
    say('PASS: local services stopped; parent fixture will Finish the child and verify resource removal')

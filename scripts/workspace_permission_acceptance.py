"""Permission continuity through real workspace review, Return and permanent approval."""
import json
import pathlib
import re
import shlex
import subprocess
import sys
import urllib.parse
import urllib.request
import uuid


def check(context):
    request, run, wait_for, say = (context[key] for key in ('request', 'run', 'wait_for', 'say'))
    base, remote, origin, browser = (context[key] for key in ('base', 'remote', 'origin', 'browser'))
    assert context['managed'], 'Workspace permission acceptance requires a managed child Core'
    app_id = 'example.permission-cycle.' + uuid.uuid4().hex[:12]
    served = context['repository'].removesuffix('/.git')
    source = base/'permission-source'
    source.mkdir()
    command = [sys.executable, 'idle.py']
    command = subprocess.list2cmdline(command) if context['windows'] else shlex.join(command)
    manifest = {
        'schemaVersion': 'app.0.1', 'id': app_id, 'name': 'Workspace permission fixture',
        'description': 'Disposable native service for workspace permission continuity.', 'version': '0.1.0',
        'source': {'type': 'git', 'repository': served+'/permission-fixture.git',
                   'branch': 'main', 'manifestPath': 'manifest.json'},
        'corePermissions': ['apps.read'], 'optionalCorePermissions': ['apps.logs'],
        'runtimeProfiles': [{'key': 'local', 'type': 'localCommand', 'default': True},
                            {'key': 'dev', 'type': 'localCommand', 'development': True}],
        'defaultRuntime': 'local',
        'services': [{'key': 'idle', 'runtimes': {key: {
            'type': 'localCommand', 'workingDirectory': '.', 'command': command,
        } for key in ('local', 'dev')}}],
    }
    (source/'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    (source/'idle.py').write_text('import time\ntime.sleep(3600)\n', encoding='utf-8')
    run(['git', 'init', '-b', 'main'], source)
    run(['git', 'add', '.'], source)
    run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
         'commit', '-m', 'Create isolated workspace permission fixture'], source)
    run(['git', 'clone', '--bare', str(source), str(remote/'permission-fixture.git')])
    run(['git', 'update-server-info'], remote/'permission-fixture.git')
    (remote/'permission-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')

    def approve_page(path, optional=()):
        # Exercise the isolated child's real administrator page and its session-bound nonce.
        with browser.open(origin+path, timeout=30) as response:
            url, html = response.geturl(), response.read().decode()
        assert url.startswith(origin+'/install/confirm/'), 'Expected the Core confirmation page'
        nonce = re.search(r'name=nonce value="([^"]+)"', html)
        assert nonce, 'Core confirmation has no decision nonce'
        context['diagnostic_secrets'].add(nonce.group(1))
        fields = [('nonce', nonce.group(1)), ('decision', 'approve')]
        fields.extend(('optionalPermission', permission) for permission in optional)
        with browser.open(urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(),
                headers={'Origin': origin, 'Content-Type': 'application/x-www-form-urlencoded'}), timeout=180) as response:
            response.read()
        approval_id = urllib.parse.urlparse(url).path.rsplit('/', 1)[1]
        def approved():
            result = request('/api/installations/'+approval_id)
            assert result['status'] not in ('failed', 'denied', 'expired'), result
            return result['status'] == 'succeeded'
        wait_for(approved, 90)

    def approve(input):
        review = request('/api/installations', input)
        request('/api/installations/'+review['id']+'/submit', {})
        approve_page('/install/confirm/'+review['id'])

    def permissions(expected):
        value = request('/api/apps/'+app_id+'/permissions')
        assert value['status'] == 'known' and set(value['granted']) == set(expected), value
        assert not value['missingRequired'] and not value['reviewRequired'], value

    def selected(input, expect_review=False):
        path = '/api/apps/'+app_id+'/execution-target'
        request(path, input)
        def settled():
            value = request(path+'/'+input['requestId'])
            assert value['state'] != 'failed', value
            return value if value['state'] in ('completed', 'review-required') else None
        value = wait_for(settled, 120)
        if expect_review:
            assert value['state'] == 'review-required', value
            plan = value['review']['workspaceManifest']
            assert plan['appId'] == app_id and 'apps.logs' in plan['requiredPermissions'], plan
            approve(value['review'])
            # A confirmed review resumes the exact retained selection, not a new operation.
            request(path, input)
            value = wait_for(settled, 120)
        assert value['state'] == 'completed', ('Unexpected workspace permission review', value)
        assert value['app']['selectedRuntime'] == input['runtime'], value
        current = request('/api/apps/'+app_id+'/execution-targets')['current']
        assert current['kind'] == input['kind'] and current['runtime'] == input['runtime'], current
        if input['kind'] == 'workspace':
            assert current['workspaceId'] == input['workspaceId'] and current['worktreeId'] == input['worktreeId'], current
        wait_for(lambda: request('/api/apps/'+app_id+'/health')['status'] == 'healthy', 30)
        return value['app']

    def package(expected):
        app = selected({'requestId': str(uuid.uuid4()), 'kind': 'package', 'runtime': 'local'})
        assert app['selectedRuntime'] == 'local' and app['sourceOverridePath'] is None, app
        assert app['installationId'] == installation, 'Workspace switching replaced the installed app'
        permissions(expected)

    credential = None
    leases = []
    installed = False
    try:
        approve({'manifestPath': served+'/permission-manifest.json', 'selectedRuntime': 'local'})
        installed = True
        baseline = next(app for app in request('/api/apps')['apps'] if app['id'] == app_id)
        installation = baseline['installationId']
        permissions(['apps.read'])
        credential = request('/api/auth/credentials', {'label': 'Disposable workspace permission acceptance',
            'audience': 'hosty:core', 'scopes': ['mcp:read', 'mcp:workspaces']}, confirm_settings=True)
        context['diagnostic_secrets'].add(credential['token'])
        sequence = 0
        def rpc(method, params):
            nonlocal sequence
            sequence += 1
            payload = {'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params}
            req = urllib.request.Request(origin+'/api/mcp', data=json.dumps(payload).encode(), headers={
                'Authorization': 'Bearer '+credential['token'], 'Accept': 'application/json, text/event-stream',
                'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=180) as response:
                raw = response.read().decode()
            envelopes = [json.loads(raw)] if raw.lstrip().startswith('{') else [
                json.loads(line[5:]) for line in raw.splitlines() if line.startswith('data:')]
            envelope = next(value for value in envelopes if value.get('id') == sequence)
            assert 'error' not in envelope, envelope.get('error')
            return envelope['result']
        def tool(name, arguments):
            result = rpc('tools/call', {'name': name, 'arguments': arguments})
            assert not result.get('isError'), result
            return result.get('structuredContent') or json.loads(next(
                item['text'] for item in result['content'] if item['type'] == 'text'))
        rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                          'clientInfo': {'name': 'workspace-permission-acceptance', 'version': '1'}})

        def prepare(name):
            lease = str(uuid.uuid4())
            tree = tool('prepare_workspace', {'requestId': str(uuid.uuid4()), 'taskId': str(uuid.uuid4()),
                'appId': app_id, 'leaseId': lease, 'name': name, 'targetBranch': 'main'})
            leases.append((tree['id'], lease))
            path = pathlib.Path(tree['path'])/'manifest.json'
            candidate = json.loads(path.read_text(encoding='utf-8'))
            candidate.update(corePermissions=['apps.read', 'apps.logs'], optionalCorePermissions=[])
            path.write_text(json.dumps(candidate), encoding='utf-8')
            return {'kind': 'workspace', 'runtime': 'dev', 'workspaceId': tree['workspaceId'], 'worktreeId': tree['id']}

        first = prepare('Verify permanent permission continuity')
        selected({'requestId': str(uuid.uuid4()), **first}, expect_review=True)
        permissions(['apps.read', 'apps.logs'])
        package(['apps.read'])
        say('PASS: workspace-only permission is reviewed and removed by Return')

        # The inactive operation remains in Core's supported history. A new permanent grant
        # must not be subtracted as if it still belonged to that old workspace execution.
        approve_page('/install/permissions/'+app_id, optional=['apps.logs'])
        permissions(['apps.read', 'apps.logs'])
        for target in (first, prepare('Verify permission continuity in another workspace')):
            selected({'requestId': str(uuid.uuid4()), **target})
            permissions(['apps.read', 'apps.logs'])
            package(['apps.read', 'apps.logs'])
        say('PASS: permanent approval survives same/different workspace selection without another review and remains after Return')
    finally:
        stopped = not installed
        if installed:
            request('/api/apps/'+app_id+'/stop', {})
            wait_for(lambda: next(app for app in request('/api/apps')['apps'] if app['id'] == app_id)['runtimeState'] == 'stopped', 30)
            stopped = True
        # Keep leases if stopping fails; the outer fixture still owns and Finishes this child.
        if stopped:
            for tree_id, lease in leases:
                request('/api/development/workspaces/'+tree_id+'/operations/release-lease',
                        {'requestId': str(uuid.uuid4()), 'leaseId': lease})
        if credential:
            request('/api/auth/credentials/'+credential['id'], method='DELETE', confirm_settings=True)

#!/usr/bin/env python3
"""Dependency startup acceptance in a parent-managed child Core on the local Docker engine.

Build Core/CLI first. Optional HOSTY_DEPENDENCY_SHELL_IMAGE installs a locally built Shell;
HOSTY_DEPENDENCY_BROWSER_HOLD=1 pauses for authenticated browser QA before owner-led Finish.
Only generated test credentials/data are used. Raw receipts stay outside the repository.
"""
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

workspace = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
base = Path(tempfile.mkdtemp(prefix='hosty-dependencies-'))
root = base / 'parent'
project = workspace / 'apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj'
suffix = '.exe' if os.name == 'nt' else ''
core = project.parent / ('bin/Debug/net10.0/hosty-core' + suffix)
cli = workspace / ('apps/cli/src/Haas.Hosty.Cli/bin/Debug/net10.0/hosty' + suffix)
env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'DOTNET_ROOT', 'LANG',
       'SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData') if k in os.environ}
email = 'dependency-fixture@example.test'
password = uuid.uuid4().hex + 'aA1!'
parent = child = process = child_record = None
image = 'hosty-dependency-fixture:' + uuid.uuid4().hex[:12]
success = False

def say(message):
    print(message, flush=True)

def run(arguments, timeout=180):
    result = subprocess.run([str(x) for x in arguments], env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Command failed: ' + str(arguments[0]) + '\n' + (result.stderr + result.stdout)[-3000:])
    return result.stdout.strip()

def wait_for(check, description, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.2)
    raise TimeoutError(description)

class Client:
    def __init__(self, origin, data_root):
        self.origin, self.root = origin, Path(data_root)
        self.jar = http.cookiejar.CookieJar()
        self.browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def request(self, path, body=None, control=False):
        headers = {'Content-Type': 'application/json', 'Origin': self.origin}
        if self.csrf:
            headers['X-Hosty-CSRF'] = self.csrf
        if control:
            headers.update(json.loads((self.root / 'core/run/control.json').read_text())['requiredHeaders'])
        req = urllib.request.Request(self.origin + path, headers=headers,
              data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.browser.open(req, timeout=240) as response:
                content = response.read()
                return json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{path}: HTTP {error.code}: ' + error.read().decode()[:1500]) from None

    def login(self):
        self.jar.clear()
        form = urllib.parse.urlencode({'email': email, 'password': password, 'returnTo': '/api/auth/session'}).encode()
        request = urllib.request.Request(self.origin + '/login', data=form,
                  headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': self.origin})
        with self.browser.open(request, timeout=30) as response:
            response.read()
        assert self.request('/api/auth/session')['authenticated'], 'Ordinary password login failed'
        self.csrf = self.request('/api/auth/csrf')['token']

    def app(self, app_id):
        return next(row for row in self.request('/api/apps')['apps'] if row['id'] == app_id)

    def action(self, app_id, action):
        return self.request(f'/api/apps/{app_id}/{action}', {})

    def install(self, manifest):
        path = base / (manifest['id'] + '.json')
        path.write_text(json.dumps(manifest))
        run([cli, '--data-root', self.root, 'apps', 'install', path, '--no-autostart'])


def environment_action(action):
    global child_record
    current = parent.request('/api/core-environments/' + child_record['id'])
    # Keep the receipt before sending; an uncertain operation is recovered with this same UUID.
    body = {'requestId': str(uuid.uuid4()), 'expectedRevision': current['revision']}
    (base / ('operation-' + action + '.json')).write_text(json.dumps(body))
    child_record = parent.request('/api/core-environments/' + current['id'] + '/operations/' + action, body)
    return child_record


def fixture(app_id, provider=None, delay=0):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        host_port = listener.getsockname()[1]
    result = {'schemaVersion': 'app.0.1', 'id': app_id, 'name': app_id, 'version': '0.1.0',
        'runtimeProfiles': [{'key': 'docker', 'type': 'docker', 'default': True, 'readinessTimeoutSeconds': 1}],
        'defaultRuntime': 'docker', 'services': [{'key': 'web', 'runtimes': {'docker': {
            'type': 'docker', 'image': image, 'environment': {'HEALTH_DELAY': str(delay)},
            'ports': [{'key': 'http', 'containerPort': 8080, 'hostPort': host_port, 'protocol': 'http', 'expose': 'host'}],
            'healthcheck': {'type': 'exec', 'command': "node -e \"fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
                            'intervalSeconds': 1, 'timeoutSeconds': 1, 'retries': 1}}}}],
        'endpoints': [{'key': 'web', 'service': 'web', 'port': 'http', 'protocol': 'http', 'public': True}]}
    if provider:
        result['dependencies'] = [{'id': provider, 'required': True, 'endpoints': [{'key': 'web', 'as': 'provider'}]}]
    return result

try:
    # Tiny fixture reports the injected provider URL and whether it answers from the consumer.
    (base / 'server.cjs').write_text("""const http = require('node:http');
const started = Date.now();
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.statusCode = Date.now()-started >= Number(process.env.HEALTH_DELAY||0)*1000 ? 200 : 503; return res.end(); }
  const provider = process.env.HOSTY_DEPENDENCY_PROVIDER_URL || null;
  let reachable = null;
  if (provider) { try { reachable = (await fetch(provider+'/health')).ok; } catch { reachable = false; } }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({provider, reachable}));
}).listen(8080, '0.0.0.0');
""")
    (base / 'Dockerfile').write_text('FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5\nCOPY server.cjs /server.cjs\nCMD ["node", "/server.cjs"]\n')
    run(['docker', 'build', '-t', image, base])
    (root / 'core').mkdir(parents=True)
    distribution = root / 'core/distribution-apps.json'
    distribution.write_text('{"schemaVersion":"distribution-apps.0.1","apps":[]}')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://localhost:{port}'
    launch_env = dict(env, HOSTY_DATA_ROOT=str(root), HOSTY_CORE_URL=origin, HOSTY_CORE_PORT=str(port),
                     HOSTY_DISTRIBUTION_APPS_PATH=str(distribution), HOSTY_CORE_LAUNCH_MODE='dev',
                     HOSTY_CORE_PROJECT=str(project), HOSTY_CLI_PATH=str(cli))
    with (base / 'parent.log').open('w') as log:
        process = subprocess.Popen([str(core)], env=launch_env, stdout=log, stderr=subprocess.STDOUT)
    def parent_ready():
        if process.poll() is not None:
            raise RuntimeError('Parent exited; inspect ' + str(base / 'parent.log'))
        return (root / 'core/run/control.json').exists()
    wait_for(parent_ready, 'Parent readiness')
    parent = Client(origin, root)
    token = parent.request('/control/v1/auth/setup-token', {}, control=True)['token']
    parent.request('/api/auth/bootstrap', {'setupToken': token, 'email': email, 'displayName': 'Dependency fixture', 'password': password})
    parent.login()
    create = {'requestId': str(uuid.uuid4()), 'label': 'Dependency startup acceptance', 'mode': 'source', 'projectPath': str(project),
              'limits': {'applicationMemoryBytes': 536870912, 'applicationCpus': 0.5, 'applicationPids': 128}}
    (base / 'create.json').write_text(json.dumps(create))
    child_record = parent.request('/api/core-environments', create)
    environment_action('start')
    assert child_record['state'] == 'running', child_record.get('error')
    parent.request('/api/core-environments/' + child_record['id'] + '/setup',
                   {'email': email, 'displayName': 'Dependency fixture', 'password': password})
    child = Client(f"http://localhost:{child_record['port']}", child_record['dataRoot'])
    child.login()
    say('PASS: source child Core ready, isolated user authenticated with password; data=' + str(base))
    provider, consumer = 'org.example.z-provider', 'org.example.a-consumer'
    child.install(fixture(consumer, provider))
    result = child.action(consumer, 'start')
    assert result['status'] == 'waiting' and child.app(consumer)['runtimeState'] == 'waiting'
    assert not run(['docker', 'ps', '-q', '--filter', 'label=hosty.instance=' + child_record['id']])
    say('PASS: missing required provider settles manual Start as waiting without launching a container')
    child.install(fixture(provider, delay=6))
    child.action(consumer, 'stop')
    child.action(provider, 'start')
    wait_for(lambda: child.app(provider).get('health', {}).get('status') == 'healthy', 'Provider readiness')
    assert child.app(consumer)['runtimeState'] == 'stopped'
    say('PASS: Stop cancels waiting; provider readiness does not revive the consumer')
    child.action(provider, 'stop')
    assert child.action(consumer, 'start')['status'] == 'waiting'
    child.action(provider, 'start')
    wait_for(lambda: child.app(consumer)['runtimeState'] == 'running', 'Automatic dependency resume')
    endpoint = child.app(consumer)['endpoints'][0]['url']
    with urllib.request.urlopen(endpoint, timeout=15) as response:
        payload = json.load(response)
    assert payload['provider'] and payload['reachable'], payload
    say('PASS: delayed healthy provider wakes consumer; injected URL answers from its Docker container')
    for app_id in (provider, consumer):
        child.request('/api/apps/' + app_id + '/autostart', {'autostart': True})
    old_pid = child_record['process']['pid']
    environment_action('restart')
    assert child_record['state'] == 'running' and child_record['process']['pid'] != old_pid
    child.login()
    wait_for(lambda: child.app(consumer)['runtimeState'] == 'running', 'Dependency-ordered boot')
    say('PASS: Core restart starts reverse-alphabetical provider/consumer chain without manual intervention')
    shell_image = os.environ.get('HOSTY_DEPENDENCY_SHELL_IMAGE')
    if shell_image:
        shell = json.loads((workspace / 'apps/shell/manifest.json').read_text())
        shell['services'][0]['runtimes']['docker']['image'] = shell_image
        child.install(shell)
        child.action(shell['id'], 'start')
        child.action(consumer, 'stop')
        child.action(provider, 'stop')
        child.action(consumer, 'start')
        shell_url = child.app(shell['id'])['endpoints'][0]['url']
        browser = base / 'browser.json'
        browser.write_text(json.dumps({'core': child.origin, 'preview': child_record['previewUrl'], 'shell': shell_url,
                                      'email': email, 'password': password, 'childId': child_record['id']}))
        browser.chmod(0o600)
        if os.environ.get('HOSTY_DEPENDENCY_BROWSER_HOLD') == '1':
            hold = base / 'browser-hold'
            hold.touch()
            say('BROWSER READY: ' + str(browser) + '; remove browser-hold after QA')
            wait_for(lambda: not hold.exists(), 'Browser QA hold exceeded 15 minutes', timeout=900)
        browser.unlink()
    child.action(provider, 'stop')
    assert child.action(consumer, 'restart')['status'] == 'waiting'
    repaired = json.loads((base / (consumer + '.json')).read_text())
    repaired.pop('dependencies')
    repaired['version'] = '0.2.0'
    repaired_path = base / 'reviewed-repair.json'
    repaired_path.write_text(json.dumps(repaired))
    plan = child.request('/control/v1/apps/' + consumer + '/update/plan',
                         {'manifestPath': str(repaired_path)}, control=True)
    child.request('/control/v1/apps/' + consumer + '/update', {'planDigest': plan['planDigest']}, control=True)
    wait_for(lambda: child.app(consumer)['runtimeState'] == 'running', 'Reviewed graph repair resumes waiting start')
    assert child.app(consumer)['version'] == '0.2.0'
    say('PASS: a reviewed dependency repair preserves pending start and launches the updated consumer')
    success = True
finally:
    cleanup_ok = False
    try:
        if child_record:
            child_root = Path(child_record['dataRoot']) if child_record.get('dataRoot') else None
            environment_action('finish')
            assert child_record['state'] == 'finished' and not child_record.get('process')
            assert child_root is None or not child_root.exists(), 'Child data root survived Finish'
            for kind in (['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']):
                assert not run(['docker', *kind, '--filter', 'label=hosty.instance=' + child_record['id']]), 'Owned Docker resources survived Finish'
            say('PASS: owner Finish removed child data, process and Docker resources')
        cleanup_ok = True
    finally:
        if process and process.poll() is None:
            # This disposable fixture owns the parent process; child cleanup remains owner-led above.
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=45)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        if cleanup_ok:
            run(['docker', 'image', 'rm', image])
        say(('PASS' if success and cleanup_ok else 'FAIL') + ': dependency startup acceptance; local diagnostics=' + str(base))

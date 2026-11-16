"""A real Core-assigned Local provider port move with an unchanged Docker consumer.

Only the disposable managed child's scripted Codex account is used. Public Core
plan/apply and lifecycle operations move the listener; no registry or app data is edited.
"""
import json
import os
import pathlib
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def _owned_child(context):
    child = context.get('child') or {}
    root = pathlib.Path(context['root']).resolve()
    assert context.get('managed') is True and context.get('child_id') == child.get('id')
    assert child.get('id') and child.get('state') == 'running'
    assert pathlib.Path(child['dataRoot']).resolve() == root
    parent = context.get('parent')
    assert parent and pathlib.Path(parent[0]).resolve() != root, 'Port acceptance requires a separate owned child Core'
    endpoint = urllib.parse.urlparse(context['origin'])
    assert endpoint.hostname in ('localhost', '127.0.0.1', '::1') and endpoint.port == child['port']
    return root


def _listener(url):
    parsed = urllib.parse.urlparse(url)
    assert parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')
    assert parsed.port and not parsed.username and not parsed.password
    return parsed.hostname, parsed.port


def _bound_listener(browser_origin, endpoint):
    # Core deliberately separates browser aliases from raw process endpoints.
    # Dial only its literal loopback URL; keep the exact declared browser origin
    # for normal PKCE/cookies instead of resolving arbitrary caller-supplied names.
    raw = endpoint['url']
    _, port = _listener(raw)
    browser = urllib.parse.urlparse(browser_origin)
    expected = urllib.parse.urlparse(endpoint.get('browserOrigin') or raw)
    assert browser.scheme == 'http' and not browser.username and not browser.password
    assert browser.hostname in ('localhost', '127.0.0.1', '::1') or (browser.hostname or '').endswith('.localhost')
    assert (browser.scheme, browser.hostname, browser.port) == (expected.scheme, expected.hostname, expected.port)
    assert browser.port == port and browser.path in ('', '/') and not browser.query and not browser.fragment
    return raw


def _tcp_open(url):
    host, port = _listener(url)
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except (ConnectionError, TimeoutError, OSError):
        return False


def _alive(pid):
    assert isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    try:
        os.kill(pid, 0)  # Read-only liveness check of the exact Core-reported owned process.
        return True
    except ProcessLookupError:
        return False


def _identity(health, service):
    rows = [row for row in health['services'] if row['service'] == service]
    assert len(rows) == 1
    row = rows[0]
    assert isinstance(row.get('processId'), int) and not isinstance(row['processId'], bool) and row['processId'] > 0
    # Core's Local health reports a PID but no start timestamp. Replacement is
    # independently checked below with live/new PID and absent old PID/listener.
    return row['processId'], row.get('startedAt')


def _selection(connection):
    assert connection['kind'] == 'agent' and connection['available'] is True
    ref = {key: connection['provider'][key] for key in ('appId', 'installationId', 'key')}
    assert all(isinstance(value, str) and value for value in ref.values())
    assert isinstance(connection['revision'], str) and connection['revision']
    return {'id': connection['id'], 'revision': connection['revision'], 'provider': ref}


def _completed(run, provider, session_id=None):
    assert run['ref']['provider'] == provider
    if session_id is not None:
        assert run['sessionId'] == session_id
    assert run['freshness'] == 'current' and run['state'] == 'succeeded' and run['stopConfirmed'] is True
    assert run['effects'] == {'certainty': 'known', 'unresolvedCallIds': []}
    assert not run.get('pending') and not run.get('pendingContinuations')


def _native_binding(root, provider, run, consumer, user):
    # Observe only the exact child-owned aggregate's identity metadata, never account files.
    path = root/'apps'/provider['appId']/'data/agent-sessions'/(run['sessionId']+'.json')
    assert path.resolve().is_relative_to(root) and not path.is_symlink()
    value = json.loads(path.read_bytes())
    assert value['id'] == run['sessionId'] and value['session']['ref'] == {'provider': provider, 'id': run['sessionId']}
    assert value['owner']['callerAppId'] == consumer and value['owner']['userId'] == user
    assert value['session']['nativeState'] == 'available' and isinstance(value.get('nativeId'), str) and value['nativeId']
    return value['nativeId']


def _read_result(client, url):
    events, size, deadline = [], 0, time.monotonic()+90
    with client.open(url, timeout=30) as response:
        assert response.status == 200 and response.headers.get('Content-Type', '').startswith('text/event-stream')
        for raw in response:
            size += len(raw)
            assert size <= 2*1024*1024 and len(events) < 512, 'Port fixture event budget exceeded'
            if time.monotonic() > deadline:
                raise TimeoutError('Port fixture did not receive its bounded terminal event')
            if not raw.startswith(b'data: '):
                continue
            envelope = json.loads(raw[6:])
            event = envelope.get('event', envelope)
            assert event.get('type') not in ('error', 'approval_request', 'question_request'), 'Unexpected port-fixture native event'
            events.append(event)
            if event.get('type') == 'result':
                return events
    raise AssertionError('Port fixture stream closed before its result')


def _assert_port_change(plan, result, app, service, key, old_url):
    assert plan['appId'] == result['appId'] == app
    assert plan['service'] == result['service'] == service and plan['portKey'] == result['portKey'] == key
    assert plan['ownerRunning'] is True and not plan['affectedDependents']
    assert plan['currentPort'] == result['oldPort'] == _listener(old_url)[1]
    assert _listener(plan['currentUrl'])[1] == plan['currentPort']
    assert result['newPort'] != result['oldPort'] and _listener(result['newUrl'])[1] == result['newPort']
    assert result['restartRequiredAppIds'] == [app], 'Only the selected provider may require restart'


def check(context, app, app_origin, call, client):
    root = _owned_child(context)
    assert context['scenario'] == 'agent-providers', 'Port acceptance requires the actual Docker Harness profile'
    providers, request, wait, say = (context[key] for key in ('agentProviders', 'request', 'wait_for', 'say'))
    entry = providers.entries['codex']
    connection = providers.configure_for_harness(app_origin, call, 'codex', 'Assigned-port continuity',
        secret='synthetic-port-continuity-only')
    selected = _selection(connection)
    manifest = json.loads((pathlib.Path(context['workspace'])/'apps/codex-provider/manifest.json').read_bytes())
    assert manifest['id'] == selected['provider']['appId'] == entry['appId']
    interface = next(item for item in manifest['interfaces']['agent'] if item['key'] == selected['provider']['key'])
    endpoint = next(item for item in manifest['endpoints'] if item['key'] == interface['endpoint'])
    service, key = endpoint['service'], endpoint['port']
    assert next(item for item in request('/api/apps')['apps'] if item['id'] == app)['selectedRuntime'] == 'docker'
    session = call(app_origin, '/api/sessions', {'title': 'Assigned provider port continuity', 'connectionId': selected['id']})
    route = '/api/sessions/'+session['id']
    current = lambda: call(app_origin, route)

    def hello(previous=None):
        after = current()['lastEventSeq']
        receipt = call(app_origin, route+'/messages', {'text': 'hello', 'clientRequestId': str(uuid.uuid4())})
        assert receipt['state'] == 'accepted'
        def finished():
            run = (current().get('providerExecution') or {}).get('run') or {}
            if not run.get('ref') or previous and run['ref']['id'] == previous['ref']['id']:
                return None
            assert run['ref']['provider'] == selected['provider']
            if previous:
                assert run['sessionId'] == previous['sessionId']
            assert run['state'] not in ('failed', 'unknown'), 'Port fixture lost its authorized provider execution'
            return run if run.get('stopConfirmed') else None
        events = _read_result(client, app_origin+route+'/events?after='+str(after))
        assert any(event.get('type') == 'assistant_text' and event.get('text') == 'hello' for event in events)
        run = wait(finished, 90)
        _completed(run, selected['provider'], previous['sessionId'] if previous else None)
        return run

    first = hello()
    native_id = _native_binding(root, selected['provider'], first, app, context['user'])
    harness_identity = context['harnessRuntimeIdentity']()
    provider_route = '/api/apps/'+urllib.parse.quote(entry['appId'], safe='')
    def core_endpoint():
        owner = next(item for item in request('/api/apps')['apps'] if item['id'] == entry['appId'])
        return next(item for item in owner['endpoints'] if item['key'] == interface['endpoint'])
    old_url = _bound_listener(entry['origin'], core_endpoint())
    before_identity = _identity(request(provider_route+'/health'), service)
    assert _alive(before_identity[0]) and _tcp_open(old_url)
    plan = request(provider_route+'/ports/reassign/plan', {'service': service, 'portKey': key})
    result = request(provider_route+'/ports/reassign', {'service': service, 'portKey': key,
        'digest': plan['digest'], 'mode': 'automatic'})
    _assert_port_change(plan, result, entry['appId'], service, key, old_url)
    assert _identity(request(provider_route+'/health'), service) == before_identity
    assert _alive(before_identity[0]) and _tcp_open(old_url) and not _tcp_open(result['newUrl']), 'Plan/apply must not silently restart its owner'
    providers.restart('codex')  # Only this proved-quiescent provider; Harness stays up.
    after_identity = _identity(request(provider_route+'/health'), service)
    assert after_identity != before_identity and after_identity[0] != before_identity[0]
    assert _alive(after_identity[0])
    new_url = _bound_listener(entry['origin'], core_endpoint())
    wait(lambda: not _alive(before_identity[0]) and not _tcp_open(old_url) and _tcp_open(new_url), 30)
    assert _listener(new_url)[1] == result['newPort']
    anonymous = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with anonymous.open(entry['origin']+interface['path']+'/capabilities', timeout=15):
            raise AssertionError('The new provider endpoint admitted an anonymous execution client')
    except urllib.error.HTTPError as error:
        try:
            assert error.code == 401
        finally:
            error.close()
    own = providers.call(entry['origin'], '/api/settings/connections')['connections']
    account = next(item for item in own if item['id'] == entry['connection']['id'])
    assert account['revision'] == entry['connection']['revision']
    refreshed = providers.harness_connection(app_origin, call, 'codex')
    assert _selection(refreshed) == selected
    assert call(app_origin, route+'/credentials', {}) == {'updated': True}
    second = hello(first)
    assert second['ref']['id'] != first['ref']['id'] and second['configurationRevision'] == first['configurationRevision']
    assert _native_binding(root, selected['provider'], second, app, context['user']) == native_id
    assert context['harnessRuntimeIdentity']() == harness_identity, 'Refreshing a provider endpoint must not restart Docker Harness'
    say('PASS: assigned Local provider port changed '+str(result['oldPort'])+' -> '+str(result['newPort'])+
        '; old listener closed, replacement PID/authenticated SSE and same public/native binding verified without a Harness restart')

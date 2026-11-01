"""Canonical Core acceptance composed into the isolated managed session journey."""
import json
import pathlib
import urllib.error
import urllib.request
import uuid


def empty_core(context):
    request, say, origin = (context[key] for key in ('request', 'say', 'origin'))
    assert request('/api/apps')['apps'] == []
    for domain in ('tasks', 'history', 'agent-sessions'):
        assert request('/api/'+domain+'/v1/providers')['providers'] == []
    credential = request('/api/auth/credentials', {'label': 'Disposable canonical MCP acceptance', 'audience': 'hosty:core',
        'scopes': ['mcp:read', 'mcp:workspaces', 'mcp:environments-read', 'mcp:environments-manage',
                   'mcp:tasks-read', 'mcp:history-read', 'mcp:agent-sessions-read']}, confirm_settings=True)
    context['diagnostic_secrets'].add(credential['token'])
    sequence = 0
    def rpc(method, params):
        nonlocal sequence
        sequence += 1
        body = {'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params}
        req = urllib.request.Request(origin+'/api/mcp', data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer '+credential['token'], 'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=180) as response:
            raw = response.read().decode()
        envelopes = [json.loads(raw)] if raw.lstrip().startswith('{') else [json.loads(line[5:]) for line in raw.splitlines() if line.startswith('data:')]
        envelope = next(value for value in envelopes if value.get('id') == sequence)
        assert 'error' not in envelope, envelope.get('error')
        return envelope['result']
    def tool(name, arguments=None):
        result = rpc('tools/call', {'name': name, 'arguments': arguments or {}})
        assert not result.get('isError'), result
        return result.get('structuredContent') or json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))
    rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'canonical-core-acceptance', 'version': '1'}})
    catalog = rpc('tools/list', {})['tools']
    names = {entry['name'] for entry in catalog}
    assert {'prepare_workspace', 'environment_create', 'history_search', 'task_list', 'agent_run_get'} <= names
    for entry in catalog:
        descriptor = entry['_meta']['io.hosty/core-tool']
        assert descriptor['owner'] == 'hosty:core' and descriptor['schemaVersion'] == 1
    assert tool('list_workspaces')['workspaces'] == []
    child = None
    try:
        create = {'requestId': str(uuid.uuid4()), 'label': 'Sessionless canonical MCP fixture', 'mode': 'current'}
        child = tool('environment_create', {'input': create})
        assert tool('environment_create', {'input': create})['id'] == child['id']
        start = {'requestId': str(uuid.uuid4()), 'expectedRevision': child['revision']}
        child = tool('environment_start', {'environmentId': child['id'], 'input': start})
        assert child['state'] == 'running' and child['process']['pid'] > 0
        observed = tool('environment_status', {'environmentId': child['id']})
        assert observed['process']['pid'] == child['process']['pid']
        assert any(e['id'] == child['id'] for e in tool('environment_list')['environments'])
        child = tool('environment_stop', {'environmentId': child['id'], 'input': {'requestId': str(uuid.uuid4()), 'expectedRevision': observed['revision']}})
        assert child['state'] == 'stopped'
    finally:
        if child:
            observed = tool('environment_status', {'environmentId': child['id']})
            finished = tool('environment_finish', {'environmentId': child['id'], 'input': {'requestId': str(uuid.uuid4()), 'expectedRevision': observed['revision']}})
            assert finished['state'] == 'finished'
            assert not pathlib.Path(child['dataRoot']).exists()
    request('/api/auth/credentials/'+credential['id'], method='DELETE', confirm_settings=True)
    say('PASS: empty Core registry, canonical MCP feature metadata and replayed sessionless environment lifecycle with verified disposal')


def harness_history(context, owner, member, conversation):
    origin, say = context['origin'], context['say']
    def call(browser, path, body=None, expected=200):
        return browser.call(origin, '/api/history/v1'+path, body, expected=expected)
    providers = call(owner, '/providers')['providers']
    source = next(p for p in providers if p['appId'] == 'hosty.harness')
    provider = {key: source[key] for key in ('appId', 'installationId', 'key')}
    reference = {'provider': provider, 'id': conversation['id']}
    value = call(owner, '/conversations/get', {'conversation': reference})
    assert value['ref'] == reference
    call(member, '/conversations/get', {'conversation': reference}, expected=(403, 404))
    assert call(owner, '/capabilities', {'provider': provider})['version'] == 1
    shared = call(owner, '/shares/create', {'ref': reference, 'requestId': str(uuid.uuid4()), 'expectedRevision': value['revision'],
        'selection': {'includeFutureEntries': True}, 'recipientUserIds': [member.user], 'includeAttachments': False, 'extensions': []})
    assert call(member, '/conversations/get', {'conversation': reference})['ref'] == reference
    call(member, '/entries/query', {'conversation': reference})
    call(member, '/shares/create', {'ref': reference, 'requestId': str(uuid.uuid4()), 'expectedRevision': shared['conversationRevision'],
        'selection': {'includeFutureEntries': True}, 'recipientUserIds': [owner.user]}, expected=403)
    revoked = call(owner, '/shares/revoke', {'ref': reference, 'grantId': shared['grant']['id'], 'requestId': str(uuid.uuid4()),
        'expectedRevision': shared['conversationRevision']})
    assert revoked['grant']['state'] == 'revoked'
    call(member, '/entries/query', {'conversation': reference}, expected=(403, 404))
    catalog = owner.harness('/settings/tools')
    core = next(c for c in catalog['catalogs'] if c['provider'] == 'hosty:core')
    local = next(c for c in catalog['catalogs'] if c.get('localOwner'))
    assert local['localOwner']['appId'] == 'hosty.harness' and local['localOwner']['installationId'] == source['installationId']
    private_names = {t['name'] for t in local['tools']}
    assert 'task_result' in private_names and 'prepare' not in private_names and 'environment_start' not in private_names
    assert 'environment_start' in {t['name'] for t in core['tools']}
    assert catalog['settings']['mcpCoreMigration']['version'] == 1
    say('PASS: authoritative Harness history, named-user sharing/revocation, no resharing and canonical/private catalog ownership')

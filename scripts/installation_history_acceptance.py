"""Verify multi-user delivery through the real Harness and provider inside the disposable child."""
import http.server
import json
import pathlib
import re
import threading
import urllib.parse
import urllib.request
import uuid

from workspace_sessions_acceptance import session_browser


def authorize_workspace_preparation(context, browser, app):
    """Review the isolated consumer and allow only the fixture's selected tool to run without a prompt."""
    origin = context['origin']
    def offered():
        targets = browser.call(origin, '/api/core/agents')['targets']
        return any(target['id'] == 'hosty:core' and app in target['assistantIds'] for target in targets)
    if not offered():
        with browser.client.open(origin + '/install/agents/' + urllib.parse.quote(app, safe='') + '/hosty:core', timeout=30) as response:
            review = response.geturl()
            nonce = re.search(r'name=nonce value="([^"]+)"', response.read().decode()).group(1)
        assert review.startswith(origin + '/install/confirm/')
        context['diagnostic_secrets'].add(nonce)
        decision = urllib.parse.urlencode({'nonce': nonce, 'decision': 'approve', 'agentEnabled': 'true'}).encode()
        with browser.client.open(urllib.request.Request(review, data=decision,
                headers={'Origin': origin, 'Content-Type': 'application/x-www-form-urlencoded'}), timeout=30) as response:
            response.read()
        context['wait_for'](offered, 30)
    catalogs = browser.harness('/settings/tools')
    core = next(catalog for catalog in catalogs['catalogs'] if catalog['provider'] == 'hosty:core')
    assert any(tool['name'] == 'prepare_workspace' for tool in core['tools'])
    policy_key = json.dumps(['hosty:core', 'prepare_workspace'], separators=(',', ':'))
    browser.harness('/settings/mcp/preferences', {'revision': catalogs['mcpRevision'], 'defaults': {}, 'resetProviders': [],
        'rules': {policy_key: {'identity': core['identity'], 'mode': 'run'}}}, method='PUT')


def check(context, app, app_origin, link, timed):
    wait = context['wait_for']
    Browser = session_browser(context, app, app_origin, link)
    alice = Browser('activation-fixture@example.test', 'First operator')
    bob = Browser('history-second@example.test', 'Second operator', invited=True)
    assert alice.user != bob.user
    authorize_workspace_preparation(context, alice, app)
    providers = context['agentProviders']
    connection = providers.configure_for_harness(app_origin, alice.call, 'codex', 'Installation history',
                                                secret='synthetic-installation-history')
    assert 'installation-history' in connection['capabilities']
    folder = context['root'] / 'apps' / app / 'data' / 'sessions'
    provider_folder = context['root'] / 'apps' / providers.entries['codex']['appId'] / 'data' / 'agent-sessions'
    markers = {uuid.uuid4().hex: threading.Event() for _ in range(3)}
    source_marker = next(iter(markers))
    prepared = {}
    release = threading.Event()

    class Gate(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            marker = url.path.removeprefix('/')
            observed = markers.get(marker)
            if not observed:
                self.send_error(404)
                return
            query = urllib.parse.parse_qs(url.query)
            if marker == source_marker:
                if not all(len(query.get(key, [])) == 1 for key in ('workspace', 'worktree')):
                    self.send_error(400)
                    return
                prepared.update(workspace=query['workspace'][0], worktree=query['worktree'][0])
            observed.set()
            self.send_response(200 if release.wait(110) else 503)
            self.end_headers()

        def log_message(self, *args):
            pass

    chats = []
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Gate) as server:
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for owner, marker in zip((alice, alice, bob), markers):
                chat = owner.harness('/sessions', {'title': 'History ' + marker[:8], 'connectionId': connection['id']})
                route = '/sessions/' + chat['id']
                prompt = f'HISTORY_ACCEPTANCE:{server.server_port}:{marker}'
                if marker == source_marker:
                    prompt += ' WORKSPACE_SOURCE:' + app
                owner.harness(route + '/messages', {'text': prompt,
                                                    'clientRequestId': str(uuid.uuid4())}, expected=(200, 201, 202))
                chats.append((owner, chat['id'], marker))
            if not all(arrived.wait(60) for arrived in markers.values()):
                states = []
                for index, (owner, chat_id, marker) in enumerate(chats):
                    record = owner.harness('/sessions/' + chat_id)
                    snapshot = (record.get('providerExecution') or {}).get('run') or {}
                    error = (snapshot.get('result') or {}).get('error') or {}
                    states.append((index, markers[marker].is_set(), record['status'], snapshot.get('state'), error.get('code')))
                raise AssertionError(f'Native gates before shutdown (chat, arrived, chat state, run state, error): {states}')
            identities = [json.loads((folder / chat_id / 'provider-execution.json').read_text()) for _, chat_id, _ in chats]
            assert len({row['runId'] for row in identities}) == 3
            participants = '/development-workspaces/' + prepared['workspace'] + '/participants'
            tree_route = '/development-workspaces/' + prepared['workspace'] + '/worktrees/' + prepared['worktree']
            tree = alice.harness(tree_route)
            source = pathlib.Path(tree['path']).resolve()
            assert source.is_relative_to(context['root'].resolve())
            dirty_file = source / ('history-' + source_marker + '.txt')
            assert dirty_file.read_text() == source_marker
            original_head = context['run'](['git', '-C', source, 'rev-parse', 'HEAD'])
            def roster():
                rows = alice.harness(participants)['sessions']
                callers = [row for row in rows if row['canOpen']]
                assert len(callers) == 1 and callers[0]['sessionId'] == chats[0][1] and callers[0]['viewerPath']
                execution = [row for row in rows if row.get('kind') == 'execution']
                assert len(execution) == 1 and not execution[0]['canOpen'] and execution[0]['sessionId'] == identities[0]['sessionId']
                assert callers[0]['activityGroup'] == execution[0]['activityGroup']
                assert not any(row['canOpen'] or row.get('viewerPath') for row in bob.harness(participants)['sessions'])
            roster()
            context['run']([context['cli'], '--data-root', context['root'], 'apps', 'stop', app])
            release.set()

            def finished(row):
                provider_session = json.loads((provider_folder / (row['sessionId'] + '.json')).read_text())
                run = provider_session['runs'][row['runId']]['snapshot']
                return run['state'] == 'succeeded' and run['stopConfirmed']
            wait(lambda: all(finished(row) for row in identities), 90)
            timed('start')

            def answers(chat_id):
                journal = (folder / chat_id / 'events.ndjson').read_text().splitlines()
                return [event['text'] for event in map(json.loads, journal) if event.get('type') == 'assistant_text']

            # No browser traffic to Harness after the restart until every transcript is on disk.
            def recovered(chat_id, marker):
                record = json.loads((folder / chat_id / 'record.json').read_text())
                return record['status'] == 'idle' and 'Completed ' + marker in answers(chat_id)
            wait(lambda: all(recovered(chat_id, marker) for _, chat_id, marker in chats), 90)
            for identity in identities:
                retained = json.loads((provider_folder / (identity['sessionId'] + '.json')).read_text())
                assert set(retained['runs']) == {identity['runId']}, 'Catch-up must not start another native run'
            for owner, chat_id, marker in chats:
                route = '/sessions/' + chat_id
                assert [answer for answer in answers(chat_id) if answer.startswith('Completed ')] == ['Completed ' + marker]
                session = owner.harness(route)
                assert session['providerExecution']['run']['state'] == 'succeeded'
                assert session['providerExecution']['run']['stopConfirmed']
                (bob if owner is alice else alice).harness(route, expected=(403, 404))
            owner, chat_id, marker = chats[0]
            route = '/sessions/' + chat_id
            owner.harness(route + '/credentials', {})
            assert owner.harness(route + '/cancel', {}) == {'cancelled': False}
            assert owner.harness(route)['status'] == 'idle'
            journal = [json.loads(line) for line in (folder / chat_id / 'events.ndjson').read_text().splitlines()]
            assert not any(event.get('type') == 'session_status' and event.get('status') == 'cancelled' for event in journal)
            assert answers(chat_id).count('Completed ' + marker) == 1
            native = json.loads((provider_folder / (identities[0]['sessionId'] + '.json')).read_text())
            run_id = identities[0]['runId']
            assert set(native['runs']) == {run_id} and native['runs'][run_id]['snapshot']['state'] == 'succeeded'
            context['say']('PASS: Stop on an already completed turn preserved its result and original status in the HTTP response and conversation')
            roster()
            assert alice.harness(tree_route)['path'] == tree['path']
            assert context['run'](['git', '-C', source, 'rev-parse', 'HEAD']) == original_head
            assert dirty_file.read_text() == source_marker
            assert dirty_file.name in context['run'](['git', '-C', source, 'status', '--porcelain', '--', dirty_file.name])
            context['say']('PASS: native Core MCP preparation replayed the same worktree, linked only the originating chat, and preserved its execution row, private access and dirty source across Harness restart')
            context['say']('PASS: two password users, three chats, native completions while Docker Harness was stopped; all three results persisted exactly once before a browser returned, each visible only to its owner')
        finally:
            release.set()
            server.shutdown()
            thread.join()

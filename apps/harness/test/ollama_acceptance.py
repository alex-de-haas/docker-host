"""Ollama agent acceptance through a normally authenticated, Core-managed Harness."""
import http.server
import importlib.util
import pathlib
import json
import os
import re
import threading
import uuid
import urllib.parse
import urllib.request
from agent_provider_acceptance import execution_stopped


def _assert_context_observations(observations, requests, *, complete_ledger=False, latest=False):
    """Join received root context to its controlled ordinary response, not an offline ledger."""
    assert observations and requests, 'Expected actual ordinary model requests and context observations'
    # This fixture supports ordinary tool-capable turns only. Compaction or another
    # hidden inference request cannot silently enter the ordinary-response accounting.
    assert all(request.get('tools') and request.get('messages')
        and request['messages'][0].get('role') == 'system'
        and request['messages'][0].get('content', '').startswith('You are a coding assistant in Hosty.')
        for request in requests), 'Unexpected non-ordinary fixture model request'
    previous = -1
    definitions = {}
    for request in requests:
        for tool in request['tools']:
            function = tool['function']
            if not function['name'].startswith('mcp_'): continue
            display = function['description'].split(' — ', 1)[0]
            assert display.startswith('mcp__') and '__' in display[5:], 'Expected an explicitly namespaced MCP definition'
            identity = tuple(display[5:].split('__', 1))
            tokens = (len(json.dumps(tool, separators=(',', ':'), ensure_ascii=False).encode()) + 3) // 4
            assert identity not in definitions or definitions[identity] == tokens, 'Fixture MCP definitions changed between requests'
            definitions[identity] = tokens
    for observation in observations:
        count = observation.get('usedTokens')
        assert isinstance(count, int) and not isinstance(count, bool), 'Expected a controlled ordinary prompt count'
        index = count - 101
        assert previous < index < len(requests), ('Context must name one new, ordered actual ordinary response', previous, index, len(requests))
        previous = index
        assert observation['maxTokens'] == 32768 and observation['estimated'] is False
        assert isinstance(observation.get('observedAt'), str) and observation['observedAt'], 'Expected the actual observation timestamp'
        detail = observation['mcp']
        assert detail['version'] == 1 and detail['method'] == 'local-estimate' and detail['estimator'] == 'utf8-json-div4-v1'
        assert isinstance(detail['omittedTools'], int) and not isinstance(detail['omittedTools'], bool) and detail['omittedTools'] >= 0
        assert isinstance(detail['tools'], list) and len(detail['tools']) <= 256, 'Expected bounded MCP context detail'
        sent = {}
        for tool in requests[index]['tools']:
            function = tool['function']
            if function['name'].startswith('mcp_'):
                sent[tuple(function['description'].split(' — ', 1)[0][5:].split('__', 1))] = tool
        identities = set()
        for row in detail['tools']:
            assert set(row) == {'server', 'name', 'tokens', 'inclusion'}
            identity = (row['server'], row['name'])
            assert all(isinstance(value, str) and value for value in identity) and identity not in identities
            identities.add(identity)
            assert isinstance(row['tokens'], int) and not isinstance(row['tokens'], bool) and row['tokens'] > 0
            assert row['inclusion'] == ('loaded' if identity in sent else 'available'), 'MCP inclusion differs from the exact model request'
            if identity in definitions:
                assert row['tokens'] == definitions[identity], 'MCP token estimate differs from the actual wire definition'
        assert set(sent) <= identities, 'A sent MCP definition is missing from its context observation'
    if complete_ledger:
        assert len(observations) == len(requests), 'Every online ordinary step must report its context'
    if latest:
        assert previous == len(requests) - 1, 'The latest ordinary context must be recovered, including after consumer downtime'


def _wait_pending_question(read, expected, event, wait, say):
    """A Harness SSE card may precede its REST projection's durable commit."""
    prefix = 'agent-decision-'
    card = event['questionId']
    assert card.startswith(prefix) and len(card) <= 8192, 'Expected a bounded run-qualified question card'
    identity = json.loads(bytes.fromhex(card[len(prefix):]))
    assert isinstance(identity, list) and len(identity) == 2 and all(isinstance(value, str) and value for value in identity)
    assert card == prefix+json.dumps(identity, separators=(',', ':'), ensure_ascii=False).encode().hex(), 'Question card encoding changed'
    assert identity[0] == expected['ref']['id'], 'The question belongs to another public run'
    assert event['providerGeneration'] == expected['generation'], 'The question belongs to another public generation'
    observed = {}

    def current():
        nonlocal observed
        state = read()
        questions = [item for item in state.get('pending', []) if item.get('kind') == 'question']
        observed = {key: state.get(key) for key in ('ref', 'sessionId', 'generation', 'configurationRevision', 'revision', 'state', 'phase', 'freshness', 'stopConfirmed')}
        observed['pendingQuestions'] = len(questions)
        assert state['ref'] == expected['ref'] and state['sessionId'] == expected['sessionId'], 'The public question execution binding changed'
        assert state['generation'] == expected['generation'] and state['configurationRevision'] == expected['configurationRevision'], 'The public question generation/configuration changed'
        assert state['stopConfirmed'] is False and state['state'] not in ('succeeded', 'failed', 'cancelled', 'unknown'), 'The question execution stopped or became unavailable before its pending projection'
        assert state['freshness'] == 'current', 'The question requires a current public execution'
        matches = [item for item in questions if item.get('id') == identity[1]]
        assert len(matches) <= 1, 'The exact question ID must identify one pending request'
        if not matches:
            return None
        pending = matches[0]
        assert pending['delivery'] == 'continue_run', 'The fixture question must retain its live callback'
        assert event['providerEventId'] == expected['ref']['id']+':decision:'+pending['id']+':'+pending['revision'], 'The exact question revision changed'
        projected = [{'id': question['id'], 'question': question['text'], 'header': question.get('header') or 'Question',
            'allowText': question.get('allowText') is not False, 'multiSelect': question.get('multiple') is True,
            'options': [{'id': option['id'], 'label': option['label'], 'description': option.get('description') or '',
                **({'preview': option['preview']} if option.get('preview') else {})} for option in question.get('options', [])]}
            for question in pending['questions']]
        assert projected == event['questions'], 'The exact question or option definition changed'
        return state, pending
    try:
        return wait(current, 30)
    finally:
        # State/identity counts only: question text, options and native output stay private.
        say('Question public projection: '+json.dumps(observed))


def _wait_pending_approval(read, expected, event, tool, wait, say):
    """Wait for this original Core tool approval without selecting a later run."""
    prefix = 'agent-decision-'
    card = event['approvalId']
    assert card.startswith(prefix) and len(card) <= 8192, 'Expected a bounded run-qualified approval card'
    identity = json.loads(bytes.fromhex(card[len(prefix):]))
    assert isinstance(identity, list) and len(identity) == 2 and all(isinstance(value, str) and value for value in identity)
    assert card == prefix+json.dumps(identity, separators=(',', ':'), ensure_ascii=False).encode().hex(), 'Approval card encoding changed'
    assert identity[0] == expected['ref']['id'] and event['providerGeneration'] == expected['generation'], 'The approval belongs to another public run/generation'
    assert event['toolName'] == tool['server']+': list_apps', 'Only the discovered safe Core tool may be held'
    observed = {}

    def current():
        nonlocal observed
        state = read()
        approvals = [item for item in state.get('pending', []) if item.get('kind') == 'approval']
        observed = {key: state.get(key) for key in ('ref', 'sessionId', 'generation', 'configurationRevision', 'revision', 'state', 'phase', 'freshness', 'stopConfirmed')}
        observed['pendingApprovals'] = len(approvals)
        assert state['ref'] == expected['ref'] and state['sessionId'] == expected['sessionId'], 'The public approval execution binding changed'
        assert state['generation'] == expected['generation'] and state['configurationRevision'] == expected['configurationRevision'], 'The public approval generation/configuration changed'
        assert state['stopConfirmed'] is False and state['state'] not in ('succeeded', 'failed', 'cancelled', 'unknown'), 'The approval execution stopped or became unavailable before its pending projection'
        assert state['freshness'] == 'current', 'The approval requires a current public execution'
        matches = [item for item in approvals if item.get('id') == identity[1]]
        assert len(matches) <= 1, 'The exact approval ID must identify one pending request'
        if not matches:
            return None
        pending = matches[0]
        assert pending['delivery'] == 'continue_run', 'The fixture approval must retain its live callback'
        assert event['providerEventId'] == expected['ref']['id']+':decision:'+pending['id']+':'+pending['revision'], 'The exact approval revision changed'
        assert pending.get('toolName') == event['toolName'] and pending.get('input') == event.get('input') and pending.get('title') == event.get('title'), 'The exact approval tool/argument definition changed'
        # The public decision has no MCP catalog digest. Native policy owns its
        # separately tested definition pin/revalidation; this checks the public request.
        return state
    try:
        return wait(current, 30)
    finally:
        say('Approval public projection: '+json.dumps(observed))


def check(context, app_origin, client, call, timed):
    say, wait_for = context['say'], context['wait_for']
    requests = []
    fixture_model = 'hosty-fixture:latest'
    core_tool = {}
    ttl_observation = {}
    ttl_enabled = os.environ.get('HOSTY_PROVIDER_MCP_TTL') == '1'
    if ttl_enabled:
        spec = importlib.util.spec_from_file_location('provider_mcp_ttl_acceptance', pathlib.Path(__file__).with_name('provider_mcp_ttl_acceptance.py'))
        ttl_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ttl_fixture)
        hold_core_approval, matches_core_approval = ttl_fixture.hold_core_approval, ttl_fixture.matches_core_approval

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, value, stream=False):
            payload = (json.dumps(value) + ('\n' if stream else '')).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson' if stream else 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def do_GET(self):
            if self.path == '/api/version': self.reply({'version':'acceptance'})
            elif self.path == '/api/tags': self.reply({'models':[{'name':fixture_model}]})
            else: self.send_error(404)
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == '/api/show':
                self.reply({'capabilities':['completion','tools'], 'model_info':{'fixture.context_length':32768}})
                return
            if self.path != '/api/chat':
                self.send_error(404)
                return
            requests.append(body)
            turn = len(requests)
            actions = [
                ('apply_patch', {'path':'ollama-acceptance.txt','old_text':'','new_text':'verified adapter'}),
                ('read_file', {'path':'ollama-acceptance.txt'}),
                ('run_command', {'command':'node -e "process.stdout.write(\'verified command\')"'}),
                ('ask_user', {'question':'Which check?', 'options':['Quick','Full']}),
                ('apply_patch', {'path':'denied.txt','old_text':'','new_text':'forbidden'}),
                ('read_file', {'path':'denied.txt'}),
                ('discover_tools', {'query':'list_apps'}),
                ('mcp_list', {}),

            ]
            message = {'role':'assistant','content':'Verified completion' if turn <= 9 else 'Verified continuation'}
            if turn <= len(actions):
                name, arguments = actions[turn - 1]
                if name == 'mcp_list':
                    matches = [tool['function'] for tool in body['tools']
                        if tool['function'].get('description', '').split(' — ', 1)[0].startswith('mcp__')
                        and tool['function']['description'].split(' — ', 1)[0].endswith('__list_apps')]
                    assert len(matches) == 1, 'Expected one reviewed Core list_apps definition; got '+repr([
                        tool['function'].get('description', '').split(' — ', 1)[0]
                        for tool in body['tools'] if tool['function']['name'].startswith('mcp_')])
                    selected = matches[0]
                    assert re.fullmatch(r'mcp_[a-f0-9]{24}', selected['name']), 'Expected the provider-generated opaque tool alias'
                    display = selected['description'].split(' — ', 1)[0]
                    core_tool.update(alias=selected['name'], display=display, server=display[len('mcp__'):-len('__list_apps')])
                    name = selected['name']
                message = {'role':'assistant','content':'','tool_calls':[{'function':{'name':name,'arguments':arguments}}]}
            # A unique controlled count joins each public observation to this exact
            # request even when only the latest offline context survives restoration.
            self.reply({'model':fixture_model,'message':message,'done':True,'prompt_eval_count':100+turn,'eval_count':10}, True)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def post(route, body): return call(app_origin, '/api'+route, body)
    def read(route): return call(app_origin, '/api'+route)
    def complete(session, after=0, expected_approvals=0):
        approvals, events, sequence, held_approval, held_snapshot = 0, [], after, None, None
        expected_run = read('/sessions/'+session)['providerExecution']['run']
        with client.open(app_origin+'/api/sessions/'+session+'/events?after='+str(after), timeout=180) as response:
            for raw in response:
                if not raw.startswith(b'data: '): continue
                envelope = json.loads(raw[6:])
                event = envelope.get('event', envelope)
                sequence = envelope.get('seq', sequence)
                events.append(event)
                if event.get('type') == 'error': raise AssertionError('Ollama run failed: '+event.get('message',''))
                if event.get('type') == 'approval_request':
                    approvals += 1
                    if ttl_enabled and not ttl_observation and matches_core_approval(event, core_tool):
                        held_snapshot = _wait_pending_approval(lambda: read('/sessions/'+session)['providerExecution']['run'],
                            expected_run, event, core_tool, wait_for, say)
                        held_approval = event
                        break
                    post('/sessions/'+session+'/approvals/'+event['approvalId'], {'decision':'deny' if event.get('input',{}).get('path') == 'denied.txt' else 'allow'})
                if event.get('type') == 'question_request':
                    # Questions now continue through their shared, revisioned Decisions record.
                    snapshot, pending = _wait_pending_question(lambda: read('/sessions/'+session)['providerExecution']['run'],
                        expected_run, event, wait_for, say)
                    expected = next(question for question in pending['questions'] if question['text'] == 'Which check?')
                    assert [option['label'] for option in expected['options']] == ['Quick', 'Full']
                    def matching_question():
                        matches = []
                        for row in read('/decisions')['items']:
                            value = row.get('input') or {}
                            subject = value.get('subject') or {}
                            questions = value.get('questions') or []
                            if row.get('state') != 'pending' or row.get('sourceAppId') != context['agentProviders'].entries['ollama']['appId']:
                                continue
                            if subject.get('kind') != 'agent-run' or subject.get('id') != snapshot['ref']['id'] or subject.get('revision') != snapshot['generation']:
                                continue
                            if value.get('correlationKey') != snapshot['ref']['id']+':'+pending['id']:
                                continue
                            if len(questions) != 1 or questions[0].get('id') != expected['id'] or questions[0].get('question') != expected['text']:
                                continue
                            if [(option['id'], option['label']) for option in questions[0].get('options') or []] != [(option['id'], option['label']) for option in expected['options']]:
                                continue
                            matches.append(row)
                        assert len(matches) <= 1, 'The exact provider question must identify one pending Decision'
                        return matches[0] if matches else None
                    decision = wait_for(matching_question, 30)
                    question = next(question for question in decision['input']['questions'] if question['id'] == expected['id'])
                    option = next(o for o in question['options'] if o['label'] == 'Quick')
                    post('/decisions/'+decision['id']+'/resolve', {'requestId':str(uuid.uuid4()),
                        'expectedRevision':decision['revision'], 'answers':{question['id']:{'optionIds':[option['id']]}}})
                if event.get('type') == 'result': break
        if held_approval:
            # Close the consumer SSE before stopping Harness. The provider-owned Core
            # response and MCP dispatch continue independently; replay resumes afterward.
            ttl_observation.update(hold_core_approval(context, app_origin, call, timed, session,
                held_approval, core_tool, requests, held_snapshot))
            sequence, replayed = complete(session, sequence)
            events.extend(replayed)
            restored = read('/sessions/'+session)['providerExecution']['run']
            assert restored['ref']['id'] == ttl_observation['runId']
            assert restored['generation'] == ttl_observation['generation']
            assert restored['configurationRevision'] == ttl_observation['configurationRevision']
            assert restored['state'] == 'succeeded' and restored['pending'] == []
            assert restored['effects']['certainty'] == 'known' and not restored['effects']['unresolvedCallIds']
        assert approvals == expected_approvals, (approvals, expected_approvals)
        assert any(e.get('type') == 'result' for e in events), 'No terminal result'
        wait_for(lambda: execution_stopped(read('/sessions/'+session)), 90)
        assert read('/sessions/'+session)['status'] == 'idle'
        return sequence, events

    try:
        # Review this installed consumer through the disposable child's normal administrator UI.
        # Catalog preview alone must not create a Core MCP execution grant.
        origin, app_id = context['origin'], context['harnessAppId']
        assert call(origin, '/api/auth/session')['authenticated']
        review_path = '/install/agents/'+urllib.parse.quote(app_id, safe='')+'/hosty:core'
        with client.open(origin+review_path, timeout=30) as response:
            review_url, review_html = response.geturl(), response.read().decode()
        assert review_url.startswith(origin+'/install/confirm/'), 'Core MCP review did not open its confirmation page'
        nonce = re.search(r'name=nonce value="([^"]+)"', review_html)
        assert nonce, 'Core MCP review has no decision nonce'
        context.get('diagnostic_secrets', set()).add(nonce.group(1))
        approved_input = urllib.parse.urlencode({'nonce':nonce.group(1), 'decision':'approve', 'agentEnabled':'true'}).encode()
        with client.open(urllib.request.Request(review_url, data=approved_input,
                headers={'Origin':origin, 'Content-Type':'application/x-www-form-urlencoded'}), timeout=30) as response:
            response.read()
        approval_id = urllib.parse.urlparse(review_url).path.rsplit('/', 1)[1]
        def approved():
            result = call(origin, '/api/installations/'+approval_id)
            assert result['status'] not in ('failed', 'denied', 'expired'), ('Core MCP review failed', result['status'])
            return result['status'] == 'succeeded'
        wait_for(approved, 30)
        target = next(target for target in call(origin, '/api/core/agents')['targets'] if target['id'] == 'hosty:core')
        assert app_id in target['assistantIds'], 'This installed consumer has no reviewed Core MCP grant'
        inventory = read('/settings/tools')
        catalog = next(catalog for catalog in inventory['catalogs'] if catalog['provider'] == 'hosty:core')
        assert any(tool['name'] == 'list_apps' for tool in catalog['tools']), 'The reviewed Core catalog has no safe list_apps tool'
        settings = read('/settings')['settings']
        assert settings['mcpProviders']['hosty:core'] is True
        # Exercise a deliberate approval, independently of any inherited read-only auto-allow.
        policy = {'mcpAutoAllow':{**settings['mcpAutoAllow'], 'hosty:core':False},
            'mcpToolRules':{json.dumps(['hosty:core', 'list_apps'], separators=(',', ':')):{'identity':catalog['identity'], 'mode':'ask'}}}
        with client.open(urllib.request.Request(app_origin+'/api/settings', data=json.dumps(policy).encode(), method='PUT',
                headers={'Origin':app_origin, 'Content-Type':'application/json'}), timeout=60) as response:
            assert response.status == 200
            response.read()
        say('PASS: normal child administrator review and explicit Ask policy authorize the Core list_apps fixture')

        if os.environ.get('HOSTY_OLLAMA_BROWSER'):
            import subprocess
            result = subprocess.run(['node', str(context['workspace']/'apps/harness/test/ollama-browser.mjs')],
                input=json.dumps({'core':context['origin'], 'harness':app_origin,
                    'email':'activation-fixture@example.test', 'password':context['password'],
                    'link':app_origin+'/assistant/', 'provider':context['agentProviders'].entries['ollama'],
                    'harnessAppId':context['harnessAppId'], 'ollama':'http://127.0.0.1:'+str(server.server_port)}),
                text=True, cwd=context['workspace'])
            assert result.returncode == 0, 'Ollama browser acceptance failed'
        connection = context['agentProviders'].configure_for_harness(app_origin, call, 'ollama',
            'Ollama acceptance', auth='none', base_url='http://127.0.0.1:'+str(server.server_port))
        assert post('/connections/'+connection['id']+'/test', {})['available']
        assert read('/connections/'+connection['id']+'/models')['defaultModel'] == fixture_model
        chat = post('/sessions', {'title':'Ollama acceptance','connectionId':connection['id'],'profileId':None,'skillIds':[],'appIds':[]})
        tree = post('/sessions/'+chat['id']+'/workspaces', {'action':'prepare','appId':app_id,'requestId':str(uuid.uuid4()),'name':'Ollama coding acceptance'})
        assert tree.get('path') and tree.get('id'), 'Expected a registered Core worktree'
        post('/sessions/'+chat['id']+'/messages', {'text':'Create the fixture file, read it and run the check.','clientRequestId':str(uuid.uuid4())})
        sequence, events = complete(chat['id'], expected_approvals=4)
        assert any(e.get('type') == 'assistant_text' and e.get('text') == 'Verified completion' for e in events), 'Completed answer must enter the durable transcript'
        assert any(e.get('type') == 'command_result' and e.get('exitCode') == 0 for e in events)
        assert any(e.get('type') == 'tool_result' and 'verified adapter' in e.get('output','') for e in events)
        assert any(e.get('type') == 'question_request' for e in events)
        assert core_tool and core_tool['alias'], 'Discovery did not expose the reviewed Core tool'
        mcp = next(e for e in events if e.get('type') == 'tool_use' and e.get('toolName') == core_tool['display'])
        assert any(e.get('type') == 'tool_result' and e.get('toolUseId') == mcp['toolUseId'] and e.get('status') == 'completed' for e in events)
        assert any(e.get('type') == 'tool_result' and 'ENOENT' in e.get('output','') for e in events)
        observations = [e['usage'] for e in events if e.get('type') == 'context_usage' and e.get('usage')]
        _assert_context_observations(observations, requests, complete_ledger=not ttl_enabled, latest=True)
        say('Context acceptance: matched ' + str(len(observations)) + ' root observations to ' + str(len(requests))
            + ' ordinary requests; latest prompt count ' + str(observations[-1]['usedTokens'])
            + ', catalog rows ' + str(len(observations[-1]['mcp']['tools']))
            + ', omitted ' + str(observations[-1]['mcp']['omittedTools']))
        assert all(t['inclusion'] == 'available' for t in observations[0]['mcp']['tools'])
        assert any(t['server'] == core_tool['server'] and t['name'] == 'list_apps' and t['inclusion'] == 'loaded'
                   for t in observations[-1]['mcp']['tools'])
        say('PASS: Ollama context metadata follows actual requests, with local estimates and separate available definitions')
        say('PASS: Ollama discovery, approvals, patch/read/command, question answer, denied write and scoped MCP receipts')
        if ttl_enabled:
            assert ttl_observation, 'The opt-in TTL scenario must actually hold the configured Core approval'
            say('PASS: Harness reconnect replays the original run, completed Core tool receipt and authoritative native-stop proof after MCP TTL expiry')
        timed('restart')
        post('/sessions/'+chat['id']+'/messages', {'text':'Continue without repeating any action.','clientRequestId':str(uuid.uuid4())})
        _, resumed = complete(chat['id'], sequence)
        assert any(e.get('type') == 'assistant_text' and e.get('text') == 'Verified continuation' for e in resumed), 'Resumed answer must enter the durable transcript'
        assert not any(e.get('type') == 'tool_use' for e in resumed)
        assert any(m.get('role') == 'tool' for m in requests[-1]['messages'])
        restored = next(e['usage'] for e in resumed if e.get('type') == 'context_usage' and e.get('usage'))
        _assert_context_observations([restored], requests, latest=True)
        assert restored['mcp']['method'] == 'local-estimate'
        assert all(t['inclusion'] == 'available' for t in restored['mcp']['tools'])
        say('PASS: Harness restart resumes provider-owned Ollama context without replaying completed tools')

        if endpoint := os.environ.get('HOSTY_OLLAMA_URL'):
            actual = context['agentProviders'].configure_for_harness(app_origin, call, 'ollama',
                'Existing host Ollama', auth='none', base_url=endpoint)
            catalog = read('/connections/'+actual['id']+'/models')
            assert catalog.get('defaultModel'), 'Host Ollama has no compatible installed model'
            real = post('/sessions', {'title':'Host Ollama smoke','connectionId':actual['id'],'profileId':None,'skillIds':[],'appIds':[]})
            post('/sessions/'+real['id']+'/messages', {'text':'Reply with a single short greeting. Do not use tools.','clientRequestId':str(uuid.uuid4())})
            _, observed = complete(real['id'])
            assert any(e.get('type') in ('assistant_delta','assistant_text') and e.get('text') for e in observed)
            say('PASS: existing host Ollama model '+catalog['defaultModel']+' completed a real authenticated Harness turn')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

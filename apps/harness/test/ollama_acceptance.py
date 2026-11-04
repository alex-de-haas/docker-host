"""Ollama agent acceptance through a normally authenticated, Core-managed Harness."""
import http.server
import json
import os
import threading
import uuid
import urllib.request


def check(context, app_origin, client, call, timed):
    say, wait_for = context['say'], context['wait_for']
    requests = []
    fixture_model = 'hosty-fixture:latest'

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
                # Context discovery remains on Harness MCP and needs no optional Core MCP offer.
                ('discover_tools', {'query':'mcp__hosty-workspaces__context_list'}),
                ('mcp_list', {}),

            ]
            message = {'role':'assistant','content':'Verified completion' if turn <= 9 else 'Verified continuation'}
            if turn <= len(actions):
                name, arguments = actions[turn - 1]
                if name == 'mcp_list':
                    matches = [t['function']['name'] for t in body['tools'] if t['function']['description'].startswith('mcp__hosty-workspaces__context_list —')]
                    assert len(matches) == 1, 'Expected one discovered context_list definition; got '+repr([t['function']['description'].split(' — ')[0] for t in body['tools'] if t['function']['name'].startswith('mcp_')])
                    name = matches[0]
                message = {'role':'assistant','content':'','tool_calls':[{'function':{'name':name,'arguments':arguments}}]}
            self.reply({'model':fixture_model,'message':message,'done':True,'prompt_eval_count':100,'eval_count':10}, True)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def post(route, body): return call(app_origin, '/api'+route, body)
    def read(route): return call(app_origin, '/api'+route)
    def complete(session, after=0, expected_approvals=0):
        approvals, events, sequence = 0, [], after
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
                    post('/sessions/'+session+'/approvals/'+event['approvalId'], {'decision':'deny' if event.get('input',{}).get('path') == 'denied.txt' else 'allow'})
                if event.get('type') == 'question_request':
                    # Questions now continue through their shared, revisioned Decisions record.
                    decision = wait_for(lambda: next((row for row in read('/decisions')['items']
                        if row.get('state') == 'pending' and row.get('input', {}).get('subject', {}).get('id') == session), None), 30)
                    question = next(q for q in decision['input']['questions'] if q['question'] == 'Which check?')
                    option = next(o for o in question['options'] if o['label'] == 'Quick')
                    post('/decisions/'+decision['id']+'/resolve', {'requestId':str(uuid.uuid4()),
                        'expectedRevision':decision['revision'], 'answers':{question['id']:{'optionIds':[option['id']]}}})
                if event.get('type') == 'result': break
        assert approvals == expected_approvals, (approvals, expected_approvals)
        assert any(e.get('type') == 'result' for e in events), 'No terminal result'
        wait_for(lambda: read('/sessions/'+session)['status'] == 'idle', 30)
        return sequence, events

    try:
        if os.environ.get('HOSTY_OLLAMA_BROWSER'):
            import subprocess
            result = subprocess.run(['node', str(context['workspace']/'apps/harness/test/ollama-browser.mjs')],
                input=json.dumps({'core':context['origin'], 'harness':app_origin,
                    'email':'activation-fixture@example.test', 'password':context['password'],
                    'link':app_origin+'/assistant/', 'ollama':'http://127.0.0.1:'+str(server.server_port)}),
                text=True, cwd=context['workspace'])
            assert result.returncode == 0, 'Ollama browser acceptance failed'
        connection = post('/connections', {'name':'Ollama acceptance','kind':'ollama','auth':'none',
            'baseUrl':'http://127.0.0.1:'+str(server.server_port)})
        assert post('/connections/'+connection['id']+'/test', {})['available']
        assert read('/connections/'+connection['id']+'/models')['defaultModel'] == fixture_model
        chat = post('/sessions', {'title':'Ollama acceptance','connectionId':connection['id'],'profileId':None,'skillIds':[],'appIds':[]})
        tree = post('/sessions/'+chat['id']+'/workspaces', {'action':'prepare','appId':'hosty.harness','requestId':str(uuid.uuid4()),'name':'Ollama coding acceptance'})
        assert tree.get('path') and tree.get('id'), 'Expected a registered Core worktree'
        post('/sessions/'+chat['id']+'/messages', {'text':'Create the fixture file, read it and run the check.','clientRequestId':str(uuid.uuid4())})
        sequence, events = complete(chat['id'], expected_approvals=4)
        assert any(e.get('type') == 'command_result' and e.get('exitCode') == 0 for e in events)
        assert any(e.get('type') == 'tool_result' and 'verified adapter' in e.get('output','') for e in events)
        assert any(e.get('type') == 'question_request' for e in events)
        mcp = next(e for e in events if e.get('type') == 'tool_use' and e.get('toolName') == 'mcp__hosty-workspaces__context_list')
        assert any(e.get('type') == 'tool_result' and e.get('toolUseId') == mcp['toolUseId'] and e.get('status') == 'completed' for e in events)
        assert any(e.get('type') == 'tool_result' and 'ENOENT' in e.get('output','') for e in events)
        observations = [e['usage'] for e in events if e.get('type') == 'context_usage' and e.get('usage')]
        assert len(observations) == len(requests), 'Each ordinary fixture request reports its own observation'
        for observation, sent in zip(observations, requests):
            detail = observation['mcp']
            assert observation['usedTokens'] == 100 and observation['estimated'] is False
            assert detail['method'] == 'local-estimate' and detail['estimator'] == 'utf8-json-div4-v1'
            sent_mcp = [t for t in sent['tools'] if t['function']['name'].startswith('mcp_')]
            assert len([t for t in detail['tools'] if t['inclusion'] == 'loaded']) == len(sent_mcp)
            for row in detail['tools']:
                assert set(row) == {'server', 'name', 'tokens', 'inclusion'}
                assert row['tokens'] > 0 and row['inclusion'] in ('loaded', 'available')
        assert all(t['inclusion'] == 'available' for t in observations[0]['mcp']['tools'])
        assert any(t['server'] == 'hosty-workspaces' and t['name'] == 'context_list' and t['inclusion'] == 'loaded'
                   for t in observations[-1]['mcp']['tools'])
        say('PASS: Ollama context metadata follows actual requests, with local estimates and separate available definitions')
        say('PASS: Ollama discovery, approvals, patch/read/command, question answer, denied write and scoped MCP receipts')
        timed('restart')
        post('/sessions/'+chat['id']+'/messages', {'text':'Continue without repeating any action.','clientRequestId':str(uuid.uuid4())})
        _, resumed = complete(chat['id'], sequence)
        assert not any(e.get('type') == 'tool_use' for e in resumed)
        assert any(m.get('role') == 'tool' for m in requests[-1]['messages'])
        restored = next(e['usage'] for e in resumed if e.get('type') == 'context_usage' and e.get('usage'))
        assert restored['mcp']['method'] == 'local-estimate'
        assert all(t['inclusion'] == 'available' for t in restored['mcp']['tools'])
        say('PASS: Harness/Worker restart resumes saved Ollama context without replaying completed tools')

        if endpoint := os.environ.get('HOSTY_OLLAMA_URL'):
            actual = post('/connections', {'name':'Existing host Ollama','kind':'ollama','auth':'none','baseUrl':endpoint})
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

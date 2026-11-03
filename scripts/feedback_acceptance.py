"""Feedback acceptance in the existing parent-managed child Core; synthetic accounts/provider only."""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import subprocess
import shutil
import urllib.error
import urllib.parse
import urllib.request
import uuid
import time


def check(context, app_origin, link):
    origin, password, workspace = (context[k] for k in ('origin', 'password', 'workspace'))
    say, wait_for = context['say'], context['wait_for']
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    csrf = None
    def call(host, path, body=None, method=None, expected=200):
        headers = {'Origin': host, 'Content-Type': 'application/json'}
        if host == origin and csrf: headers['X-Hosty-CSRF'] = csrf
        req = urllib.request.Request(host+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with client.open(req, timeout=180) as response: status, raw = response.status, response.read()
        except urllib.error.HTTPError as error: status, raw = error.code, error.read()
        value = json.loads(raw) if raw else None
        assert status == expected, (path, status, value)
        return value
    def h(path, body=None, method=None, expected=200): return call(app_origin, '/api'+path, body, method, expected)
    h('/feedback', expected=401)
    form = urllib.parse.urlencode({'email':'activation-fixture@example.test', 'password':password, 'returnTo':'/api/auth/session'}).encode()
    with client.open(urllib.request.Request(origin+'/login', data=form, headers={'Content-Type':'application/x-www-form-urlencoded', 'Origin':origin}), timeout=30) as response: response.read()
    user = call(origin, '/api/auth/session')['user']['id']; csrf = call(origin, '/api/auth/csrf')['token']
    verifier = uuid.uuid4().hex+uuid.uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    code = call(origin, '/api/apps/hosty.harness/launch-code', {'redirectUri':link, 'codeChallenge':challenge, 'codeChallengeMethod':'S256'})['code']
    h('/auth/app-code', {'code':code, 'codeVerifier':verifier})
    context['diagnostic_secrets'].update(cookie.value for cookie in jar)
    caps = h('/hosty/ui/feedback')
    def submit(comment):
        payload = {'requestId':str(uuid.uuid4()), 'comment':comment, 'scope':{key:caps[key] for key in ['coreId','appId','installation','userId']},
          'annotations':[{'id':str(uuid.uuid4()), 'text':'Align this control', 'route':'/feedback', 'capturedAt':'2026-10-30T12:00:00Z', 'target':{'kind':'page'},
            'image':{'mediaType':'image/png', 'data':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII='}}]}
        receipt = h('/hosty/ui/feedback', payload); assert h('/hosty/ui/feedback', payload) == receipt
        return receipt['id'], payload
    def report(report_id): return next(r for r in h('/feedback')['reports'] if r['id']==report_id)
    before_sessions = h('/sessions')['sessions']
    first, first_input = submit('Acceptance: control alignment')
    second, _ = submit('Acceptance: related spacing')
    assert h('/sessions')['sessions'] == before_sessions
    assert report(first)['context']['version'] == json.loads((workspace/'apps/harness/manifest.json').read_text())['version']
    changed = {**first_input, 'comment':'Different payload'}; h('/hosty/ui/feedback', changed, expected=409)
    wrong_user = {**first_input, 'scope':{**first_input['scope'], 'userId':'not-this-account'}}
    h('/hosty/ui/feedback', wrong_user, expected=403)
    say('PASS: authenticated intake, immutable context, no agent dispatch, exact replay and account scope')

    if not os.environ.get('HOSTY_FEEDBACK_BROWSER_ONLY'):
        # Previewing the Core catalog does not grant tool execution. Review the installed
        # assistant's access on this disposable child's normal administrator confirmation page.
        review_path = '/install/agents/'+urllib.parse.quote(caps['appId'], safe='')+'/hosty:core'
        with client.open(origin+review_path, timeout=30) as response:
            review_url, review_html = response.geturl(), response.read().decode()
        assert review_url.startswith(origin+'/install/confirm/'), 'Core MCP review did not open its confirmation page'
        nonce = re.search(r'name=nonce value="([^"]+)"', review_html)
        assert nonce, 'Core MCP review has no decision nonce'
        context['diagnostic_secrets'].add(nonce.group(1))
        decision = urllib.parse.urlencode({'nonce':nonce.group(1), 'decision':'approve', 'agentEnabled':'true'}).encode()
        with client.open(urllib.request.Request(review_url, data=decision,
                headers={'Origin':origin, 'Content-Type':'application/x-www-form-urlencoded'}), timeout=30) as response: response.read()
        approval_id = urllib.parse.urlparse(review_url).path.rsplit('/', 1)[1]
        def approved():
            result = call(origin, '/api/installations/'+approval_id)
            assert result['status'] not in ('failed', 'denied', 'expired'), ('Core MCP review failed', result['status'])
            return result['status'] == 'succeeded'
        wait_for(approved, 30)
        core_target = next(target for target in call(origin, '/api/core/agents')['targets'] if target['id'] == 'hosty:core')
        assert caps['appId'] in core_target['assistantIds'], 'The reviewed assistant has no current Core MCP grant'
        say('PASS: normal child administrator review grants this installed assistant Core MCP access')
        connection = h('/connections', {'name':'Feedback acceptance', 'kind':'codex', 'auth':'api-key', 'secret':'synthetic-feedback-fixture-only'}, expected=201)
        h('/connections/'+connection['id']+'/test', {})
        profiles = h('/profiles')
        profiles = h('/profiles', {'expectedRevision':profiles['revision'], 'profile':{'name':'Feedback fixture', 'description':'Scripted acceptance', 'instructions':'Exercise the feedback contract.', 'connectionId':connection['id'], 'model':'fixture-default', 'reasoningEffort':'medium', 'skillIds':[]}}, expected=201)
        profile = next(p for p in profiles['profiles'] if p['name']=='Feedback fixture')
        h('/profiles/default', {'profileId':profile['id'], 'expectedRevision':profiles['revision']}, method='PUT')
        def dispatch(ids, instruction='FEEDBACK_ACCEPTANCE:HANDLE', session_id=None, workspace_id=None):
            payload = {'requestId':str(uuid.uuid4()), 'sessionId':session_id, 'workspaceId':workspace_id,
              'reports':[{'id':rid, 'revision':report(rid)['revision']} for rid in ids], 'instruction':instruction}
            value = h('/feedback/dispatches', payload)
            again = h('/feedback/dispatches', payload); assert again['id']==value['id']
            return value
        def settle(attempt, state='succeeded'):
            last = None
            def ready():
                nonlocal last
                session = h('/sessions/'+attempt['input']['sessionId'])
                for approval in session.get('mcpPendingApprovals', []):
                    assert any(name in approval['tool'] for name in ['feedback_current','feedback_image','feedback_result','prepare']), approval
                    h('/sessions/'+session['id']+'/approvals/'+approval['id'], {'decision':'allow'})
                last = next(d for d in h('/feedback')['dispatches'] if d['id']==attempt['id'])
                if last['state'] in ('failed','cancelled','rejected') and last['state'] != state: raise AssertionError(last)
                return last['state'] == state
            wait_for(ready, 180)
            return last
        attempt = settle(dispatch([first, second]))
        assert report(first)['status']=='processed' and report(second)['status']=='processed'
        workspace_id = report(first)['workspaceId']; assert workspace_id and report(second)['workspaceId']==workspace_id
        assert attempt['messageSequence'] > 0 and len(attempt['outcomes'])==2
        say('PASS: one global batch, new chat/source workspace, screenshot tool, exact prompt and explicit per-report outcomes')
        followup = settle(dispatch([first], 'FEEDBACK_ACCEPTANCE:PARTIAL', attempt['input']['sessionId'], workspace_id))
        assert report(first)['status']=='partial' and report(first)['currentAttemptId']==followup['id']
        third, _ = submit('Acceptance: unprocessed survives deletion')
        h('/feedback/'+third, {'expectedRevision':report(third)['revision'], 'workspaceId':workspace_id})
        wait_for(lambda: not h('/sessions/'+attempt['input']['sessionId']).get('workerRun'), 90)
        deletion = {'requestId':str(uuid.uuid4())}
        h('/development-workspaces/'+workspace_id+'/delete', deletion)
        h('/development-workspaces/'+workspace_id+'/delete', deletion)
        remaining = h('/feedback')['reports']
        assert not any(r['id']==second for r in remaining)
        assert report(first)['workspaceId'] is None and report(third)['workspaceId'] is None
        assert report(first)['annotations'][0]['mediaType']=='image/png'
        say('PASS: repeat history, partial outcome, processed-only deletion and unprocessed evidence retention')
    # The same child owns Shell, so embedding uses real Core app launch and SDK frame policy.
    shell_manifest = json.loads((workspace/'apps/shell/manifest.json').read_text())
    shell_manifest['source']['repository'] = context['repository']
    shell_source = context['base']/'feedback-shell-manifest.json'
    shell_source.write_text(json.dumps(shell_manifest))
    shutil.copytree(workspace/'apps/shell/assets', context['base']/'assets', dirs_exist_ok=True)
    context['run']([context['cli'], '--data-root', context['root'], 'apps', 'install', shell_source, '--runtime', 'dev', '--no-autostart'])
    context['run']([context['cli'], '--data-root', context['root'], 'apps', 'start', shell_manifest['id']])
    wait_for(lambda: context['request']('/api/apps/'+shell_manifest['id']+'/health')['status']=='healthy', 180)
    shell_origin = wait_for(lambda: context['request']('/control/v1/core/status', control=True)['shellPublicOrigin'])
    shell_link = json.loads(context['run']([context['cli'], '--data-root', context['root'], 'apps', 'open', shell_manifest['id'], '--redirect-uri', shell_origin+'/dashboard', '--format', 'json']))['url']
    shell_url = urllib.parse.urlparse(shell_link)
    shell_origin = urllib.parse.urlunparse((shell_url.scheme, shell_url.netloc, '', '', '', ''))
    config = {'core':origin, 'harness':app_origin, 'email':'activation-fixture@example.test', 'password':password, 'link':link,
              'shell':shell_origin, 'shellLink':shell_link, 'shellAppId':shell_manifest['id']}

    if os.environ.get('HOSTY_FEEDBACK_DESKTOP'):
        desktop_manifest = json.loads((workspace/'apps/desktop/manifest.json').read_text())
        desktop_manifest['source']['repository'] = context['repository']
        desktop_source = context['base']/'feedback-desktop-manifest.json'
        desktop_source.write_text(json.dumps(desktop_manifest))
        shutil.copytree(workspace/'apps/desktop/assets', context['base']/'assets', dirs_exist_ok=True)
        context['run']([context['cli'], '--data-root', context['root'], 'apps', 'install', desktop_source, '--runtime', 'dev', '--no-autostart'])
        context['run']([context['cli'], '--data-root', context['root'], 'apps', 'start', desktop_manifest['id']])
        wait_for(lambda: context['request']('/api/apps/'+desktop_manifest['id']+'/health')['status']=='healthy', 180)
        desktop_link = json.loads(context['run']([context['cli'], '--data-root', context['root'], 'apps', 'open', desktop_manifest['id'], '--format', 'json']))['url']
        desktop_url = urllib.parse.urlparse(desktop_link)
        config.update(desktop=urllib.parse.urlunparse((desktop_url.scheme, desktop_url.netloc, '', '', '', '')), desktopLink=desktop_link, desktopAppId=desktop_manifest['id'])

    while True:
        result = subprocess.run(['node', str(workspace/'scripts/feedback-browser-acceptance.mjs')], input=json.dumps(config), text=True, cwd=workspace)
        if result.returncode == 0 or not os.environ.get('HOSTY_FEEDBACK_RETRY_BROWSER'): break
        retry = context['base']/'retry-feedback-browser'
        stop = context['base']/'stop-feedback-browser'
        say('BROWSER_RETRY_READY: create '+str(retry)+' to retry the script in this child, or '+str(stop)+' to finish it')
        deadline = time.monotonic()+1200
        while not retry.exists() and not stop.exists() and time.monotonic()<deadline: time.sleep(.5)
        if not retry.exists(): break
        retry.unlink()
    if result.returncode != 0:
        log = context['root']/'apps'/shell_manifest['id']/'logs/web.log'
        if log.is_file(): say(context['sanitize_diagnostic'](log.read_text()[-10000:]))
    assert result.returncode == 0, 'Feedback browser acceptance failed'

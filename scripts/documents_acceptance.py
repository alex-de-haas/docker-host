"""Documents acceptance in the existing managed Core fixture; no ordinary user data or credentials."""
import base64
import hashlib
import http.cookiejar
import json
import pathlib
import queue
import threading
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace, remote = (context[key] for key in ('base', 'root', 'workspace', 'remote'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    relative = 'docs/features/documents-acceptance/plan.md'
    def markdown(done):
        return ('---\nstatus: In Progress\ncreated: 2026-10-26\nupdated: 2026-10-26\n'
                'summary: Isolated source progress acceptance.\n---\n# Documents acceptance\n'
                '## Deliverables\n' + ''.join(f'- [{"x" if number <= done else " "}] D{number}. Item {number}\n' for number in range(1, 11)))
    def commit(directory, message):
        run(['git', 'add', '.'], directory)
        run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message], directory)
        return run(['git', 'rev-parse', 'HEAD'], directory).strip()
    target = remote/relative
    target.parent.mkdir(parents=True)
    target.write_text(markdown(3))
    commit(remote, 'Add isolated document fixture')
    run(['git', 'update-server-info'], remote)
    manifest = json.loads((workspace/'apps/documents/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    manifest_path = base/'documents-manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    app = manifest['id']
    run([cli, '--data-root', root, 'apps', 'install', manifest_path, '--runtime', 'docker', '--no-autostart'])
    run([cli, '--data-root', root, 'apps', 'start', app])
    wait_for(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    form = urllib.parse.urlencode({'email':'activation-fixture@example.test','password':password,'returnTo':'/api/auth/session'}).encode()
    with client.open(urllib.request.Request(origin+'/login', data=form, headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response:
        response.read()
    def call(host, path, body=None, csrf=None):
        headers={'Content-Type':'application/json','Origin':host}
        if csrf: headers['X-Hosty-CSRF']=csrf
        with client.open(urllib.request.Request(host+path, data=json.dumps(body).encode() if body is not None else None, headers=headers), timeout=180) as response:
            return json.load(response)
    assert call(origin, '/api/auth/session')['authenticated']
    csrf = call(origin, '/api/auth/csrf')['token']
    verifier = uuid.uuid4().hex + uuid.uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    code = call(origin, '/api/apps/'+app+'/launch-code', {'redirectUri':link, 'codeChallenge':challenge, 'codeChallengeMethod':'S256'}, csrf)['code']
    call(app_origin, '/api/auth/app-code', {'code':code,'codeVerifier':verifier})
    context['diagnostic_secrets'].update(cookie.value for cookie in jar)
    def app_get(path): return call(app_origin, '/api'+path)
    repositories = app_get('/repositories')['repositories']
    repository = next(row for row in repositories if row['repository'] == context['repository'])['id']
    detail_path = '/document?'+urllib.parse.urlencode({'repository':repository, 'path':relative})
    assert app_get(detail_path)['document']['progress'] == {'done':3, 'total':10}
    development = request('/api/core/development')
    source = request('/api/core/source', {'revision':development['source']['revision'], 'overridePath':None,
        'repository':{'repositoryUrl':context['repository'], 'ref':'main', 'projectPath':context['project'], 'connectionId':None}}, method='PUT', confirm_settings=True)
    lease = str(uuid.uuid4())
    tree = request('/api/core/source/workspaces', {'requestId':str(uuid.uuid4()), 'taskId':'documents-progress-acceptance',
        'leaseId':lease, 'sourceRevision':source['revision'], 'targetBranch':'main', 'label':'Documents acceptance'})
    path = pathlib.Path(tree['path'])
    # Keep the activity lease while native edits and fixture Git processes use this directory.
    events = queue.Queue()
    stop = threading.Event()
    stream = client.open(app_origin+'/api/events?repository='+repository, timeout=45)
    assert stream.headers.get('Content-Type','').startswith('text/event-stream')
    def read_events():
        try:
            while not stop.is_set():
                line=stream.readline().decode()
                if not line: break
                if line.startswith('event: '): events.put(line.strip()[7:])
        except (OSError, ValueError, AttributeError):
            if not stop.is_set(): events.put("stream.failed")
    thread = threading.Thread(target=read_events, daemon=True)
    thread.start()
    try:
        assert events.get(timeout=45) == 'stream.ready'
        (path/relative).write_text(markdown(5))
        request('/api/development/workspaces/'+tree['id'])
        wait_for(lambda: not events.empty(), 45)
        assert events.get(timeout=2) == 'source.changed'
        details = app_get(detail_path+'&workspace='+tree['id'])
        selected = next(row for row in details['workspaces'] if row['workspace']['id'] == tree['id'])
        assert details['document']['progress'] == {'done':3,'total':10}
        assert selected['document']['progress'] == {'done':5,'total':10}
        assert selected['base']['progress'] == {'done':3,'total':10}
        assert selected['workspace']['hasLocalChanges'] is True
        assert selected['workspace']['pullRequests'] == []
        say('PASS: password identity, Docker Documents, scoped SSE, target 3/10 and uncommitted workspace 5/10')
        integrated_content = selected['document']['content']
        head = commit(path, 'Complete two fixture deliverables')
        run(['git','fetch',str(path),tree['branch']], remote)
        run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','merge','--no-ff','FETCH_HEAD','-m','Integrate fixture work'], remote)
        run(['git','update-server-info'], remote)
        integrated = app_get(detail_path+'&refresh=true')
        assert integrated['document']['progress'] == {'done':5,'total':10}
        assert integrated['document']['content'] == integrated_content
        request('/api/development/workspaces/'+tree['id']+'/operations/refresh', {'requestId':str(uuid.uuid4())})
        request('/api/development/workspaces/'+tree['id']+'/operations/release-lease', {'requestId':str(uuid.uuid4()),'leaseId':lease})
        request('/api/development/workspaces/'+tree['id']+'/operations/cleanup', {'requestId':str(uuid.uuid4()),'expectedHead':head})
        assert not path.exists()
        assert not any(row['id']==tree['id'] for row in app_get('/workspaces?repository='+repository)['workspaces'])
        assert app_get(detail_path)['document']['progress'] == {'done':5,'total':10}
        say('PASS: actual target integration survives workspace cleanup, with no retained Documents history')
    finally:
        stop.set()
        stream.close()
        thread.join(timeout=2)

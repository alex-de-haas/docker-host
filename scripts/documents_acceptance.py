"""Documents acceptance in the existing managed Core fixture; no ordinary user data or credentials."""
import base64
import hashlib
import http.cookiejar
import json
import os
import time
import pathlib
import queue
import threading
import urllib.parse
import urllib.request
import uuid
import subprocess
import statistics
from concurrent.futures import ThreadPoolExecutor


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
    probe = os.environ.get('HOSTY_DOCUMENTS_CPU_PROBE') == '1'
    if probe:
        for index in range(249):
            page = remote/f'docs/reviews/2026-10-27-load-{index}.md'
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text(f'# Load fixture {index}\n\n' + 'Stable source content.\n' * 50)
    manifest = json.loads((workspace/'apps/documents/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    # Keep manifest-relative skills and assets beside the fixture manifest.
    manifest_path = remote/'apps/documents/manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    commit(remote, 'Add isolated document fixture')
    run(['git', 'update-server-info'], remote)
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
    navigation = app_get('/hosty/ui/navigation')
    entries = navigation['entries']
    assert [entry['label'] for entry in entries] == ['Home', 'Vision', 'Ideas', 'Features', 'Plans', 'Reviews', 'Tooling']
    assert [entry['route'] for entry in entries] == ['/', '/vision', '/ideas', '/features', '/plans', '/reviews', '/tooling']
    for entry in entries:
        assert entry['icon'], 'Each section declares a packaged icon'
        icon = urllib.parse.urlparse(entry['icon'])
        # The fixture's password session belongs to its explicit Core origin.
        with client.open(origin+icon.path+('?' + icon.query if icon.query else ''), timeout=30) as response:
            assert b'<svg' in response.read()
        with client.open(app_origin+entry['route'], timeout=30) as response:
            assert response.status == 200
    say('PASS: seven manifest navigation entries resolve to served Documents pages')
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
        if probe:
            catalog_path = '/repositories/'+repository
            app_get(catalog_path)  # Warm authorized target/worktree snapshots and app projections.
            pid = request('/api/core/development')['launch']['processId']
            samples, timings = [], []
            finished = threading.Event()
            def cpu_seconds():
                text = subprocess.check_output(['ps','-p',str(pid),'-o','time='], text=True).strip()
                days, _, clock = text.rpartition('-')
                return (int(days)*86400 if days else 0) + sum(float(part)*60**i for i,part in enumerate(reversed(clock.split(':'))))
            def sample_cpu():
                previous, started = cpu_seconds(), time.monotonic()
                while not finished.wait(.5):
                    current, now = cpu_seconds(), time.monotonic()
                    samples.append(100*(current-previous)/(now-started)); previous, started = current, now
            sampler = threading.Thread(target=sample_cpu, daemon=True)
            sampler.start()
            before, started = cpu_seconds(), time.monotonic()
            try:
                def refresh_catalog(_):
                    at = time.monotonic(); result = app_get(catalog_path)
                    assert result.get('state') != 'unavailable', result.get('error')
                    return time.monotonic()-at
                with ThreadPoolExecutor(max_workers=3) as pool:
                    for count in (3, 3, 2):
                        timings.extend(pool.map(refresh_catalog, range(count)))
                        time.sleep(.5)
            finally:
                elapsed, consumed = time.monotonic()-started, cpu_seconds()-before
                finished.set(); sampler.join(timeout=2)
            metrics = {'documents':sum(1 for item in (remote/'docs').rglob('*.md') if item.is_file() and not item.is_symlink()),'refreshes':8,'concurrency':3,'wallSeconds':round(elapsed,3),'coreCpuSeconds':round(consumed,3),
                'meanCoreCpuPercent':round(100*consumed/elapsed,1),'peakHalfSecondCpuPercent':round(max(samples,default=0),1),
                'medianCatalogSeconds':round(statistics.median(timings),3)}
            say('CPU_PROBE: '+json.dumps(metrics,sort_keys=True))
            if report := os.environ.get('HOSTY_DOCUMENTS_CPU_REPORT'):
                pathlib.Path(report).write_text(json.dumps(metrics,indent=2)+'\n')
        if review := os.environ.get('HOSTY_DOCUMENTS_BROWSER_REVIEW'):
            # Disposable test credentials only; never put this file in the repository or log it.
            review_path = pathlib.Path(review)
            descriptor = os.open(review_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor,'w') as output:
                json.dump({'origin':origin,'appUrl':link,'email':'activation-fixture@example.test','password':password,
                           'dataRoot':str(root),'pid':request('/api/core/development')['launch']['processId']},output)
            say('BROWSER_REVIEW_READY: '+str(review_path))
            continuation = pathlib.Path(review+'.continue')
            try:
                deadline = time.monotonic()+600
                while not continuation.exists():
                    if time.monotonic()>deadline: raise TimeoutError('Browser review was not completed within ten minutes')
                    time.sleep(.5)
            finally:
                review_path.unlink(missing_ok=True); continuation.unlink(missing_ok=True)
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

    if os.environ.get('HOSTY_DOCUMENTS_BROWSER') == '1':
        shell_manifest = workspace/'apps/shell/manifest.json'
        run([cli, '--data-root', root, 'apps', 'install', shell_manifest, '--runtime', 'docker', '--no-autostart'])
        shell = json.loads(shell_manifest.read_text())['id']
        run([cli, '--data-root', root, 'apps', 'start', shell])
        wait_for(lambda: request('/api/apps/'+shell+'/health')['status'] == 'healthy', 180)
        shell_link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--mode', 'shell', '--format', 'json']))['url']
        access = base/'browser-access.json'
        access.write_text(json.dumps({'core':origin, 'url':link, 'shell':shell_link,
            'email':'activation-fixture@example.test', 'password':password}))
        os.chmod(access, 0o600)
        say('UI READY: '+str(access)+'; create finish-ui after browser checks')
        try:
            deadline = time.time()+1800
            while time.time()<deadline and not (base/'finish-ui').exists():
                time.sleep(.5)
            assert (base/'finish-ui').exists(), 'Browser acceptance did not acknowledge completion'
        finally:
            access.unlink(missing_ok=True)

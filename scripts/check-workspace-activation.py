#!/usr/bin/env python3
"""Native Core activation/Return acceptance with isolated users, Git source and data.

Build Core and CLI in Debug first, then run with repository path and optional scenario:
return (default), stop-failure, auto, cancel. --managed runs inside a parent-owned child
Core and requires the local Docker engine for the supported child environment lifecycle.
No provider credentials are copied. Failure retains diagnostics; success removes test data.
"""
import os, sys, json, time, uuid, signal, socket, shutil, pathlib, subprocess, threading, tempfile, csv, io
import urllib.request, urllib.error, urllib.parse, http.cookiejar, http.server

workspace = pathlib.Path(sys.argv[1]).resolve()
scenario = sys.argv[2] if len(sys.argv)>2 else 'return'
# Git for Windows bounds linked-worktree administrative paths even with long file paths enabled.
base = pathlib.Path(tempfile.mkdtemp(prefix='hwa-' if os.name == 'nt' else 'hosty-activation-'))
managed = '--managed' in sys.argv
parent = None
child_id = None
windows = os.name == 'nt'
suffix = '.exe' if windows else ''
root = base / 'instance'
remote = base / 'fixture-source'
cli = workspace / ('apps/cli/src/Haas.Hosty.Cli/bin/Debug/net10.0/hosty' + suffix)
core = workspace / ('apps/core/src/Haas.Hosty.Core/bin/Debug/net10.0/hosty-core' + suffix)
project = 'apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj'
# Keep native SDK OS-directory discovery while excluding credentials and provider configuration.
env = {k: os.environ[k] for k in [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'DOTNET_ROOT', 'LANG', 'SystemRoot', 'COMSPEC',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData',
    'SystemDrive', 'windir', 'HOMEDRIVE', 'HOMEPATH', 'ALLUSERSPROFILE',
] if k in os.environ}
env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
process = None
server = None
owned_pids = set()
success = False

def say(message): print(message, flush=True)
def run(args, cwd=None):
    p = subprocess.run([str(x) for x in args], cwd=cwd, env=env, capture_output=True, text=True)
    if p.returncode: raise RuntimeError(p.stderr[-2500:] + p.stdout[-2500:])
    return p.stdout
def alive(pid):
    if windows:
        rows = csv.reader(io.StringIO(run(['tasklist', '/FI', 'PID eq '+str(pid), '/FO', 'CSV', '/NH'])))
        return any(len(row)>1 and row[1] == str(pid) for row in rows)
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False

def kill(pid):
    if windows: run(['taskkill', '/PID', str(pid), '/F'])
    else: os.kill(pid, signal.SIGKILL)

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
port = free_port()
origin = f'http://127.0.0.1:{port}'
jar = http.cookiejar.CookieJar()
browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = None
def request(path, body=None, method=None, control=False):
    headers = {'Content-Type':'application/json','Origin':origin}
    if csrf: headers['X-Hosty-CSRF'] = csrf
    if control:
        discovery = json.loads((root/'core/run/control.json').read_text())
        headers.update(discovery['requiredHeaders'])
    req = urllib.request.Request(origin+path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method, headers=headers)
    try:
        with browser.open(req, timeout=180) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{path}: {error.code} {error.read().decode()[:1500]}') from None
def wait_for(fn, seconds=90):
    deadline=time.time()+seconds
    while time.time()<deadline:
        try:
            value=fn()
            if value: return value
        except (FileNotFoundError, json.JSONDecodeError, urllib.error.URLError, ConnectionError): pass
        time.sleep(.04)
    raise TimeoutError('Timed out waiting for fixture state')

try:
    files=run(['git','ls-files','-z','--cached','--others','--exclude-standard'],workspace).split('\0')
    for name in files:
        if not name: continue
        source=workspace/name
        if not source.is_file(): continue
        destination=remote/name; destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,destination)
    run(['git','init','-b','main'],remote)
    run(['git','add','.'],remote)
    run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Fixture source for isolated activation acceptance'],remote)
    run(['git','update-server-info'],remote)
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self,*args,**kw): super().__init__(*args,directory=str(remote),**kw)
        def log_message(self,*args): pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    repository=f'http://127.0.0.1:{server.server_port}/.git'
    (root/'core').mkdir(parents=True)
    (root/'core/distribution-apps.json').write_text('{"schemaVersion":"distribution-apps.0.1","apps":[]}')
    env.update(HOSTY_DATA_ROOT=str(root),HOSTY_CORE_URL=origin,HOSTY_CORE_PORT=str(port),
               HOSTY_DISTRIBUTION_APPS_PATH=str(root/'core/distribution-apps.json'),
               HOSTY_CORE_LAUNCH_MODE='dev',HOSTY_CORE_PROJECT=str(workspace/project),HOSTY_CLI_PATH=str(cli))
    log=open(base/'initial-core.log','w')
    process=subprocess.Popen([str(core)],env=env,stdout=log,stderr=subprocess.STDOUT)
    owned_pids.add(process.pid)
    threading.Thread(target=process.wait,daemon=True).start()
    def initial_ready():
        if process.poll() is not None: raise RuntimeError('Fixture Core failed to start: '+(base/'initial-core.log').read_text()[:2500])
        return (root/'core/run/control.json').exists()
    wait_for(initial_ready)
    initial=request('/control/v1/core/status',control=True)
    token=request('/control/v1/auth/setup-token',{},control=True)['token']
    password=uuid.uuid4().hex+'aA1!'
    setup=request('/api/auth/bootstrap',{'setupToken':token,'email':'activation-fixture@example.test','displayName':'Activation fixture','password':password})
    user=setup['user']['id']
    jar.clear()
    # Exercise the ordinary password login; bootstrap-created sessions are not used for API work.
    form=urllib.parse.urlencode({'email':'activation-fixture@example.test','password':password,'returnTo':'/api/auth/session'}).encode()
    with browser.open(urllib.request.Request(origin+'/login',data=form,headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}),timeout=20) as result:
        result.read()
    assert request('/api/auth/session')['authenticated']
    csrf=request('/api/auth/csrf')['token']
    if managed:
        parent = (root, origin, jar, browser, csrf)
        child = request('/api/core-environments', {'requestId':str(uuid.uuid4()), 'label':'Workspace activation acceptance', 'mode':'source', 'projectPath':str(workspace/project)})
        child_id = child['id']
        child = request(f'/api/core-environments/{child_id}/operations/start', {'requestId':str(uuid.uuid4()), 'expectedRevision':child['revision']})
        assert child['state'] == 'running', child
        request(f'/api/core-environments/{child_id}/setup', {'email':'activation-fixture@example.test', 'displayName':'Activation fixture', 'password':password})
        root = pathlib.Path(child['dataRoot']); origin = f"http://localhost:{child['port']}"
        owned_pids.add(child['process']['pid'])
        jar = http.cookiejar.CookieJar(); browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)); csrf = None
        with browser.open(urllib.request.Request(origin+'/login',data=form,headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}),timeout=20) as response: response.read()
        user = request('/api/auth/session')['user']['id']
        csrf = request('/api/auth/csrf')['token']
        initial = request('/control/v1/core/status',control=True)
        say('Started a parent-managed child Core and logged in with its separate test account')
    development=request('/api/core/development')
    source=request('/api/core/source',{'revision':development['source']['revision'],'overridePath':None,
        'repository':{'repositoryUrl':repository,'ref':'main','projectPath':project,'connectionId':None}},method='PUT')
    lease=str(uuid.uuid4())
    tree=request('/api/core/source/workspaces',{'requestId':str(uuid.uuid4()),'taskId':'native-workspace-activation','leaseId':lease,
        'sourceRevision':source['revision'],'targetBranch':'main','label':'Disposable native activation verification'})
    assert tree.get('observation', {}).get('state') == 'ok', tree.get('observation')
    sentinel=pathlib.Path(tree['path'])/'uncommitted-sentinel.txt';sentinel.write_text('preserve native fixture source')
    request(f"/api/development/workspaces/{tree['id']}/operations/release-lease",{'requestId':str(uuid.uuid4()),'leaseId':lease})
    activation_id=str(uuid.uuid4())
    if scenario == 'return':
        review = request(f"/api/development/workspaces/{tree['workspaceId']}/activation/plan", {'selection':{'coreSelected':True}})
        request(f"/api/development/workspaces/{tree['workspaceId']}/activation/apply", {'requestId':activation_id, 'selection':{'coreSelected':True}, 'planDigest':review['planDigest']})
    else:
        activation=request(f"/control/v1/workspaces/{tree['workspaceId']}/activation/prepare",{
            'requestId':activation_id,'userId':user,'selection':{'coreSelected':True}},control=True)
        assert activation['phase']=='prepared' 
    say('Prepared isolated Core-only workspace after normal setup/password login; original fixture PID '+str(process.pid))
    activation_path=root/'core/workspace-activations'/f'{activation_id}.json'
    helper_path=root/'core/workspace-activations/helpers'/f'{activation_id}.json'
    # The initiating CLI exits while the detached helper performs the build and handover.
    if scenario != 'return':
        output=run([cli,'--data-root',root,'core','activate-workspace',activation_id])
        assert 'accepted' in output
    say('Initiating CLI exited; detached helper is building candidate')
    if scenario=='cancel':
        wait_for(lambda: json.loads(helper_path.read_text())['state']=='running')
        request(f'/control/v1/workspace-activations/{activation_id}/cancel',{},control=True)
        cancelled=wait_for(lambda: json.loads(activation_path.read_text())['phase']=='cancelled')
        assert request('/control/v1/core/status',control=True)['launch']==initial['launch']
        assert sentinel.read_text()=='preserve native fixture source'
        assert not list((root/'core/workspace-snapshots').glob('*.zip'))
        say('PASS: cancellation during build retired original request, released preparation, kept original Core PID/source/session, and created no snapshot')
        success=True
        sys.exit(0)
    deadline=time.time()+180
    interrupted=False
    while scenario != 'return' and time.time()<deadline:
        a=json.loads(activation_path.read_text())
        helper=json.loads(helper_path.read_text())
        target=(a['phase']=='core-stopping') if scenario=='stop-failure' else (helper['state']=='running' and a['phase']=='prepared' and list((root/'core/builds').glob('*/build.log')))
        if target:
            owned_pids.add(helper['pid'])
            kill(helper['pid'])
            interrupted=True
            say('Injected helper SIGKILL at '+a['phase']+' boundary')
            break
        if helper['state']=='failed': raise RuntimeError('Helper failed: '+pathlib.Path(helper['logPath']).read_text()[-4000:])
        if a['phase']=='active': raise RuntimeError('Missed deterministic interruption boundary')
        time.sleep(.001)
    assert interrupted or scenario == 'return'
    if scenario=='stop-failure':
        time.sleep(.3)
        output=run([cli,'--data-root',root,'core','activate-workspace',activation_id])
        say('Original request resumed after helper failure')
    elif scenario != 'return':
        say('Waiting for Core supervisor to redrive the abandoned request automatically')
    def completed():
        a=json.loads(activation_path.read_text())
        helper=json.loads(helper_path.read_text())
        if helper['state']=='failed': raise RuntimeError('Recovery failed: '+pathlib.Path(helper['logPath']).read_text()[-4000:])
        return a if a['phase']=='active' and helper['state']=='completed' else None
    final=wait_for(completed,180)
    status=request('/control/v1/core/status',control=True)
    owned_pids.add(status['launch']['processId'])
    assert status['launch']==final['activatedCore']
    assert status['launch']['processId']!=initial['launch']['processId']
    assert status['launch']['projectPath']==str(pathlib.Path(tree['path'])/project)
    assert status['launch']['generationPath']==final['generation']
    assert sentinel.read_text()=='preserve native fixture source'
    assert request('/api/auth/session')['authenticated']
    snapshots=list((root/'core/workspace-snapshots').glob('*.zip'))
    assert len(snapshots)==1
    before=activation_path.read_bytes()
    run([cli,'--data-root',root,'core','activate-workspace',activation_id])
    assert activation_path.read_bytes()==before
    assert request('/control/v1/core/status',control=True)['launch']==status['launch']
    assert len(list((root/'core/workspace-snapshots').glob('*.zip')))==1
    say('PASS: exact replacement identity, one verified snapshot, source/user/session preserved, completed replay has no process change')
    if scenario == 'return':
        return_id = str(uuid.uuid4())
        payload = {'activationId':activation_id,'return':{'requestId':return_id,'apps':[],'core':True,'acceptDataChanges':True}}
        request(f"/api/development/workspaces/{tree['workspaceId']}/activation/return", payload)
        def returned():
            a=json.loads(activation_path.read_text()); helper=json.loads(helper_path.read_text())
            if helper['state']=='failed': raise RuntimeError('Return failed: '+pathlib.Path(helper['logPath']).read_text()[-4000:])
            return a if a['phase']=='returned' and helper['state']=='completed' else None
        result=wait_for(returned,120)
        restored=request('/control/v1/core/status',control=True)
        owned_pids.add(restored['launch']['processId'])
        for key in ['mode','projectPath','generationPath']: assert restored['launch'][key] == initial['launch'][key], key
        assert restored['launch']['processId'] != status['launch']['processId']
        assert result['coreReturned'] and result['returns'][-1]['state']=='succeeded'
        assert request('/api/auth/session')['authenticated']
        assert sentinel.read_text()=='preserve native fixture source'
        before=activation_path.read_bytes()
        request(f"/api/development/workspaces/{tree['workspaceId']}/activation/return",payload)
        assert before==activation_path.read_bytes()
        assert request('/control/v1/core/status',control=True)['launch']==restored['launch']
        assert len(list((root/'core/workspace-snapshots').glob('*.zip')))==1
        say('PASS: reviewed HTTP Return restored exact prior target, kept current users/session/source/snapshot, and replay did not restart')
    success=True
finally:
    cleanup_error = None
    if parent:
        root, origin, jar, browser, csrf = parent
        if child_id:
            try:
                child = request(f'/api/core-environments/{child_id}')
                child = request(f'/api/core-environments/{child_id}/operations/finish', {'requestId':str(uuid.uuid4()), 'expectedRevision':child['revision']})
                assert child['state'] == 'finished', child
                say('Parent Finish confirmed child resource removal')
            except Exception as error:
                cleanup_error = error
                success = False
                say('Parent Finish failed; retaining child evidence: '+str(error))
    try:
        if (root/'core/run/control.json').exists():
            discovery=json.loads((root/'core/run/control.json').read_text());owned_pids.add(discovery['processId'])
            request('/control/v1/core/stop',{},control=True)
    except Exception as error: say('Cleanup control diagnostic: '+str(error))
    if process:
        try: process.wait(timeout=35)
        except subprocess.TimeoutExpired: process.terminate();process.wait(timeout=10)
    if server: server.shutdown();server.server_close()
    for pid in owned_pids:
        for _ in range(200):
            if not alive(pid): break
            time.sleep(.05)
        else:
            raise RuntimeError('Fixture process did not exit; retain its resources: '+str(pid))
    log.close()
    with socket.socket() as check:
        check.settimeout(1)
        assert check.connect_ex(('127.0.0.1',port))!=0
    if success:
        shutil.rmtree(base)
        say('CLEANUP: test Core, helper and Git server stopped; port released; fixture root, credentials, builds and snapshots removed')
    else: say('Retained failed fixture diagnostics at '+str(base))
    if cleanup_error: raise RuntimeError('Managed fixture cleanup failed') from cleanup_error

"""Core counters and standard tracing through a disposable, parent-owned Core environment."""
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import shutil
import statistics
import time
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[k] for k in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[k] for k in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[k] for k in ('origin', 'password', 'cli'))
    caller = 'test.observability.caller'
    resources = lambda: request('/api/core/resources')['apiActivity']
    baseline = os.environ.get('HOSTY_OBSERVABILITY_BASELINE') == '1'
    if baseline:
        assert os.environ.get('HOSTY_ACTIVATION_CORE'), 'The baseline requires an explicit existing Core executable'
    else:
        assert resources()['apps'] == {}, 'An empty registry must have no fabricated app traffic'

    def install(value, name):
        folder = base/name; folder.mkdir()
        manifest = folder/'manifest.json'
        manifest.write_text(json.dumps(value))
        if (workspace/'apps'/name/'assets').exists():
            shutil.copytree(workspace/'apps'/name/'assets', folder/'assets')
        run([cli, '--data-root', root, 'apps', 'install', manifest, '--runtime', 'docker', '--no-autostart'])

    def start(app):
        run([cli, '--data-root', root, 'apps', 'start', app])

    def link(app):
        return json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']

    def app_origin(url):
        parsed = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))

    class AppBrowser:
        def __init__(self, app):
            self.url = link(app); self.origin = app_origin(self.url)
            self.jar = http.cookiejar.CookieJar()
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
            form = urllib.parse.urlencode({'email':'activation-fixture@example.test', 'password':password,
                'returnTo':'/account/tokens'}).encode()
            with self.client.open(urllib.request.Request(origin+'/login', data=form,
                    headers={'Content-Type':'application/x-www-form-urlencoded', 'Origin':origin}), timeout=30) as result: result.read()
            self.csrf = None
            self.csrf = self.call(origin, '/api/auth/csrf')['token']
            verifier = uuid.uuid4().hex+uuid.uuid4().hex
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
            code = self.call(origin, '/api/apps/'+app+'/launch-code', {'redirectUri':self.url,
                'codeChallenge':challenge, 'codeChallengeMethod':'S256'})['code']
            self.call(self.origin, '/api/auth/app-code', {'code':code, 'codeVerifier':verifier})
            context['diagnostic_secrets'].update(cookie.value for cookie in self.jar)

        def call(self, host, path, body=None):
            headers = {'Content-Type':'application/json','Origin':host}
            if self.csrf and host == origin: headers['X-Hosty-CSRF'] = self.csrf
            with self.client.open(urllib.request.Request(host+path, data=json.dumps(body).encode() if body is not None else None,
                    headers=headers), timeout=180) as response: return json.load(response)

        def get(self, path): return self.call(self.origin, path)

    shell = json.loads((workspace/'apps/shell/manifest.json').read_text())
    shell['source']['repository'] = context['repository']
    shell['services'][0]['runtimes']['docker']['image'] = 'hosty-observability-shell:acceptance'
    install(shell, 'shell'); start('hosty.shell')
    shell_url = wait_for(lambda: request('/api/core/status').get('shellPublicOrigin')) + '/dashboard'

    container = base/'container'; container.mkdir()
    # The fixture only generates requests with its own injected identity. Credentials never leave it.
    (container/'server.cjs').write_text('''const http = require('node:http');
const app = process.env.HOSTY_APP_ID || 'test.observability.caller';
const core = process.env.HOSTY_CORE_ORIGIN;
const headers = {Authorization: 'Bearer '+process.env.HOSTY_APP_SERVICE_TOKEN};
http.createServer(async(q,s)=>{try {
 const url = new URL(q.url, 'http://fixture');
 if(url.pathname==='/burst') {
  const n=Math.min(10000,Math.max(1,Number(url.searchParams.get('count')||250))); let next=0,ok=0;
  const timings=[]; const started=performance.now();
  await Promise.all(Array.from({length:Math.min(8,n)},async()=>{while(next++<n){const t=performance.now();
   const r=await fetch(core+'/api/internal/apps/'+app+'/directory/users',{headers}); await r.arrayBuffer();
   if(r.ok)ok++;timings.push(performance.now()-t);}}));
  timings.sort((a,b)=>a-b);s.setHeader('Content-Type','application/json');
  s.end(JSON.stringify({requests:n,ok,elapsedMs:performance.now()-started,p95Ms:timings[Math.floor(n*.95)]})); return;
 }
 if(url.pathname==='/traces') { const r=await fetch(core+'/api/internal/telemetry/traces',{headers});s.statusCode=r.status;s.end(await r.text());return; }
 if(url.pathname==='/manifest.json') {s.setHeader('Content-Type','application/json');s.end(JSON.stringify({schemaVersion:'app.0.1',id:'test.observability.remote',name:'Remote fixture',description:'Disposable trace fixture',version:'0.1.0',runtimeProfiles:[{key:'docker',type:'docker',default:true}],defaultRuntime:'docker',services:[{key:'web',runtimes:{docker:{type:'docker',image:'hosty-observability-shell:acceptance'}}}]}));return;}
 s.end('Observability fixture');
}catch(e){s.statusCode=500;s.end(JSON.stringify({error:String(e)}));}}).listen(3000,'0.0.0.0');
''')
    image = 'hosty-observability-fixture:'+uuid.uuid4().hex
    (container/'Dockerfile').write_text('FROM hosty-observability-shell:acceptance\nCOPY server.cjs /app/fixture.cjs\nCMD ["node", "/app/fixture.cjs"]\n')
    run(['docker', 'build', '-q', '-t', image, container]); context['desktop_fixture_image'] = image
    value = {'schemaVersion':'app.0.1','id':caller,'name':'API activity fixture','description':'Disposable isolated Core traffic generator.',
        'version':'0.1.0','runtimeProfiles':[{'key':'docker','type':'docker','default':True}],'defaultRuntime':'docker',
        'services':[{'key':'web','runtimes':{'docker':{'type':'docker','image':image,
            'ports':[{'key':'http','containerPort':3000,'protocol':'http','public':True}]}}}],
        'endpoints':[{'key':'web','service':'web','port':'http','protocol':'http','public':True}],
        'ui':{'entrypoint':{'endpoint':'web','path':'/'},'icon':'Activity'},'corePermissions':['apps.read','core.read']}
    install(value, 'caller'); start(caller)
    fixture_origin = app_origin(link(caller))
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def fixture(path):
        with client.open(fixture_origin+path, timeout=180) as response: return json.load(response)
    if baseline:
        # Compare an installed pre-instrumentation executable through the same managed lifecycle,
        # caller image, authenticated API and Docker network. No new API is assumed in this mode.
        fixture('/burst?count=10000')
        runs = [fixture('/burst?count=10000') for _ in range(31)]
        assert all(run['ok'] == 10000 for run in runs)
        summary = {'medianMs':statistics.median(run['elapsedMs'] for run in runs),
            'medianP95Ms':statistics.median(run['p95Ms'] for run in runs),
            'minMs':min(run['elapsedMs'] for run in runs),'maxMs':max(run['elapsedMs'] for run in runs)}
        say('BASELINE PERFORMANCE '+json.dumps(summary))
        return
    before = resources()['apps'][caller]['totalRequests']
    result = fixture('/burst?count=250'); assert result['ok'] == 250, result
    snapshot = wait_for(lambda: (s if (s:=resources())['apps'][caller]['warning'] is not None else None), 15)
    assert snapshot['apps'][caller]['totalRequests']-before == 250
    run_id = snapshot['runId']
    say('PASS: exact 250 calls, app attribution and a burst warning before Telemetry is installed')
    independent = fixture('/traces')
    assert independent['capturing'] and independent['contractVersion'] == 1
    say('PASS: an unrelated installed reader with explicit grants activates the same pull contract')

    telemetry = json.loads((workspace/'apps/telemetry/manifest.json').read_text())
    telemetry['source']['repository'] = context['repository']
    for service in telemetry['services']:
        runtime = service['runtimes']['docker']
        if service['key'] in ('backend','ui'): runtime['image'] = 'hosty-observability-'+service['key']+':acceptance' if service['key']=='backend' else 'hosty-observability-ui:acceptance'
        # Never reserve the ordinary host's collector port in a test instance.
        for port in runtime.get('ports',[]):
            if port.get('expose') == 'host': port['localPort'] = context['free_port']()
    install(telemetry, 'telemetry')
    request('/api/core/settings', {'settings':{'HOSTY_CORE_TRACE_SAMPLE_RATIO':'1'}}, method='PUT', confirm_settings=True)
    start('hosty.telemetry'); telemetry_browser = AppBrowser('hosty.telemetry')
    traces = lambda: telemetry_browser.get('/api/observability/traces?apps=hosty.core&range=3600&limit=500&callerAppId='+caller)
    wait_for(lambda: traces().get('coreTracing',{}).get('state') == 'receiving', 60)
    fixture('/burst?count=20')
    found = wait_for(lambda: (t if (t:=traces())['traces'] else None), 45)
    trace_id = found['traces'][0]['traceId']
    detail = telemetry_browser.get('/api/observability/traces/'+trace_id)
    assert any(s['attributes'].get('hosty.caller.app.id') == caller for s in detail['spans'])
    assert all(s['appId'] == 'hosty.core' for s in detail['spans'])
    assert traces()['coreTracing']['rootSampleRatio'] == 1
    logs = telemetry_browser.get('/api/observability/logs?traceId='+trace_id)
    assert logs['rangeSeconds'] == 0
    say('PASS: standard incoming spans, verified caller filter, Core producer, full sampling and trace-specific log query')

    install_plan = {'manifestPath':fixture_origin+'/manifest.json','selectedRuntime':'docker','autostart':False}
    all_traces = lambda: telemetry_browser.get('/api/observability/traces?apps=hosty.core&range=3600&limit=500&q=install')
    next_outgoing_probe = 0.0
    def outgoing():
        nonlocal next_outgoing_probe
        if time.monotonic() < next_outgoing_probe: return None
        next_outgoing_probe = time.monotonic() + 0.5
        for trace in all_traces()['traces']:
            if 'install' not in trace.get('rootName', ''): continue
            d = telemetry_browser.get('/api/observability/traces/'+trace['traceId'])
            parents = {s['spanId'] for s in d['spans'] if s['kind'].lower() == 'server'
                and 'install' in s.get('name', '')}
            if any(s['kind'].lower() == 'client' and s.get('parentSpanId') in parents for s in d['spans']):
                return d
        return None
    # Filter before the newest-500 result limit: each query authorizes through Core, so a
    # tight unfiltered test poll can displace the very install trace being awaited.
    # The bounded nonblocking writer deliberately permits contention drops, even at 100% root
    # sampling. Require a real parent/client pair but allow a bounded number of fresh attempts.
    outbound = None
    for attempt in range(4):
        request('/api/apps/install/plan', install_plan)
        try:
            outbound = wait_for(outgoing, 12)
            break
        except TimeoutError:
            if attempt == 3:
                page = all_traces()
                say('Missing outbound pair; coverage: '+json.dumps(page.get('coreTracing', {})))
                say('Observed Core trace names: '+json.dumps(sorted({t.get('rootName', t.get('name', '')) for t in page['traces']})))
                raise
    assert outbound is not None
    say('PASS: standard HttpClient span retains its incoming request parent')

    unhealthy = json.loads(json.dumps(value))
    unhealthy['id'] = 'test.observability.readiness'
    unhealthy['name'] = 'Readiness log fixture'
    unhealthy['services'][0]['runtimes']['docker']['healthcheck'] = {
        'type':'exec','command':'node -e "process.exit(1)"','intervalSeconds':1,
        'timeoutSeconds':1,'retries':1,'gracePeriodSeconds':0}
    install(unhealthy, 'readiness')
    start(unhealthy['id'])
    def correlated_log():
        page = telemetry_browser.get('/api/observability/logs?apps=hosty.core&range=3600&q='+unhealthy['id'])
        return next((record for record in page['records'] if record.get('traceId') and 'readiness budget' in record['body']), None)
    correlated = wait_for(correlated_log, 60)
    wait_for(lambda: telemetry_browser.get('/api/observability/traces/'+correlated['traceId'])['spans'], 45)
    assert correlated.get('spanId')
    say('PASS: a real readiness log retains the same trace/span identity through Core pull and Telemetry storage')
    run([cli,'--data-root',root,'apps','stop',unhealthy['id']])

    if os.environ.get('HOSTY_OBSERVABILITY_PERF') == '1':
        # Same process, endpoint, caller, network and eight concurrent workers. Alternate modes
        # to reduce warm-up/order bias; these HTTP measurements include the fixed SDK listeners.
        modes = [('disabled','0','0'), ('counters','1','0'), ('sampled10','1','0.1')]
        measurements = {name: [] for name, _, _ in modes}
        fixture('/burst?count=500')
        for repeat in range(31):
            for name, enabled, ratio in (modes if repeat % 2 == 0 else list(reversed(modes))):
                request('/api/core/settings', {'settings':{'HOSTY_API_ACTIVITY_ENABLED':enabled,
                    'HOSTY_CORE_TRACE_SAMPLE_RATIO':ratio}}, method='PUT', confirm_settings=True)
                fixture('/burst?count=2000')
                measurements[name].append(fixture('/burst?count=10000'))
        # Keep deliberate 100% tracing stress out of the default-mode comparison: its
        # retained spans and subsequent ingest/GC can affect the following measurement.
        request('/api/core/settings', {'settings':{'HOSTY_API_ACTIVITY_ENABLED':'1',
            'HOSTY_CORE_TRACE_SAMPLE_RATIO':'1'}}, method='PUT', confirm_settings=True)
        measurements['sampled100'] = []
        for _ in range(11):
            fixture('/burst?count=2000')
            measurements['sampled100'].append(fixture('/burst?count=10000'))
        summary = {name: {'medianMs':statistics.median(r['elapsedMs'] for r in samples),
            'medianP95Ms':statistics.median(r['p95Ms'] for r in samples),
            'minMs':min(r['elapsedMs'] for r in samples),'maxMs':max(r['elapsedMs'] for r in samples)}
            for name,samples in measurements.items()}
        say('PERFORMANCE '+json.dumps(summary))
        # Diagnostic evidence stays in the disposable fixture; the PR records only its summary.
        (base/'performance.json').write_text(json.dumps({'summary':summary,'runs':measurements}))
        request('/api/core/settings', {'settings':{'HOSTY_API_ACTIVITY_ENABLED':'1','HOSTY_CORE_TRACE_SAMPLE_RATIO':'1'}}, method='PUT', confirm_settings=True)

    if os.environ.get('HOSTY_OBSERVABILITY_BROWSER') == '1':
        fixture('/burst?count=250')
        access = base/'browser-access.json'
        access.write_text(json.dumps({'core':origin,'shell':shell_url,'telemetry':telemetry_browser.url,
            'traceId':trace_id,'caller':caller,'email':'activation-fixture@example.test','password':password}))
        os.chmod(access,0o600)
        say('UI READY: '+str(access)+'; create finish-ui after browser verification')
        deadline=time.time()+1800
        while time.time()<deadline and not (base/'finish-ui').exists(): time.sleep(.5)
        assert (base/'finish-ui').exists(), 'Browser checks were not acknowledged'
        access.unlink()

    previous_coverage = traces()['coreTracing']
    run([cli,'--data-root',root,'apps','stop','hosty.telemetry'])
    before = resources()['apps'][caller]['totalRequests']
    # Exercise buffer overflow as well as the absence of a consumer. Capture's 30-second
    # grace period still applies, so a resumed reader may also have an expired cursor.
    assert fixture('/burst?count=2500')['ok'] == 2500
    assert resources()['apps'][caller]['totalRequests']-before == 2500
    # Let both authorized reader leases expire without renewing either one.
    time.sleep(31)
    resumed = fixture('/traces')
    assert resumed['captureStartedAt'] != independent['captureStartedAt']
    start('hosty.telemetry')
    def resumed_coverage():
        coverage = traces()['coreTracing']
        return (coverage['gapCount'] > previous_coverage['gapCount']
            and coverage['captureStartedAt'] != previous_coverage['captureStartedAt']
            and coverage.get('lastGapReason') in ('capture_resumed', 'cursor_expired'))
    wait_for(resumed_coverage, 60)
    assert resources()['runId'] == run_id
    say('PASS: counters survive stopped Telemetry; expired capture resumes with an explicit stored coverage gap')
    # Restart only through the owning parent. Keep the durable request ID for uncertain outcomes.
    keys = ('root','origin','jar','browser','csrf')
    def owner_call(path, body=None):
        child_context = tuple(context[key] for key in keys)
        context.update(zip(keys,context['parent']))
        try: return request(path,body)
        finally: context.update(zip(keys,child_context))
    child_id = context['child_id']
    current = owner_call('/api/core-environments/'+child_id)
    operation = {'requestId':str(uuid.uuid4()),'expectedRevision':current['revision']}
    receipt = base/'observability-restart-request.json'; receipt.write_text(json.dumps(operation)); os.chmod(receipt,0o600)
    restarted = owner_call('/api/core-environments/'+child_id+'/operations/restart',operation)
    assert restarted['state']=='running' and restarted['process']['pid'] != current['process']['pid']
    context['owned_pids'].add(restarted['process']['pid'])
    assert resources()['runId'] != run_id
    start('hosty.shell'); start(caller); start('hosty.telemetry')
    fixture('/burst?count=10')
    wait_for(lambda: traces()['coreTracing'].get('lastGapReason') == 'core_restarted', 60)
    assert resources()['apps'][caller]['totalRequests'] >= 10
    say('PASS: owner-managed Core restart resets exact counters and persists the trace coverage gap')
    say('No ordinary application data or provider credentials were used')

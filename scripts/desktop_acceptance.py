"""Desktop identity and lifecycle acceptance in the parent-managed child Core fixture."""
import base64
import hashlib
import http.cookiejar
import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def check(context):
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    run, request, say, wait_for = (context[key] for key in ('run', 'request', 'say', 'wait_for'))
    origin, password, cli = (context[key] for key in ('origin', 'password', 'cli'))
    app = 'hosty.desktop'
    manifest = json.loads((workspace/'apps/desktop/manifest.json').read_text())
    manifest['source']['repository'] = context['repository']
    manifest_path = base/'manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    shutil.copytree(workspace/'apps/desktop/assets', base/'assets')
    run([cli, '--data-root', root, 'apps', 'install', manifest_path, '--runtime', 'docker', '--no-autostart'])
    run([cli, '--data-root', root, 'apps', 'start', app])
    wait_for(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)
    link = json.loads(run([cli, '--data-root', root, 'apps', 'open', app, '--format', 'json']))['url']
    parsed = urllib.parse.urlparse(link)
    app_origin = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
    image = manifest['services'][0]['runtimes']['docker']['image']
    fixture_image = 'hosty-desktop-fixture:'+uuid.uuid4().hex
    fixture = base/'container'
    fixture.mkdir()
    (fixture/'Dockerfile').write_text('FROM '+image['repository']+':'+image['tag']+'\n'
        'CMD ["node", "-e", "if(process.env.FAIL)process.exit(17); require(\'http\').createServer((q,s)=>s.end(\'<h1>Desktop fixture</h1>\')).listen(3000,\'0.0.0.0\')"]\n')
    run(['docker', 'build', '-q', '-t', fixture_image, fixture])
    context['desktop_fixture_image'] = fixture_image
    fixtures = [('test.desktop.ready', 'Desktop fixture', False),
                ('test.desktop.failure', 'Failure fixture', True),
                ('test.desktop.hidden', 'Unassigned fixture', False)]
    for id, name, fail in fixtures:
        value = {'schemaVersion':'app.0.1', 'id':id, 'name':name, 'description':'Disposable Desktop acceptance fixture.', 'version':'0.1.0',
            'runtimeProfiles':[{'key':'docker','type':'docker','default':True}], 'defaultRuntime':'docker',
            'services':[{'key':'web','runtimes':{'docker':{'type':'docker','image':fixture_image,
                'environment':{'FAIL':'1'} if fail else {},
                'ports':[{'key':'http','containerPort':3000,'protocol':'http','public':True}]}}}],
            'endpoints':[{'key':'web','service':'web','port':'http','protocol':'http','public':True}],
            'ui':{'entrypoint':{'endpoint':'web','path':'/'},'icon':'AppWindow'}}
        path = base/(id+'.json'); path.write_text(json.dumps(value))
        run([cli, '--data-root', root, 'apps', 'install', path, '--no-autostart'])

    class Browser:
        def __init__(self, email):
            self.jar = http.cookiejar.CookieJar()
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))
            self.csrf = None
            form = urllib.parse.urlencode({'email':email, 'password':password, 'returnTo':'/api/auth/session'}).encode()
            with self.client.open(urllib.request.Request(origin+'/login', data=form,
                    headers={'Content-Type':'application/x-www-form-urlencoded','Origin':origin}), timeout=30) as response: response.read()
            identity = self.call(origin, '/api/auth/session')
            assert identity['authenticated']
            self.user = identity['user']['id']
            self.csrf = self.call(origin, '/api/auth/csrf')['token']
            verifier = uuid.uuid4().hex + uuid.uuid4().hex
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
            code = self.call(origin, '/api/apps/'+app+'/launch-code', {'redirectUri':link,
                'codeChallenge':challenge,'codeChallengeMethod':'S256'})['code']
            self.call(app_origin, '/api/auth/app-code', {'code':code,'codeVerifier':verifier})
            context['diagnostic_secrets'].update(cookie.value for cookie in self.jar)
            self.desktop_csrf = self.desktop('/auth/csrf')['token']

        def call(self, host, path, body=None, expected=200):
            headers = {'Content-Type':'application/json','Origin':host}
            if self.csrf and host == origin: headers['X-Hosty-CSRF'] = self.csrf
            if host == app_origin and hasattr(self, 'desktop_csrf'): headers['X-Hosty-CSRF'] = self.desktop_csrf
            try:
                with self.client.open(urllib.request.Request(host+path, data=json.dumps(body).encode() if body is not None else None,
                        headers=headers), timeout=180) as response: status, raw = response.status, response.read()
            except urllib.error.HTTPError as error: status, raw = error.code, error.read()
            value = json.loads(raw) if raw else None
            assert status == expected, (path, status, value.get('code') if isinstance(value,dict) else None)
            return value

        def desktop(self, path, body=None, expected=200):
            return self.call(app_origin, '/api/core/api'+path, body, expected)

    invitation = request('/api/auth/invitations', {'email':'desktop-member@example.test','displayName':'Desktop member','role':'host.user'}, confirm_settings=True)
    context['diagnostic_secrets'].add(invitation['token'])
    # Accept in a separate cookie-free client; do not replace the fixture owner's session.
    with urllib.request.urlopen(urllib.request.Request(origin+'/api/auth/invitations/accept',
            data=json.dumps({'setupToken':invitation['token'],'displayName':'Desktop member','password':password}).encode(),
            headers={'Content-Type':'application/json','Origin':origin}), timeout=30) as response:
        member_setup = json.load(response)
    member_id = member_setup['user']['id']
    def assignments(ids):
        return request('/api/auth/users/'+member_id+'/assignments', {'assignedAppIds':ids}, method='PUT', confirm_settings=True)
    assignments([app, fixtures[0][0], fixtures[1][0]])
    admin, member = Browser('activation-fixture@example.test'), Browser('desktop-member@example.test')
    assert admin.desktop('/auth/session')['user']['role'] == 'host.admin'
    assert member.desktop('/auth/session')['user']['role'] == 'host.user'
    assert {a['id'] for a in admin.desktop('/apps')['apps']} >= {f[0] for f in fixtures}
    assert fixtures[2][0] not in {a['id'] for a in member.desktop('/apps')['apps']}
    member.desktop('/apps/'+fixtures[0][0]+'/start', {}, expected=403)
    admin.desktop('/apps/'+fixtures[0][0]+'/start', {})
    wait_for(lambda: next(a for a in member.desktop('/apps')['apps'] if a['id']==fixtures[0][0])['runtimeState']=='running')
    assignments([app])
    assert fixtures[0][0] not in {a['id'] for a in member.desktop('/apps')['apps']}
    assignments([app, fixtures[0][0], fixtures[1][0]])
    admin.desktop('/apps/'+fixtures[0][0]+'/stop', {})
    say('PASS: Docker Desktop, normal password login, separate roles, assignment filtering/revocation, denied member start and admin start/stop')
    if os.environ.get('HOSTY_DESKTOP_BROWSER') == '1':
        access = base/'browser-access.json'
        access.write_text(json.dumps({'core':origin,'url':link,'email':'activation-fixture@example.test',
            'memberEmail':'desktop-member@example.test','password':password}))
        os.chmod(access, 0o600)
        say('UI READY: '+str(access)+'; create revoke-access for revocation, then finish-ui after browser checks')
        deadline = time.time()+1800
        revoked = False
        while time.time()<deadline and not (base/'finish-ui').exists():
            if not revoked and (base/'revoke-access').exists():
                assignments([app]); revoked = True
                say('UI: member assignment revoked; the embedded frame and dock entry must disappear on refresh')
            time.sleep(.5)
        assert (base/'finish-ui').exists(), 'Browser acceptance did not acknowledge completion'
        access.unlink()
    say('No provider credentials or ordinary application data were used')

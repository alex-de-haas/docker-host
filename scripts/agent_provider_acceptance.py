"""Independent provider setup for disposable, Core-managed acceptance environments.

The helper uses normal password/app-code identity and each provider's own settings API.
It never reads a personal CLI home or copies provider credentials from another app.
"""
import base64
import hashlib
import http.cookiejar
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request
import uuid


def execution_stopped(session):
    """Only an authoritative public provider snapshot can confirm an admitted run stopped."""
    execution = session.get('providerExecution') or {}
    return not execution.get('runId') or (execution.get('run') or {}).get('stopConfirmed') is True


class ProviderAcceptance:
    def __init__(self, context):
        self.context = context
        self.root = pathlib.Path(context['root'])
        self.workspace = pathlib.Path(context['workspace'])
        self.base = pathlib.Path(context['base'])
        self.origin = context['origin']
        self.entries = {}
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = None
        form = urllib.parse.urlencode({'email': 'activation-fixture@example.test', 'password': context['password'],
                                      'returnTo': '/api/auth/session'}).encode()
        with self.client.open(urllib.request.Request(self.origin+'/login', data=form,
                headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': self.origin}), timeout=30) as response:
            response.read()
        assert self.call(self.origin, '/api/auth/session')['authenticated']
        self.csrf = self.call(self.origin, '/api/auth/csrf')['token']
        context.get('diagnostic_secrets', set()).add(self.csrf)

    def call(self, host, route, body=None, method=None):
        headers = {'Content-Type': 'application/json', 'Origin': host}
        if host == self.origin and self.csrf:
            headers['X-Hosty-CSRF'] = self.csrf
        request = urllib.request.Request(host+route,
            data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with self.client.open(request, timeout=180) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            try:
                failure = json.load(error)
            except (ValueError, OSError):
                failure = {}
            details = failure.get('error') if isinstance(failure, dict) else None
            code = (failure.get('code') if isinstance(failure, dict) else None) or (details.get('code') if isinstance(details, dict) else None) or 'request_failed'
            if route == '/probe' and code == 'acceptance_failed' and isinstance(details, dict):
                # The test consumer uses fixed assertion messages for this code.
                raise AssertionError(f'Independent consumer probe: {details.get("message", code)}') from None
            raise AssertionError(f'Provider acceptance request {route} failed: HTTP {error.code}, {code}') from None

    def authenticate(self, app_id):
        run, cli = self.context['run'], self.context['cli']
        link = json.loads(run([cli, '--data-root', self.root, 'apps', 'open', app_id, '--format', 'json']))['url']
        parsed = urllib.parse.urlparse(link)
        host = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, '', '', '', ''))
        verifier = uuid.uuid4().hex + uuid.uuid4().hex
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        code = self.call(self.origin, '/api/apps/'+urllib.parse.quote(app_id, safe='')+'/launch-code',
            {'redirectUri': link, 'codeChallenge': challenge, 'codeChallengeMethod': 'S256'})['code']
        self.context.get('diagnostic_secrets', set()).update([code, verifier])
        identity = self.call(host, '/api/auth/exchange', {'code': code, 'codeVerifier': verifier})
        if isinstance(identity, dict) and identity.get('accessToken'):
            self.context.get('diagnostic_secrets', set()).add(identity['accessToken'])
        return {'appId': app_id, 'origin': host, 'link': link}

    def install_all(self, scripted_codex=True):
        """Install actual Local provider recipes from the isolated fixture repository."""
        for kind, slug in [('codex', 'codex-provider'), ('claude', 'claude-code-provider'), ('ollama', 'ollama-provider')]:
            if kind in self.entries:
                continue
            manifest = json.loads((self.workspace/'apps'/slug/'manifest.json').read_text())
            manifest['source']['repository'] = self.context['repository']
            if scripted_codex and kind == 'codex':
                fixture = self.workspace/'apps/codex-provider/test/fake-codex-server.mjs'
                assert fixture.is_file()
                manifest['services'][0]['runtimes']['local'].setdefault('environment', {})['HOSTY_HARNESS_CODEX_COMMAND'] = str(fixture)
            target = self.base/(slug+'-acceptance.json')
            target.write_text(json.dumps(manifest))
            self.context['run']([self.context['cli'], '--data-root', self.root, 'apps', 'install', target, '--runtime', 'local', '--no-autostart'])
            self.context['run']([self.context['cli'], '--data-root', self.root, 'apps', 'start', manifest['id']])
            self.context['wait_for'](lambda: self.context['request']('/api/apps/'+manifest['id']+'/health')['status'] == 'healthy', 240)
            source = self.context['request']('/control/v1/apps/'+manifest['id']+'/source', control=True).get('source') or {}
            for key in ('managedCheckoutPath', 'localOverridePath'):
                if source.get(key):
                    resolved = pathlib.Path(source[key]).resolve()
                    assert resolved.is_relative_to(self.root.resolve()), 'Provider source must belong to the disposable child'
                    assert not resolved.is_relative_to(self.workspace.resolve()), 'Provider setup must not mutate the registered worktree'
            self.entries[kind] = self.authenticate(manifest['id'])
        self.context['agentProviders'] = self
        if self.context.get('scenario') == 'agent-providers':
            self.independent_consumer()
        return self

    def independent_consumer(self):
        """Exercise an unrelated SDK-only application before Harness exists in the child."""
        context = self.context
        harness_id = json.loads((self.workspace/'apps/harness/manifest.json').read_text())['id']
        assert harness_id not in {app['id'] for app in context['request']('/api/apps')['apps']}
        manifest_path = self.workspace/'scripts/fixtures/agent-consumer/manifest.json'
        manifest = json.loads(manifest_path.read_text())
        assert manifest['id'] not in {harness_id, *(entry['appId'] for entry in self.entries.values())}
        assert manifest['corePermissions'] == ['providers.agent']
        manifest['source']['repository'] = context['repository']
        target = self.base/'independent-consumer-manifest.json'
        target.write_text(json.dumps(manifest))
        run, cli = context['run'], context['cli']
        run([cli, '--data-root', self.root, 'apps', 'install', target, '--runtime', 'local', '--no-autostart'])
        run([cli, '--data-root', self.root, 'apps', 'start', manifest['id']])
        context['wait_for'](lambda: context['request']('/api/apps/'+manifest['id']+'/health')['status'] == 'healthy', 90)
        try:
            entry = self.authenticate(manifest['id'])
            connection = self.configure('codex', 'Independent SDK-only account', secret='synthetic-independent-consumer-only')
            payload = {'providerAppId': self.entries['codex']['appId'], 'connectionId': connection['id'], 'connectionRevision': connection['revision']}
            anonymous = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                anonymous.open(urllib.request.Request(entry['origin']+'/probe', data=json.dumps(payload).encode(),
                    headers={'Content-Type': 'application/json', 'Origin': entry['origin']}), timeout=15)
                raise AssertionError('An anonymous consumer probe unexpectedly succeeded')
            except urllib.error.HTTPError as error:
                assert error.code == 401
                assert json.load(error)['error']['code'] == 'app_identity_required'
            result = self.call(entry['origin'], '/probe', payload)
            assert result['appId'] == manifest['id'] and result['provider']['appId'] == self.entries['codex']['appId']
            assert result['provider']['installationId'] and result['provider']['key']
            assert result['connection'] == {'id': connection['id'], 'revision': connection['revision']}
            assert result['configuration'] == {'connection': result['connection']}
            assert len(result['runs']) == 2 and len({run['runId'] for run in result['runs']}) == 2
            assert all(run['state'] == 'succeeded' and run['stopConfirmed'] and run['replayedEvents'] > 0 for run in result['runs'])
            assert result['denied']['noActor']['status'] in (401, 403)
            assert (result['denied']['staleProvider']['status'] in (403, 404, 409)
                    or result['denied']['staleProvider'] == {'status': 503, 'code': 'provider_unavailable'})
            assert result['denied']['staleAccount']['status'] == 409
            assert result['denied']['staleAccount']['code'] == 'connection_revision_mismatch'
            assert harness_id not in {app['id'] for app in context['request']('/api/apps')['apps']}
            context['independentAgentConsumerProof'] = result
            context['say']('PASS: unrelated SDK-only Local consumer signs in through Core, rejects missing actor/stale installation/account, streams and resumes plain provider session before Harness installation')
        finally:
            run([cli, '--data-root', self.root, 'apps', 'stop', manifest['id']])
            context['wait_for'](lambda: next(app for app in context['request']('/api/apps')['apps'] if app['id'] == manifest['id'])['runtimeState'] == 'stopped', 30)

    def configure(self, kind, name, auth='api-key', secret=None, base_url=None):
        entry = self.entries[kind]
        body = {'name': name, 'auth': auth}
        if secret is not None:
            self.context.get('diagnostic_secrets', set()).add(secret)
            body['secret'] = secret
        if base_url is not None:
            body['baseUrl'] = base_url
        before = {row['id'] for row in self.call(entry['origin'], '/api/settings/connections')['connections']}
        result = self.call(entry['origin'], '/api/settings/connections', body)
        candidates = [row for row in result['connections'] if row['id'] not in before and row['name'] == name]
        assert len(candidates) == 1, 'Provider must return exactly the new configured connection'
        connection = candidates[0]
        self.call(entry['origin'], '/api/settings/default', {'id': connection['id']}, method='PUT')
        entry['connection'] = connection
        return connection

    def harness_connection(self, harness_origin, call, kind, connection=None):
        entry = self.entries[kind]
        selected = connection or entry.get('connection')
        assert selected, 'Configure the provider account before selecting it in Harness'
        def lookup():
            candidates = [row for row in call(harness_origin, '/api/connections')['connections']
                if row.get('provider', {}).get('appId') == entry['appId'] and row['name'] == selected['name']]
            assert len(candidates) <= 1, 'The test account name must identify exactly one qualified connection'
            return candidates[0] if candidates else None
        connection = self.context['wait_for'](lookup, 90)
        assert connection['kind'] == 'agent' and isinstance(connection['revision'], str)
        assert connection['provider'].get('installationId') and connection['provider'].get('key')
        return connection

    def configure_for_harness(self, harness_origin, call, kind, name, auth='api-key', secret=None, base_url=None):
        connection = self.configure(kind, name, auth=auth, secret=secret, base_url=base_url)
        return self.harness_connection(harness_origin, call, kind, connection)

    def restart(self, kind):
        entry = self.entries[kind]
        self.context['run']([self.context['cli'], '--data-root', self.root, 'apps', 'restart', entry['appId']])
        self.context['wait_for'](lambda: self.context['request']('/api/apps/'+entry['appId']+'/health')['status'] == 'healthy', 180)
        entry.update(self.authenticate(entry['appId']))
        return entry

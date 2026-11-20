"""Named speech acceptance with synthetic accounts in the running Harness child."""
import json
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import wave


def check_named_speech(context, harness_id, harness_origin, harness_link, client, providers):
    root, base, source = (context[key] for key in ('root', 'base', 'workspace'))
    run, request, wait_for = (context[key] for key in ('run', 'request', 'wait_for'))
    cli, core = context['cli'], context['origin']
    stt, tts = 'speech-to-text', 'text-to-speech'

    def install(manifest, runtime):
        manifest['source']['repository'] = context['repository']
        file = base / (manifest['id'] + '-speech-acceptance.json')
        file.write_text(json.dumps(manifest))
        run([cli, '--data-root', root, 'apps', 'install', file, '--runtime', runtime, '--no-autostart'])
        run([cli, '--data-root', root, 'apps', 'start', manifest['id']])
        wait_for(lambda: request('/api/apps/' + manifest['id'] + '/health')['status'] == 'healthy', 180)

    # Establish both independent Core and Harness sessions before adding a secondary system UI,
    # which may redirect a completed Core login to its own dashboard.
    from workspace_sessions_acceptance import session_browser
    Browser = session_browser(context, harness_id, harness_origin, harness_link)
    other = Browser('speech-second@example.test', 'Second speech user', invited=True)

    fixture = json.loads((source / 'scripts/fixtures/speech/manifest.json').read_text())
    evidence = base / 'speech-playback.jsonl'
    fixture['services'][0]['runtimes']['local']['environment'] = {'HOSTY_SPEECH_FIXTURE_RECEIPTS': str(evidence)}
    install(fixture, 'local')
    shell = json.loads((source / 'apps/shell/manifest.json').read_text())
    shell['source']['manifestPath'] = 'apps/shell/manifest.json'
    shutil.copytree(source / 'apps/shell/assets', base / 'assets', dirs_exist_ok=True)
    install(shell, 'dev')
    shell_origin = wait_for(lambda: request('/control/v1/core/status', control=True)['shellPublicOrigin'])
    shell_link = json.loads(run([cli, '--data-root', root, 'apps', 'open', shell['id'],
                                 '--redirect-uri', shell_origin + '/dashboard', '--format', 'json']))['url']

    # Use Core's isolated review form so the browser frame receives the same microphone permission as production.
    permission = request('/api/installations', {'permissionsAppId': harness_id})
    request('/api/installations/' + permission['id'] + '/submit', {})
    with client.open(core + '/install/confirm/' + permission['id'], timeout=30) as response:
        html, confirmation = response.read().decode(), response.url
    assert confirmation.startswith(core + '/install/confirm/')
    nonce = re.search(r'name=nonce value="([^"]+)"', html).group(1)
    context['diagnostic_secrets'].add(nonce)
    form = urllib.parse.urlencode([('nonce', nonce), ('decision', 'approve'),
        ('optionalPermission', 'providers.' + stt), ('optionalPermission', 'providers.' + tts)]).encode()
    with client.open(urllib.request.Request(confirmation, data=form,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': core}), timeout=60) as response:
        response.read()

    wait_for(lambda: request('/api/installations/' + confirmation.rsplit('/', 1)[-1])['status'] == 'succeeded', 30)
    codex = providers.entries['codex']
    codex_url = codex['origin']
    def account(name):
        value = providers.call(codex_url, '/api/settings/connections',
            {'name': name, 'auth': 'api-key', 'secret': 'synthetic-named-speech-' + name, 'publishedInterfaces': [stt, tts]})
        return next(row for row in value['connections'] if row['id'] == value['saved']['id'])
    work = account('Work fixture')
    personal = account('Personal fixture')
    def roles(row, enabled, name):
        result = providers.call(codex_url, '/api/settings/connections/' + row['id'],
            {'expectedRevision': row['revision'], 'expectedSettingsRevision': row['settingsRevision'],
             'name': name, 'publishedInterfaces': enabled}, method='PUT')
        return next(current for current in result['connections'] if current['id'] == row['id'])

    def settings():
        with client.open(harness_origin + '/api/speech/settings', timeout=30) as response:
            return json.load(response)
    def named(kind):
        return [p for p in settings()['roles'][kind]['providers'] if p['appId'] == codex['appId']]
    wait_for(lambda: len(named(stt)) == len(named(tts)) == 2, 30)
    selected = next(p for p in named(tts) if p['displayName'].endswith('Work fixture'))
    old_id = selected['implementationId']
    assert selected['available'] and old_id and len({p['implementationId'] for p in named(tts)}) == 2
    state = settings()
    body = {'account': state['account'], 'revision': state['revision'], 'kind': tts, 'choice': selected}
    req = urllib.request.Request(harness_origin + '/api/speech/settings', data=json.dumps(body).encode(), method='PUT',
        headers={'Content-Type': 'application/json', 'Origin': harness_origin})
    with client.open(req, timeout=30) as response:
        assert response.status == 200
    work = roles(work, [stt, tts], 'Team fixture')
    wait_for(lambda: any(p['implementationId'] == old_id and p['displayName'].endswith('Team fixture') for p in named(tts)), 30)
    bound = settings()['roles'][tts]['binding']
    with client.open(harness_origin + '/api/speech/capabilities?' + urllib.parse.urlencode({'kind': tts, 'binding': bound}), timeout=30) as response:
        assert json.load(response)['ready']
    work = roles(work, [stt], 'Team fixture')
    wait_for(lambda: len(named(stt)) == 2 and len(named(tts)) == 1, 30)
    stale = settings()['roles'][tts]
    assert stale['selected']['implementationId'] == old_id and all(p['implementationId'] != old_id for p in stale['providers'])

    try:
        with client.open(harness_origin + '/api/speech/capabilities?' + urllib.parse.urlencode({'kind': tts, 'binding': bound}), timeout=30):
            raise AssertionError('A withdrawn named role still accepts the saved binding')
    except urllib.error.HTTPError as error:
        assert error.code == 409 and json.load(error)['code'] == 'provider_unavailable'
    context['say']('PASS: named dispatch readiness, stable rename and rejection of a withdrawn role')
    # Keep independent password-authenticated sessions while an operator withdraws and restores
    # an exact named implementation. Neither capabilities nor preference reads call OpenAI.
    def save_for_other(kind, provider):
        state = other.harness('/speech/settings')
        other.harness('/speech/settings', {'account': state['account'], 'revision': state['revision'],
            'kind': kind, 'choice': provider}, method='PUT')
    assert settings()['account'] != other.harness('/speech/settings')['account']
    local = next(p for p in settings()['roles'][tts]['providers'] if p['appId'] == fixture['id'])
    personal_stt = next(p for p in named(stt) if p['displayName'].endswith('Personal fixture'))
    save_for_other(stt, personal_stt)
    save_for_other(tts, local)
    state = other.harness('/speech/settings')
    assert state['roles'][stt]['selected']['implementationId'] == personal_stt['implementationId']
    assert state['roles'][tts]['selected']['appId'] == fixture['id']
    other_caps = other.harness('/speech/capabilities?' + urllib.parse.urlencode({'kind': stt, 'binding': state['roles'][stt]['binding']}))
    assert other_caps['ready']
    denied = other.harness('/speech/capabilities?' + urllib.parse.urlencode({'kind': tts, 'binding': bound}), expected=409)
    assert denied['code'] == 'provider_unavailable'
    assert settings()['roles'][tts]['selected']['implementationId'] == old_id
    roles(work, [stt, tts], 'Team fixture')
    wait_for(lambda: any(p['implementationId'] == old_id for p in named(tts)), 30)
    recovered = settings()['roles'][tts]
    assert recovered['selected']['implementationId'] == old_id and recovered['binding']
    context['say']('PASS: two password-authenticated users keep separate mixed named/local speech preferences through role withdrawal and recovery')

    connection = providers.harness_connection(harness_origin, lambda host, route: json.load(client.open(host + route)), 'codex', personal)
    sound = base / 'named-speech-microphone.wav'
    with wave.open(str(sound), 'wb') as output:
        output.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        output.writeframes(bytes(96000))
    config = {'core': (context.get('child', {}).get('previewUrl') or core).rstrip('/'),
              'email': 'activation-fixture@example.test', 'password': context['password'],
              'harness': harness_origin, 'appId': harness_id, 'link': harness_link,
              'shellId': shell['id'], 'shellLink': shell_link, 'connection': connection['id'],
              'localName': fixture['name'], 'wav': str(sound), 'evidence': str(evidence)}
    subprocess.run(['node', str(source / 'apps/harness/test/named-speech-browser.mjs')],
        input=json.dumps(config), text=True, check=True, cwd=source)
    context['say']('PASS: two named OpenAI accounts, stable rename, role withdrawal, exact selection, embedded dictation and bounded section playback')

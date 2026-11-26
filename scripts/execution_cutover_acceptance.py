"""Verify the v1/v2 startup boundary on a disposable, authenticated Core installation."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
import uuid
from contextlib import closing
from agent_provider_acceptance import ProviderAcceptance
from workspace_sessions_acceptance import session_browser


def check(context):
    root, base, repo = (context[key] for key in ('root', 'base', 'workspace'))
    run, request, wait, say = (context[key] for key in ('run', 'request', 'wait_for', 'say'))
    assert root.resolve().is_relative_to(base.resolve())
    cli = [context['cli'], '--data-root', root, 'apps']

    def install(slug, runtime):
        manifest = json.loads((repo/'apps'/slug/'manifest.json').read_text())
        manifest['source'].update(repository=context['repository'], manifestPath='apps/'+slug+'/manifest.json')
        if runtime == 'docker':
            manifest['services'][0]['runtimes']['docker']['image'] = os.environ['HOSTY_AGENT_PROVIDERS_API_IMAGE']
            shutil.copytree(repo/'apps'/slug/'assets', base/'assets', dirs_exist_ok=True)
        else:
            environment = manifest['services'][0]['runtimes']['local'].setdefault('environment', {})
            environment.update(HOSTY_HARNESS_CODEX_COMMAND=str(repo/'apps/codex-provider/test/fake-codex-server.mjs'),
                               TEST_UNIQUE_THREAD_IDS='1')
        path = base/(slug+'-cutover.json')
        path.write_text(json.dumps(manifest))
        run([*cli, 'install', path, '--runtime', runtime, '--no-autostart'])
        return manifest['id']

    def start(app):
        run([*cli, 'start', app])
        wait(lambda: request('/api/apps/'+app+'/health')['status'] == 'healthy', 180)

    def refuse(app, reason):
        # Core may accept the process start before its guard exits. Check the actual service diagnostic.
        try:
            run([*cli, 'start', app])
        except RuntimeError:
            pass
        api = '/api/apps/'+app
        wait(lambda: reason in request(api+'/logs?tail=100')['text'], 90)
        assert request(api+'/health')['status'] != 'healthy'
        run([*cli, 'stop', app])

    def save(file, value):
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_suffix('.tmp')
        temporary.write_text(json.dumps(value))
        temporary.replace(file)

    codex = install('codex-provider', 'local')
    harness = install('harness', 'docker')
    start(codex)
    providers = ProviderAcceptance(context)
    providers.entries['codex'] = providers.authenticate(codex)
    account = providers.configure('codex', 'Cutover account', secret='synthetic-cutover-credential')
    run([*cli, 'stop', codex])
    provider_data = root/'apps'/codex/'data'
    harness_data = root/'apps'/harness/'data'
    assert all(path.resolve().is_relative_to(root.resolve()) for path in (provider_data, harness_data))
    old_chat, old_session, old_run, generation = (str(uuid.uuid4()) for _ in range(4))
    history = harness_data/'sessions'/old_chat
    consumer_record = history/'record.json'
    retained = history/'events.jsonl'
    provider_record = provider_data/'agent-sessions'/(old_session+'.json')
    database = provider_data/'agent-sessions'/'execution-v2.sqlite'

    def admitted():
        with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True)) as db:
            return db.execute('SELECT id FROM execution_runs ORDER BY id').fetchall()
    assert admitted() == []
    record = {'version': 1, 'id': old_session, 'runs': {old_run: {'snapshot': {
        'ref': {'id': old_run}, 'generation': generation, 'stopConfirmed': False}}}}
    chat = {'agentConsumerVersion': 1, 'id': old_chat, 'createdBy': context['user'], 'status': 'running'}
    save(provider_record, record)
    save(consumer_record, chat)
    save(harness_data/'agent-consumer-format.json', {'version': 1})
    retained.write_text('{"type":"assistant_text","text":"private v1 history"}\n')
    native_file = provider_data/'cutover-retained-native.txt'
    native_file.write_text('private native account file')
    # The old owner fixture holds a real open file. The stored v1 records model an active installation.
    sentinel = base/'old-writer.txt'
    script = """import pathlib, sys
with pathlib.Path(sys.argv[1]).open('w') as writer:
    writer.write('active'); writer.flush()
    if sys.stdin.readline().strip() != 'drain': sys.exit(2)
    writer.write(' drained'); writer.flush()
"""
    with subprocess.Popen([sys.executable, '-c', script, str(sentinel)], stdin=subprocess.PIPE, text=True) as writer:
        try:
            wait(lambda: sentinel.exists() and sentinel.read_text() == 'active')
            refuse(codex, 'previous provider has an unclosed execution')
            refuse(harness, 'has an unconfirmed writer')
            assert writer.poll() is None and sentinel.read_text() == 'active'
            assert admitted() == [] and not (harness_data/'execution-v2'/'agent-consumer-format.json').exists()
        finally:
            writer.communicate('drain\n', timeout=15)
        assert writer.returncode == 0 and sentinel.read_text() == 'active drained'
    legacy_run = record['runs'][old_run]
    legacy_run['snapshot']['stopConfirmed'] = True
    legacy_run.update(workspaces=[{'id': str(uuid.uuid4())}], workspaceRelease={'state': 'pending'})
    save(provider_record, record)
    refuse(codex, "Release the previous provider's workspace lease")
    legacy_run['workspaceRelease']['state'] = 'released'
    legacy_run['reservedFor'] = {'runId': old_run, 'requestId': str(uuid.uuid4())}
    save(provider_record, record)
    refuse(codex, "Cancel the previous provider's continuation")
    del legacy_run['reservedFor']
    save(provider_record, record)
    raw_journal = provider_data/'execution-journal'/(old_run+'.json')
    save(raw_journal, {'version': 1, 'receipt': {'runId': old_run, 'exitConfirmed': False}})
    refuse(codex, 'previous provider has an unconfirmed native execution')
    save(raw_journal, {'version': 1, 'receipt': {'runId': old_run, 'exitConfirmed': True}})
    chat['status'] = 'idle'
    save(consumer_record, chat)
    retired = str(uuid.uuid4())
    observations = harness_data/'agent-observations.json'
    save(observations, {'sessions': [], 'runs': [{
        'id': retired, 'owner': context['user'], 'conversation': None, 'nativeSession': None,
        'state': 'unknown', 'stopConfirmed': False, 'generation': None, 'retired': True,
    }], 'cancellations': [{'key': 'a'*64, 'fingerprint': 'b'*64, 'runId': retired, 'state': 'pending'}]})
    protected = {path: path.read_bytes() for path in (provider_record, raw_journal, consumer_record, retained, native_file, observations)}
    start(codex)
    start(harness)
    link = json.loads(run([*cli, 'open', harness, '--format', 'json']))['url']
    parts = urllib.parse.urlsplit(link)
    origin = urllib.parse.urlunsplit((parts.scheme, parts.netloc, '', '', ''))
    browser = session_browser(context, harness, origin, link)('activation-fixture@example.test', 'Cutover operator')
    assert browser.harness('/sessions')['sessions'] == [] and admitted() == []
    browser.harness('/sessions/'+old_chat, expected=404)

    def authorized_connection():
        return next((row for row in browser.harness('/connections')['connections'] if row['name'] == account['name'] and row['available']), None)
    binding = wait(authorized_connection, 60)
    assert binding['provider']['appId'] == codex
    fresh = browser.harness('/sessions', {'title': 'Fresh v2', 'connectionId': binding['id']})
    route = '/sessions/'+fresh['id']
    send = {'text': 'Fresh v2 message', 'clientRequestId': str(uuid.uuid4()), 'selectionRevision': fresh.get('selectionRevision', 0)}
    browser.harness(route+'/messages', send, expected=202)

    def finished():
        state = (browser.harness(route).get('providerExecution') or {}).get('run') or {}
        return state if state.get('stopConfirmed') and state.get('state') == 'succeeded' else None
    snapshot = wait(finished, 90)
    run_id = snapshot['ref']['id']
    scope = provider_data/'native-processes'/run_id/snapshot['generation']
    def spawn_manifest():
        result = json.loads((scope/'manifest.json').read_text())
        assert result['runId'] == run_id and result['generation'] == snapshot['generation'] and result['spawns']
        return result['producerNonce'], result['spawns']
    original_spawns = spawn_manifest()
    assert admitted() == [(run_id,)] and run_id != old_run
    for app in (harness, codex):
        run([*cli, 'stop', app])
    start(codex)
    start(harness)
    assert wait(authorized_connection, 60)['id'] == binding['id']
    assert wait(finished, 30)['ref']['id'] == run_id
    browser.harness(route+'/messages', send, expected=(200, 202))
    assert admitted() == [(run_id,)] and {row['id'] for row in browser.harness('/sessions')['sessions']} == {fresh['id']}
    assert spawn_manifest() == original_spawns
    assert all(path.read_bytes() == content for path, content in protected.items())
    say('PASS: packaged Docker Harness and local Codex refused an active v1 inventory. After physical writer exit, v2 started empty, preserved the account and files, and admitted one native run across both restarts and replay.')

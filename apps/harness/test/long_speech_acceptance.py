"""Opt-in real speech acceptance inside the existing parent-managed Harness child.

Uses explicitly selected synthetic audio, disposable users/data and the provider's own verified
model download. The cancellation scenario requires a single-slot provider returning speech_busy
and empty text for silence. This module does not launch a Core, seed identity, or use an ordinary installation.
"""
import array
import io
import json
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave


def repeated_wave(source, seconds=600):
    with wave.open(str(source), 'rb') as recording:
        assert recording.getnchannels() == 1 and recording.getsampwidth() == 2 and recording.getframerate() == 16000
        pcm = recording.readframes(recording.getnframes())
    assert pcm
    count = seconds * 16000 * 2
    output = io.BytesIO()
    with wave.open(output, 'wb') as recording:
        recording.setnchannels(1); recording.setsampwidth(2); recording.setframerate(16000)
        recording.writeframes((pcm * ((count + len(pcm) - 1) // len(pcm)))[:count])
    return output.getvalue()


def load_fixture(environment=None):
    """Validate explicit provider/audio inputs before installing any acceptance application."""
    environment = os.environ if environment is None else environment
    selected = []
    for key in ('HOSTY_SPEECH_ACCEPTANCE_MANIFEST', 'HOSTY_SPEECH_ACCEPTANCE_WAV'):
        value = environment.get(key, '')
        path = Path(value)
        if not value or not path.is_absolute() or not path.is_file():
            raise ValueError(key + ' must name an existing absolute fixture file')
        selected.append(path)
    manifest_path, source = selected
    manifest = json.loads(manifest_path.read_text())
    if not manifest.get('id') or 'speech-to-text' not in manifest.get('provides', []):
        raise ValueError('The acceptance manifest must declare a speech-to-text provider')
    runtime = environment.get('HOSTY_SPEECH_ACCEPTANCE_RUNTIME', 'local')
    if not any(item.get('key') == runtime and not item.get('development', False)
               for item in manifest.get('runtimeProfiles', [])):
        raise ValueError('Select a declared production speech runtime for the child')
    # Reject unusable audio before installing or starting the selected application.
    repeated_wave(source, 1)
    return manifest_path, manifest, source, runtime


def native_process_id(health):
    """A Docker daemon PID is not necessarily a PID on the acceptance client's host."""
    services = health.get('services', [])
    if len(services) != 1 or services[0].get('runtimeType') != 'localCommand':
        return None
    return services[0].get('processId')


def process_sample(root_pid):
    """Sample only the selected disposable runtime's descendants from native ps metadata.

    Summed RSS can count shared pages twice and samples can miss peaks. It is not an allocation
    profile or a full-system/native peak. Unsupported platforms return no measurement.
    """
    if root_pid is None or os.name == 'nt' or not shutil.which('ps'):
        return None
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,time='], capture_output=True, text=True, timeout=5)
    if result.returncode:
        return None
    rows = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) != 4:
            continue
        try:
            clock = parts[3].split(':')
            cpu = sum(float(value) * 60 ** index for index, value in enumerate(reversed(clock)))
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]) * 1024, cpu)
        except ValueError:
            continue
    selected = {root_pid}
    while True:
        children = {pid for pid, row in rows.items() if row[0] in selected}
        if children <= selected:
            break
        selected |= children
    observed = [rows[pid] for pid in selected if pid in rows]
    return {'rssBytes':sum(row[1] for row in observed), 'cpuSeconds':sum(row[2] for row in observed),
        'processCount':len(observed)} if observed else None


def check(context, harness_id, app_origin, client, call, link):
    assert context.get('managed') and context.get('child_id'), 'Long speech acceptance requires the existing managed child'
    base, root, workspace = (context[key] for key in ('base', 'root', 'workspace'))
    request, run, say, wait_for = (context[key] for key in ('request', 'run', 'say', 'wait_for'))
    target, manifest, source, runtime = load_fixture()
    speech_id = manifest['id']
    assert speech_id != harness_id, 'Speech acceptance requires an independent provider application'
    fixture = base/'long-speech-fixture'; fixture.mkdir()
    speech_root = root/'apps'/speech_id
    assert not speech_root.exists(), 'Speech acceptance must begin with independent app data and cache'
    # Install exactly the declared external fixture. Source, settings and model selection are
    # owned by that provider; never substitute the Harness repository or ordinary app data.
    run([context['cli'], '--data-root', root, 'apps', 'install', target, '--runtime', runtime, '--no-autostart'])
    run([context['cli'], '--data-root', root, 'apps', 'start', speech_id])
    def healthy():
        state = request('/api/apps/'+speech_id+'/health')
        return state if state['status'] == 'healthy' else None
    health = wait_for(healthy, 180)

    core = context['origin']
    with client.open(core+'/install/permissions/'+urllib.parse.quote(harness_id, safe=''), timeout=30) as response:
        html, confirmation = response.read().decode(), response.url
    assert confirmation.startswith(core+'/install/confirm/'), 'Expected the normal isolated Core permission review'
    nonce = re.search(r'name=nonce value="([^"]+)"', html)
    assert nonce, 'Permission review did not include its nonce'
    context['diagnostic_secrets'].add(nonce.group(1))
    form = urllib.parse.urlencode([('nonce', nonce.group(1)), ('decision', 'approve'),
        ('optionalPermission', 'providers.speech-to-text')]).encode()
    with client.open(urllib.request.Request(confirmation, data=form,
        headers={'Content-Type':'application/x-www-form-urlencoded', 'Origin':core}), timeout=60) as response:
        response.read()
    def permission_ready():
        installed = next(item for item in request('/api/apps')['apps'] if item['id'] == harness_id)
        return set(installed['grantedCorePermissions']) & set(installed['optionalCorePermissions']) == {'providers.speech-to-text'}
    wait_for(permission_ready, 30)
    roster = call(app_origin, '/api/speech/providers')
    assert roster['granted']
    provider = next(item for item in roster['providers'] if item['appId'] == speech_id and item['available'])
    query = urllib.parse.urlencode({'appId':provider['appId'], 'key':provider['key']})
    capabilities_route = '/api/speech/capabilities?'+query
    def capabilities_ready():
        value = call(app_origin, capabilities_route)
        return value if value.get('ready') else None
    caps = wait_for(capabilities_ready, 900)
    assert caps['maxDurationSeconds'] >= 600 and caps['maxBytes'] >= 19_200_044
    assert caps['version'] == 1 and 'audio/wav' in caps['mediaTypes']
    say('PASS: independent child speech provider, normal Core review grants only optional speech, real authenticated capabilities support 600 seconds')
    payload = repeated_wave(source)
    assert len(payload) == 19_200_044
    route = '/api/speech/transcriptions?'+query
    def transcribe(data):
        with client.open(urllib.request.Request(app_origin+route, data=data,
            headers={'Content-Type':'audio/wav', 'Origin':app_origin}), timeout=930) as response:
            return json.load(response)
    # Native metrics use observed service state, without an application-internal receipt path.
    # Multiple services or container-only processes have no single native root to sample.
    root_pid = native_process_id(health)
    before = process_sample(root_pid)
    samples, stop = [], threading.Event()
    def sample():
        while not stop.is_set():
            value = process_sample(root_pid)
            if value:
                samples.append(value)
            stop.wait(.1)
    observer = threading.Thread(target=sample, daemon=True); observer.start()
    began = time.monotonic()
    try:
        result = transcribe(payload)
    finally:
        elapsed = time.monotonic()-began
        stop.set(); observer.join(timeout=6)
    assert 'привет' in result['text'].lower(), 'Real recognition did not recognize the synthetic Russian fixture'
    after = process_sample(root_pid)
    memory = {'sampledPeakSummedRssBytes':max((value['rssBytes'] for value in samples), default=None),
        'beforeSummedRssBytes':before['rssBytes'] if before else None,
        'afterSummedRssBytes':after['rssBytes'] if after else None,
        'sampleCount':len(samples), 'nominalIntervalMs':100,
        'cpuSecondsDelta':round(after['cpuSeconds']-before['cpuSeconds'], 3) if before and after and after['cpuSeconds'] >= before['cpuSeconds'] else None,
        'limits':'Sampled runtime process-tree RSS can double-count shared pages and miss short peaks; CPU delta is process-tree accounting, not complete native allocation or system peak.'}
    say('LONG_SPEECH_MEASUREMENT: '+json.dumps({'platform':platform.platform(), 'architecture':platform.machine(),
        'provider':speech_id, 'backend':caps.get('backend'), 'seconds':600, 'bytes':len(payload), 'httpWallSeconds':round(elapsed, 3),
        'recognizedCharacters':len(result['text']), 'processMetrics':memory}))
    # Exercise early Content-Length admission without racing a 19 MB upload against the
    # server's correct refusal/connection close. Streamed overflow has separate unit coverage.
    try:
        with client.open(urllib.request.Request(app_origin+route, data=b'', headers={
            'Content-Type':'audio/wav', 'Origin':app_origin, 'Content-Length':str(len(payload)+2),
        }), timeout=60) as response:
            response.read()
        raise AssertionError('Harness accepted Content-Length beyond its canonical 600-second WAV budget')
    except urllib.error.HTTPError as error:
        assert error.code == 413 and json.load(error)['code'] == 'speech_audio_too_large'

    microphone = fixture/'controlled-microphone.wav'
    with wave.open(str(source), 'rb') as recording:
        pcm = array.array('h', recording.readframes(recording.getnframes()))
    # Chromium's fake device reads a normal 48 kHz WAV. Repeating each PCM sample three times
    # preserves this deterministic 16 kHz fixture's duration without another dependency.
    with wave.open(str(microphone), 'wb') as recording:
        recording.setnchannels(1); recording.setsampwidth(2); recording.setframerate(48000)
        recording.writeframes(array.array('h', (value for value in pcm for _ in range(3))).tobytes())
    result = subprocess.run(['node', str(workspace/'apps/harness/test/long-speech-acceptance-browser.mjs')],
        input=json.dumps({'core':(context.get('child', {}).get('previewUrl') or core).rstrip('/'), 'harness':app_origin, 'appId':harness_id,
            'email':'activation-fixture@example.test', 'password':context['password'], 'link':link,
            'microphoneFile':str(microphone), 'russianFile':str(source), 'speechQuery':query}),
        text=True, cwd=workspace)
    assert result.returncode == 0, 'Long speech browser acceptance failed'
    assert not list((speech_root/'data').rglob('*.wav')), 'Provider persisted transient audio'
    run([context['cli'], '--data-root', root, 'apps', 'stop', speech_id])
    say('PASS: maximum Russian WAV crossed authenticated Harness→provider HTTP; overflow rejected, browser draft-only insertion and HTTP cancellation verified; parent owns child Finish')

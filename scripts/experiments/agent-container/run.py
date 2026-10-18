#!/usr/bin/env python3
"""Bounded standalone Codex/Docker experiment; never imported by Hosty.

Requires a prepared /data repository and linked /workspace, as documented in the
dated experiment report. No Core or production app credentials are supplied.
"""
import argparse
import json
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--auth-file', type=Path, required=True)
parser.add_argument('--image', default='hosty-agent-container-experiment:20261013')
parser.add_argument('--starts', type=int, default=30)
parser.add_argument('--idle-seconds', type=int, default=60)
args = parser.parse_args()
root = args.root.resolve()
evidence = root / 'evidence'
if not (root / 'worktree' / '.git').is_file():
    raise SystemExit('A prepared linked worktree is required.')
if (evidence / 'results.json').exists():
    raise SystemExit('Use a fresh evidence directory; results must not be overwritten.')
name = 'hosty-agent-experiment-' + uuid.uuid4().hex[:12]
results = {'container': name, 'timings': [], 'checks': {}, 'limits': {'cpus': 2, 'memory_bytes': 2147483648, 'pids': 256}}
started = time.monotonic()
phase = 'setup'
created = False
stats = None
rpc = None
secrets = []
auth_copy = root / 'data' / 'codex' / 'auth.json'


def scrub(value):
    text = json.dumps(value) if not isinstance(value, str) else value
    for secret in secrets:
        text = text.replace(secret, '[REDACTED]')
    return text


def save(file, value):
    (evidence / file).write_text(scrub(json.dumps(value, indent=2)) + '\n')


def log(value):
    print(scrub(value), flush=True)


def docker(*argv, check=True, timeout=45):
    process = subprocess.run(['docker', *argv], capture_output=True, text=True, timeout=timeout)
    if check and process.returncode:
        raise RuntimeError(scrub({'docker_command': argv[:2], 'code': process.returncode, 'stderr': process.stderr[-1500:]}))
    return process


class Rpc:
    def __init__(self):
        self.events = queue.Queue()
        self.replies = {}
        self.lock = threading.Lock()
        self.sequence = 0
        self.first_tool = None
        self.first_event = None
        self.proc = subprocess.Popen(['docker', 'start', '-ai', name], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.drain_errors, daemon=True).start()

    def drain_errors(self):
        # Credentials can occur in native diagnostics; sanitize before persistence.
        with (evidence / 'app-server.stderr.log').open('a') as stream:
            for line in self.proc.stderr:
                stream.write(scrub(line))

    def read(self):
        with (evidence / 'events.jsonl').open('a') as stream:
            for line in self.proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if 'id' in message and 'method' not in message:
                    with self.lock:
                        target = self.replies.get(message['id'])
                    if target:
                        target.put(message)
                else:
                    method = message.get('method', '')
                    params = message.get('params', {})
                    item = params.get('item', {})
                    if self.first_event is None:
                        self.first_event = time.monotonic()
                    if method == 'item/started' and item.get('type') in ('commandExecution', 'fileChange') and self.first_tool is None:
                        self.first_tool = time.monotonic()
                    if method in ('item/started', 'item/completed', 'turn/completed', 'error'):
                        if item.get('type') != 'reasoning':
                            stream.write(scrub({'elapsed': time.monotonic() - started, 'phase': phase, 'event': message}) + '\n')
                            stream.flush()
                    self.events.put(message)
                    if 'id' in message and method:
                        self.send({'id': message['id'], 'error': {'code': -32601, 'message': 'Client-side actions are unavailable in this Docker experiment.'}})

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + '\n')
        self.proc.stdin.flush()

    def request(self, method, params, timeout=45):
        self.sequence += 1
        request_id = self.sequence
        target = queue.Queue()
        with self.lock:
            self.replies[request_id] = target
        self.send({'id': request_id, 'method': method, 'params': params})
        try:
            response = target.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError('RPC timeout: ' + method) from None
        finally:
            with self.lock:
                self.replies.pop(request_id, None)
        if 'error' in response:
            raise RuntimeError(scrub(response['error']))
        return response.get('result')

    def initialize(self):
        response = self.request('initialize', {'clientInfo': {'name': 'hosty-container-experiment', 'version': '1'}, 'capabilities': {}})
        self.send({'method': 'initialized', 'params': {}})
        return response

    def turn(self, thread_id, prompt):
        while not self.events.empty():
            self.events.get_nowait()
        self.first_tool = None
        begin = time.monotonic()
        response = self.request('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': prompt}],
            'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'dangerFullAccess'}})
        turn_id = response['turn']['id']
        end = begin + 180
        while time.monotonic() < end:
            try:
                message = self.events.get(timeout=1)
            except queue.Empty:
                continue
            if message.get('method') == 'turn/completed' and message.get('params', {}).get('turn', {}).get('id') == turn_id:
                return {'seconds': time.monotonic() - begin, 'first_tool_seconds': self.first_tool - begin if self.first_tool else None,
                        'status': message['params']['turn']['status'], 'error': message['params']['turn'].get('error')}
        self.request('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id})
        raise RuntimeError('Real turn exceeded the 180-second experiment limit.')

    def stop(self):
        docker('stop', '--time', '3', name)
        self.proc.wait(timeout=10)


def sample_stats():
    with (evidence / 'stats.jsonl').open('w') as stream:
        for line in stats.stdout:
            try:
                value = json.loads(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', line).strip())
            except ValueError:
                continue
            stream.write(json.dumps({'elapsed': time.monotonic() - started, 'phase': phase, **value}) + '\n')
            stream.flush()


def pause(seconds):
    # Only the child experiment sleeps. The parent Codex turn remains available for updates.
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        time.sleep(min(1, end - time.monotonic()))


try:
    credentials = json.loads(args.auth_file.read_text())
    for value in credentials.get('tokens', {}).values():
        if isinstance(value, str) and len(value) > 15:
            secrets.append(value)
    if credentials.get('auth_mode') != 'chatgpt' or credentials.get('OPENAI_API_KEY'):
        raise RuntimeError('This experiment requires an existing ChatGPT login, not an API key.')
    shutil.copyfile(args.auth_file, auth_copy)
    auth_copy.chmod(0o600)
    args.auth_file = None  # The source remains untouched; never copy auth refresh state back.
    results['auth'] = 'Temporary isolated copy of existing ChatGPT auth; never included in evidence.'
    results['image'] = json.loads(docker('image', 'inspect', args.image).stdout)[0]['Id']
    results['engine'] = json.loads(docker('version', '--format', '{{json .Server}}').stdout)
    results['docker_capacity'] = json.loads(docker('info', '--format', '{"cpus":{{.NCPU}},"memory_bytes":{{.MemTotal}}}').stdout)
    results['other_running_containers'] = len(docker('ps', '-q').stdout.splitlines())
    create_begin = time.monotonic()
    docker('create', '--name', name, '--label', 'hosty.experiment=agent-container-20261013',
           '--init', '-i', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
           '--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--user=1000:1000',
           '--mount=type=bind,src=' + str(root / 'data') + ',dst=/data',
           '--mount=type=bind,src=' + str(root / 'worktree') + ',dst=/workspace',
           '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m', '--env=HOME=/data/home',
           '--env=CODEX_HOME=/data/codex', args.image)
    created = True
    results['create_seconds'] = time.monotonic() - create_begin
    info = json.loads(docker('inspect', name).stdout)[0]
    results['mounts'] = [{k: mount.get(k) for k in ['Type', 'Source', 'Destination', 'RW']} for mount in info['Mounts']]
    results['security'] = {k: info['HostConfig'].get(k) for k in ['Privileged', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'NetworkMode', 'PortBindings', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit']}
    results['security']['User'] = info['Config']['User']
    results['checks']['exact_mounts'] = sorted(x['Destination'] for x in results['mounts']) == ['/data', '/workspace']
    save('results.json', results)
    for index in range(args.starts):
        phase = 'startup'
        before = time.monotonic()
        rpc = Rpc()
        rpc.initialize()
        init_at = time.monotonic()
        thread = rpc.request('thread/start', {'cwd': '/workspace/__agent_fixture__', 'sandbox': 'danger-full-access', 'approvalPolicy': 'never'})
        ready_at = time.monotonic()
        record = {'index': index + 1, 'initialize_seconds': init_at - before, 'thread_ready_seconds': ready_at - before}
        results['timings'].append(record)
        if index == 0 or (index + 1) % 5 == 0:
            log({'startup_sample': record})
        save('results.json', results)
        if index < args.starts - 1:
            rpc.stop()
            rpc = None
    results['thread_id'] = thread['thread']['id']
    results['model'] = thread.get('model')
    stats = subprocess.Popen(['docker', 'stats', '--format', '{{json .}}', name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    threading.Thread(target=sample_stats, daemon=True).start()
    phase = 'idle_before'
    log({'phase': phase, 'seconds': args.idle_seconds, 'model': results['model']})
    pause(args.idle_seconds)
    phase = 'filesystem_probes'
    probe = docker('exec', name, 'node', '/workspace/__agent_fixture__/boundary-probe.cjs')
    results['filesystem_probe'] = json.loads(probe.stdout)
    results['checks']['filesystem_boundary'] = results['filesystem_probe']['passed']
    baseline = docker('exec', '--workdir', '/workspace/__agent_fixture__', name, 'node', '--test', 'cart.test.cjs', check=False)
    results['checks']['baseline_tests_fail'] = baseline.returncode != 0
    (evidence / 'baseline-tests.txt').write_text(baseline.stdout)
    phase = 'real_edit_test'
    prompt = ('Work only in /workspace/__agent_fixture__. This is a disposable Docker experiment. '
              'Fix totalCents in cart.cjs so quantities are multiplied by unitCents and an empty cart returns zero. '
              'Add a regression test showing the input array and records remain unchanged. Run node --test cart.test.cjs and report results. '
              'Also write /data/agent-note.txt with the sentence: First Docker turn completed. '
              'Do not read credentials, change the boundary probe, commit, use the network or modify anything outside these fixture files and the note.')
    results['first_turn'] = rpc.turn(results['thread_id'], prompt)
    results['checks']['first_turn_completed'] = results['first_turn']['status'] == 'completed'
    log({'phase': phase, 'turn': results['first_turn']})
    verify = docker('exec', '--workdir', '/workspace/__agent_fixture__', name, 'node', '--test', 'cart.test.cjs', check=False)
    (evidence / 'after-agent-tests.txt').write_text(verify.stdout)
    results['checks']['agent_tests_pass'] = verify.returncode == 0
    results['checks']['agent_data_write'] = (root / 'data' / 'agent-note.txt').read_text().strip() == 'First Docker turn completed.'
    phase = 'idle_after'
    pause(args.idle_seconds)
    phase = 'restart_resume'
    rpc.stop()
    rpc = None
    before = time.monotonic()
    rpc = Rpc()
    rpc.initialize()
    resumed = rpc.request('thread/resume', {'threadId': results['thread_id'], 'cwd': '/workspace/__agent_fixture__', 'sandbox': 'danger-full-access', 'approvalPolicy': 'never'})
    results['resume_seconds'] = time.monotonic() - before
    results['checks']['same_thread_resumed'] = resumed['thread']['id'] == results['thread_id']
    phase = 'resumed_turn'
    results['second_turn'] = rpc.turn(results['thread_id'],
        'Continue the previous Docker experiment. Read /data/agent-note.txt, run node --test cart.test.cjs again, '
        'and append the line: Resumed Docker turn completed. to that note. Confirm the earlier code fix persists. '
        'Do not modify code or tests, access credentials, use the network or create commits.')
    log({'phase': phase, 'turn': results['second_turn']})
    results['checks']['second_turn_completed'] = results['second_turn']['status'] == 'completed'
    results['checks']['resumed_data_persists'] = (root / 'data' / 'agent-note.txt').read_text().strip().splitlines() == ['First Docker turn completed.', 'Resumed Docker turn completed.']
    phase = 'final_idle'
    pause(15)
    cgroups = docker('exec', name, 'sh', '-c', 'for f in memory.current memory.peak memory.events cpu.stat pids.current; do echo "$f"; cat /sys/fs/cgroup/$f; done')
    (evidence / 'cgroups.txt').write_text(cgroups.stdout)
    status = docker('exec', name, 'git', '-C', '/workspace', 'status', '--short')
    (evidence / 'worktree-status.txt').write_text(status.stdout)
    # A detached child can survive a turn; container stop must stop it before cleanup.
    phase = 'shutdown_probe'
    docker('exec', '-d', name, 'sh', '-c', 'while true; do printf x >> /data/heartbeat; sleep 0.2; done')
    pause(2)
    rpc.stop()
    rpc = None
    stopped_size = (root / 'data' / 'heartbeat').stat().st_size
    pause(2)
    results['checks']['container_stop_quiescent'] = stopped_size > 0 and (root / 'data' / 'heartbeat').stat().st_size == stopped_size
    results['state_after_stop'] = json.loads(docker('inspect', '--format', '{{json .State}}', name).stdout)
    save('results.json', results)
except BaseException as error:
    results['error'] = scrub(str(error))
    log({'experiment_error': results['error']})
finally:
    if created:
        # Only this script's randomly named, labelled container is eligible for cleanup.
        info = docker('inspect', name, check=False)
        if info.returncode == 0:
            record = json.loads(info.stdout)[0]
            if record['Config']['Labels'].get('hosty.experiment') == 'agent-container-20261013':
                docker('rm', '-f', name, check=False)
    if stats:
        stats.terminate()
        stats.wait(timeout=10)
    if rpc:
        try:
            rpc.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rpc.proc.terminate()
    if auth_copy.exists():
        auth_copy.unlink()
    if (evidence / 'stats.jsonl').exists():
        observations = [json.loads(line) for line in (evidence / 'stats.jsonl').read_text().splitlines()]
        results['stats_samples'] = len(observations)
        results['checks']['resource_samples_cover_work'] = all(
            any(sample['phase'] == wanted for sample in observations)
            for wanted in ['idle_before', 'real_edit_test', 'idle_after', 'resumed_turn'])
    results['credential_copy_removed'] = not auth_copy.exists()
    results['elapsed_seconds'] = time.monotonic() - started
    save('results.json', results)
    log({'finished': not results.get('error') and all(results['checks'].values()), 'checks': results['checks'], 'credential_copy_removed': results['credential_copy_removed']})
if results.get('error') or not all(results['checks'].values()):
    raise SystemExit(1)

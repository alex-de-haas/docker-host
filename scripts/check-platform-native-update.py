#!/usr/bin/env python3
"""Exercise real CLI/Core replacement in an isolated native CI fixture.

The target Core is the already checked NativeAOT output. A lower-version managed
apphost pair supplies distinct previous bytes without another native Core build.
All executables, users, journals and HOME are private to a temporary directory.
This verifies native lifecycle/replacement, not Docker app or browser integration.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core', required=True, type=Path)
    parser.add_argument('--rid', required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    target_core = args.core.resolve()
    assert target_core.is_file(), 'The checked native Core is required'
    base = Path(tempfile.mkdtemp(prefix='hosty-pair-'))
    root = base / 'instance'
    cli_dir = base / 'previous-cli'
    core_dir = root / 'core' / 'bin'
    target_cli_dir = base / 'target-cli'
    suffix = '.exe' if os.name == 'nt' else ''
    cli = cli_dir / ('hosty' + suffix)
    core = core_dir / ('hosty-core' + suffix)
    allowed = {'path', 'tmpdir', 'tmp', 'temp', 'dotnet_root', 'lang', 'systemroot',
               'comspec', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)',
               'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
               'commonprogramw6432', 'programdata', 'systemdrive', 'windir', 'allusersprofile'}
    env = {k: v for k, v in os.environ.items() if k.lower() in allowed}
    home = base / 'home'
    home.mkdir()
    env.update(HOME=str(home), USERPROFILE=str(home), GIT_CONFIG_GLOBAL=os.devnull,
               GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
    process = None
    log = None
    stopped = False
    succeeded = False

    def run(command, expected=0, timeout=300, build=False):
        result = subprocess.run([str(x) for x in command], cwd=repository,
                                env=None if build else env, capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=timeout)
        if result.returncode != expected:
            # Build/CLI output only; never dump identity stores or control headers.
            raise RuntimeError(f'{command[0]} exited {result.returncode}, expected {expected}:\n'
                               + result.stdout[-6000:] + result.stderr[-6000:])
        return result.stdout

    def command(*arguments, **kw):
        return run([cli, '--data-root', root, *arguments], **kw)

    def publish(role, destination, previous=False):
        project = repository / 'apps' / role / 'src' / f'Haas.Hosty.{role.title()}' / f'Haas.Hosty.{role.title()}.csproj'
        options = ['dotnet', 'publish', project, '-c', 'Release', '-r', args.rid,
                   '--self-contained', 'true', '--output', destination,
                   '--artifacts-path', base / ('build-previous-' + role if previous else 'build-target-' + role), '--nologo']
        if previous:
            options += ['-p:PublishAot=false', '-p:PublishTrimmed=false', '-p:EnableRequestDelegateGenerator=true', '-p:Version=0.0.0']
        print(f'Building {role} {"previous apphost" if previous else "native target"}', flush=True)
        run(options, build=True, timeout=600)

    jar = http.cookiejar.CookieJar()
    browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def control(path, body=None):
        discovery = json.loads((root / 'core/run/control.json').read_text())
        request = urllib.request.Request(discovery['controlBaseUrl'].rstrip('/') + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={**discovery['requiredHeaders'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def wait_ready():
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                value = control('/core/status')
                if value['status'] == 'running':
                    return value
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise RuntimeError('Fixture Core did not become ready')

    try:
        print(f'Preparing isolated {args.rid} replacement fixtures', flush=True)
        publish('cli', target_cli_dir)
        publish('cli', cli_dir, previous=True)
        publish('core', core_dir, previous=True)
        target_cli = target_cli_dir / ('hosty' + suffix)
        version = run([target_cli, '--version']).strip()
        assert version != '0.0.0', 'Target must be newer than the fixture'
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        distribution = root / 'core/distribution-apps.json'
        distribution.write_text(json.dumps({'schemaVersion': 'distribution-apps.0.1', 'apps': []}))
        env.update(HOSTY_DATA_ROOT=str(root), HOSTY_CORE_URL=origin, HOSTY_CORE_PORT=str(port),
                   HOSTY_DISTRIBUTION_APPS_PATH=str(distribution), HOSTY_CORE_LAUNCH_MODE='release',
                   HOSTY_CLI_PATH=str(cli))
        log = (base / 'initial-core.log').open('w')
        process = subprocess.Popen([str(core)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        # Reap the directly launched fixture promptly; a zombie PID must not look like
        # a Core that refused the CLI stop request.
        threading.Thread(target=process.wait, daemon=True).start()
        before = wait_ready()
        token = control('/auth/setup-token', {})['token']
        password = uuid.uuid4().hex + 'aA1!'
        account = {'setupToken': token, 'email': 'pair-fixture@example.test',
                   'displayName': 'Native pair fixture', 'password': password}
        with browser.open(urllib.request.Request(origin + '/api/auth/bootstrap',
                data=json.dumps(account).encode(), headers={'Content-Type': 'application/json', 'Origin': origin}), timeout=20) as response:
            json.load(response)
        jar.clear()
        form = urllib.parse.urlencode({'email': account['email'], 'password': password,
                                      'returnTo': '/api/auth/session'}).encode()
        with browser.open(urllib.request.Request(origin + '/login', data=form,
                headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': origin}), timeout=20) as response:
            response.read()
        with browser.open(origin + '/api/auth/session', timeout=20) as response:
            assert json.load(response)['authenticated'], 'Ordinary password login failed'
        assets = base / 'assets'
        assets.mkdir()
        records = []
        for role, target in [('cli', target_cli), ('core', target_core)]:
            path = assets / target.name
            shutil.copy2(target, path)
            records.append({'role': role, 'rid': args.rid, 'fileName': path.name,
                            'url': str(path), 'size': path.stat().st_size, 'sha256': digest(path),
                            'inputFingerprint': digest(path), 'provenance': 'local-native-acceptance'})
        release = {'schemaVersion': 'hosty-platform-release.0.1', 'releaseId': 'a' * 64,
                   'version': version, 'sourceCommit': run(['git', 'rev-parse', 'HEAD']).strip(), 'assets': records}
        descriptor = base / 'release.json'
        descriptor.write_text(json.dumps(release))
        index = base / 'feeds.json'
        feeds = {'schemaVersion': 'hosty-platform-feeds.0.1', 'feeds': [
            {'id': name, 'default': name == 'Candidate-QA', 'releaseRef': str(descriptor),
             'releaseSha256': digest(descriptor)} for name in ['Candidate-QA', 'Reviewed-QA']]}
        index.write_text(json.dumps(feeds))
        previous = {str(path): digest(path) for path in [cli, core]}
        assert previous[str(cli)] != records[0]['sha256'] and previous[str(core)] != records[1]['sha256']
        (assets / target_core.name).write_bytes(b'corrupt counterpart')
        command('update', '--feed', 'Candidate-QA', '--index', index, expected=1)
        journal = root / 'core/platform-update.json'
        pending = json.loads(journal.read_text())
        assert pending['phase'] == 'preparing'
        assert control('/core/status')['launch'] == before['launch']
        assert all(digest(path) == checksum for path, checksum in previous.items())
        print('PASS: corrupt counterpart preserves both executables and the running Core', flush=True)
        index.write_text('{}')
        descriptor.write_text('{}')
        shutil.copy2(target_core, assets / target_core.name)
        command('update')
        completed = json.loads(journal.read_text())
        assert completed['id'] == pending['id'] and completed['phase'] == 'completed'
        assert completed['readyCore']['version'] == version
        assert completed['readyCore']['launch']['processId'] != before['launch']['processId']
        assert completed['readyCore']['listenUrl'] == before['listenUrl']
        assert digest(cli) == records[0]['sha256'] and digest(core) == records[1]['sha256']
        assert run([cli, '--version']).strip() == version
        assert json.loads((root / 'core/update-source.json').read_text())['feedId'] == 'Candidate-QA'
        process.wait(timeout=20)
        print('PASS: frozen no-argument recovery replaces the distinct pair and verifies native readiness', flush=True)
        index.write_text(json.dumps(feeds))
        descriptor.write_text(json.dumps(release))
        ready = control('/core/status')['launch']
        command('core', 'feed', 'Reviewed-QA')
        assert control('/core/status')['launch'] == ready
        command('core', 'stop', '--keep-apps')
        stopped = True
        command('update')
        assert json.loads(journal.read_text())['previousCore'] is None
        assert not (root / 'core/run/control.json').exists()
        assert json.loads((root / 'core/update-source.json').read_text())['feedId'] == 'Reviewed-QA'
        print('PASS: feed selection preserves the process; no-argument update keeps a stopped Core stopped', flush=True)
        succeeded = True
    finally:
        if process is not None and not stopped:
            try:
                control('/core/stop', {})
                deadline = time.monotonic() + 30
                while (root / 'core/run/control.json').exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                stopped = not (root / 'core/run/control.json').exists()
            except (OSError, ValueError):
                stopped = process.poll() is not None and not (root / 'core/run/control.json').exists()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=20)
        if log is not None:
            log.close()
        if succeeded and stopped:
            for attempt in range(10):
                try:
                    shutil.rmtree(base)
                    break
                except PermissionError:
                    if os.name != 'nt' or attempt == 9:
                        raise
                    time.sleep(.2)
            print('PASS: native fixture processes exited and temporary data was removed', flush=True)
        else:
            print(f'Native acceptance failed; private diagnostics retained at {base}', flush=True)


if __name__ == '__main__':
    main()

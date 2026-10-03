#!/usr/bin/env python3
"""Focused real-Docker smoke check; starts only its own temporary Core instance."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('core', help='Built Core DLL or native executable')
parser.add_argument('--image', default='node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6')
args = parser.parse_args()
core = str(Path(args.core).resolve())
name = 'hosty-transport-test-' + uuid.uuid4().hex[:12]
root = Path(tempfile.mkdtemp(prefix=name))
(root / 'distribution.json').write_text(json.dumps({'schemaVersion': 'distribution-apps.0.1', 'apps': []}))
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
env = dict(os.environ, HOSTY_CORE_URL=f'http://localhost:{port}',
           HOSTY_DISTRIBUTION_APPS_PATH=str(root / 'distribution.json'))
env.pop('HOSTY_CORE_PUBLIC_ORIGIN', None)
command = (['dotnet', core] if core.endswith('.dll') else [core]) + ['--data-root', str(root), '--port', str(port)]
network_created = False
process = None
try:
    with (root / 'core.log').open('w') as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError('Core exited during startup')
        try:
            with opener.open(f'http://127.0.0.1:{port}/healthz', timeout=1) as response:
                if response.status == 200:
                    break
        except OSError:
            pass
        time.sleep(.1)
    else:
        raise RuntimeError('Core did not become ready')
    subprocess.run(['docker', 'network', 'create', name], check=True, capture_output=True, timeout=30)
    network_created = True
    script = '''
const base = process.env.CORE;
for (const [path, expected] of [['/healthz', [200]], ['/api/apps', [401,403]], ['/control/v1/core/status', [401,404]]]) {
  const response = await fetch(base + path, {signal: AbortSignal.timeout(5000)});
  if (!expected.includes(response.status)) throw new Error(path + ': HTTP ' + response.status);
  console.log(path + ': ' + response.status);
}
'''
    for network in ['bridge', name]:
        subprocess.run(['docker', 'run', '--rm', '--name', name + '-probe', '--network', network,
                        '--add-host', 'host.docker.internal:host-gateway', '-e', f'CORE=http://host.docker.internal:{port}',
                        args.image, 'node', '--input-type=module', '-e', script], check=True, timeout=180)
    print('PASS: Core health and authorization from default and per-app Docker networks.')
finally:
    subprocess.run(['docker', 'rm', '-f', name + '-probe'], capture_output=True, timeout=30)
    if network_created:
        subprocess.run(['docker', 'network', 'rm', name], capture_output=True, timeout=30)
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    print(f'Core log retained at {root / "core.log"}')

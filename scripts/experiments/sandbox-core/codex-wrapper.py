#!/usr/bin/env python3
"""Transport the unchanged Harness Codex adapter into one bounded Docker worker."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
arguments = sys.argv[2:]
image = json.loads((root / 'coordinator/worker-image.json').read_text())['image']
if not image.startswith('sha256:') or len(image) != 71:
    raise SystemExit('Pin the reviewed worker image by its immutable local digest.')
data = str(root / 'agent-data')
if arguments in [['--version'], ['login', 'status']]:
    command = ['docker', 'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--user=1000:1000',
        '--mount=type=bind,src='+data+',dst='+data, '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m', '--env=HOME='+data+'/home', '--env=CODEX_HOME='+data+'/codex', image, 'codex', *arguments]
else:
    if not arguments or arguments[0] != 'app-server':
        raise SystemExit('This experiment permits only app-server and read-only login/version probes.')
    config = json.loads((root / 'coordinator/runtime.json').read_text())
    allowed_cwd = Path.cwd().resolve().is_relative_to(root / 'agent-data')
    if not allowed_cwd:
        raise SystemExit('Harness cwd is outside the experiment agent data.')
    for index, value in enumerate(arguments):
        if value.startswith('mcp_servers.hosty-workspaces.url='):
            url = json.loads(value.split('=', 1)[1])
            from urllib.parse import urlsplit
            parsed = urlsplit(url)
            if parsed.hostname != '127.0.0.1' or not parsed.path.startswith('/internal/workspaces/'):
                raise SystemExit('Unexpected workspace MCP target.')
            variable = next(json.loads(v.split('=', 1)[1]) for v in arguments if v.startswith('mcp_servers.hosty-workspaces.bearer_token_env_var='))
            bridge = root / 'coordinator/bridge.json'
            bridge.write_text(json.dumps({'path': parsed.path, 'token': os.environ[variable]}))
            bridge.chmod(0o600)
            arguments[index] = 'mcp_servers.hosty-workspaces.url='+json.dumps('http://host.docker.internal:37092'+parsed.path)
    env_args = [part for key in os.environ if key.startswith('HOSTY_MCP_BEARER_') for part in ['--env', key]]
    command = ['docker', 'exec', '-i', '--workdir', str(Path.cwd()), *env_args, config['container'], 'codex', *arguments]
os.execvp(command[0], command)

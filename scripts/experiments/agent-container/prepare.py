#!/usr/bin/env python3
"""Prepare only new synthetic fixtures; clone existing history without commits."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--image', default='hosty-agent-container-experiment:20261013')
args = parser.parse_args()
root = args.root.resolve()
root.mkdir(mode=0o700, exist_ok=False)
for relative in ['data', 'data/home', 'data/codex', 'worktree', 'evidence', 'outside']:
    (root / relative).mkdir(mode=0o700)
(root / 'outside/canary.txt').write_text('HOSTY_SYNTHETIC_OUTSIDE_CANARY\n')
(root / 'data/codex/config.toml').write_text('cli_auth_credentials_store = "file"\nweb_search = "disabled"\n[analytics]\nenabled = false\n')
subprocess.run(['git', 'clone', '--bare', '--no-local', '--depth=1', args.source.resolve().as_uri(), str(root / 'data/repository.git')], check=True)
setup = (
    'git config --global --add safe.directory /data/repository.git; '
    'git config --global --add safe.directory /workspace; '
    'git --git-dir=/data/repository.git remote remove origin; '
    'git --git-dir=/data/repository.git worktree add --detach --no-checkout /workspace HEAD; '
    'git -C /workspace sparse-checkout init --no-cone; '
    'git -C /workspace sparse-checkout set /__agent_fixture__; '
    'git -C /workspace read-tree -mu HEAD'
)
subprocess.run(['docker', 'run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2', '--user=1000:1000',
    '--mount=type=bind,src=' + str(root / 'data') + ',dst=/data',
    '--mount=type=bind,src=' + str(root / 'worktree') + ',dst=/workspace',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m', '--env=HOME=/data/home', '--env=CODEX_HOME=/data/codex',
    args.image, 'sh', '-ec', setup], check=True)
fixture = root / 'worktree/__agent_fixture__'
fixture.mkdir()
(fixture / 'cart.cjs').write_text('exports.totalCents = lines => lines.reduce((sum, line) => sum + line.unitCents + line.quantity, 0);\n')
(fixture / 'cart.test.cjs').write_text("""const test = require('node:test');
const assert = require('node:assert/strict');
const { totalCents } = require('./cart.cjs');
test('empty cart', () => assert.equal(totalCents([]), 0));
test('quantities multiply unit price', () => assert.equal(totalCents([{unitCents: 125, quantity: 3}, {unitCents: 50, quantity: 2}]), 475));
""")
(fixture / 'outside-link').symlink_to(root / 'outside')
(fixture / 'repo-link').symlink_to(args.source.resolve())
paths = {'host_canary': str(root / 'outside/canary.txt'),
    'symlink_canary': '/workspace/__agent_fixture__/outside-link/canary.txt',
    'host_repository': str(args.source.resolve() / 'AGENTS.md'),
    'symlink_repository': '/workspace/__agent_fixture__/repo-link/AGENTS.md',
    'docker_socket': '/var/run/docker.sock', 'container_root_write': '/root/hosty-probe',
    'system_write': '/usr/local/hosty-probe'}
# The real home is never mounted; the outside canary is sufficient to check that boundary.
probe = r"""const fs = require('fs');
const result = {read: {}, write: {}};
const denied = PATHS;
for (const [label, path] of Object.entries(denied)) {
  try { fs.readFileSync(path); result.read[label] = 'UNEXPECTED_ACCESS'; } catch (e) { result.read[label] = e.code; }
  if (['host_canary','symlink_canary','container_root_write','system_write'].includes(label)) {
    try { fs.writeFileSync(path, 'probe'); result.write[label] = 'UNEXPECTED_ACCESS'; } catch (e) { result.write[label] = e.code; }
  }
}
for(const [label, path] of Object.entries({data:'/data/probe',worktree:'/workspace/__agent_fixture__/probe'})) {
 fs.writeFileSync(path,'allowed'); result.write[label] = fs.readFileSync(path,'utf8') === 'allowed' ? 'allowed' : 'failed'; fs.unlinkSync(path);
}
const proc = fs.readFileSync('/proc/self/status','utf8');
result.uid = process.getuid();
result.capEff = proc.match(/^CapEff:\s*(.+)$/m)[1];
result.noNewPrivs = proc.match(/^NoNewPrivs:\s*(.+)$/m)[1];
result.passed = Object.values(result.read).every(x=>x !== 'UNEXPECTED_ACCESS') && Object.entries(result.write).every(([k,v])=>['data','worktree'].includes(k) ? v === 'allowed' : v !== 'UNEXPECTED_ACCESS') && result.uid !== 0 && /^0+$/.test(result.capEff) && result.noNewPrivs === '1';
console.log(JSON.stringify(result));
"""
(fixture / 'boundary-probe.cjs').write_text(probe.replace('PATHS', json.dumps(paths)))
print(json.dumps({'prepared': str(root), 'commits_created': 0}))

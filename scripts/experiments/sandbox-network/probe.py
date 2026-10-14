#!/usr/bin/env python3
"""Bounded Docker isolation probe; creates and removes only uniquely labelled resources."""
import http.server
import json
import subprocess
import sys
import threading
import time
import uuid
import urllib.request
from pathlib import Path

run_id = 'hosty-sandbox-probe-' + uuid.uuid4().hex[:12]
image = 'hosty-two-container-dev:20261013'
containers, networks = [], []
results = {'runId': run_id, 'checks': {}}

def docker(*args, check=True):
    p = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=45)
    if check and p.returncode:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p.stdout.strip()

def network(suffix, isolated=False):
    name = run_id + '-' + suffix
    args = ['network', 'create', '--label', 'hosty.sandbox.probe=' + run_id]
    if isolated:
        args += ['--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
                 '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1']
    docker(*args, name)
    networks.append(name)
    return name

def container(suffix, net, code, extra=()):
    name = run_id + '-' + suffix
    containers.append(name)
    docker('run', '-d', '--name', name, '--label', 'hosty.sandbox.probe=' + run_id,
           '--network', net, '--dns', '127.0.0.1', '--user', '1000:1000',
           '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
           '--memory=96m', '--memory-swap=96m', '--cpus=.25', '--pids-limit=32',
           '--log-driver=local', '--log-opt=max-size=1m', '--log-opt=max-file=3',
           *extra, '--entrypoint=node', image, '-e', code)
    return name

def evaluate(name, code):
    return json.loads(docker('exec', name, 'node', '-e', code))

def http_probe(name, url):
    return evaluate(name, "fetch(" + json.dumps(url) + ", {signal:AbortSignal.timeout(1800)})"
                    ".then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))"
                    ".catch(e=>console.log(JSON.stringify({error:e.name})))")

class Canary(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'host-canary')
    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Canary)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    inner = network('app', True)
    sibling = network('sibling', True)
    outer = network('relay')
    canary = container('canary', outer,
        "require('http').createServer((q,s)=>s.end('fixed-core-canary')).listen(18080,'0.0.0.0')")
    app = container('app', inner,
        "require('http').createServer((q,s)=>s.end('preview-canary')).listen(18081,'0.0.0.0')",
        ('--network-alias', 'sandbox-app'))
    other = container('other', sibling,
        "require('http').createServer((q,s)=>s.end('sibling-canary')).listen(18082,'0.0.0.0')")
    relay_code = """
const http=require('http');
http.createServer((q,s)=>{
 const target=q.url==='/core/identity' ? 'http://CANARY:18080/' : q.url==='/preview' ? 'http://sandbox-app:18081/' : null;
 if(!target||q.method!=='GET'){s.writeHead(403);s.end('denied');return;}
 http.get(target,r=>{s.writeHead(r.statusCode);r.pipe(s)}).on('error',()=>{s.writeHead(502);s.end('unreachable')});
}).listen(18083,'0.0.0.0');
""".replace('CANARY', canary)
    relay = container('relay', outer, relay_code,
                      ('--sysctl', 'net.ipv4.ip_forward=0', '-p', '127.0.0.1::18083'))
    docker('network', 'connect', '--alias', 'sandbox-core', inner, relay)
    time.sleep(.5)
    canary_ip = json.loads(docker('inspect', canary))[0]['NetworkSettings']['Networks'][outer]['IPAddress']
    sibling_ip = json.loads(docker('inspect', other))[0]['NetworkSettings']['Networks'][sibling]['IPAddress']
    def expect(key, observed, condition):
        results['checks'][key] = {'passed': bool(condition(observed)), 'observed': observed}
    expect('allowed-fixed-core-route', http_probe(app, 'http://sandbox-core:18083/core/identity'),
           lambda r:r.get('body') == 'fixed-core-canary')
    expect('denied-relay-admin-route', http_probe(app, 'http://sandbox-core:18083/api/admin'), lambda r:r.get('status') == 403)
    binding = docker('port', relay, '18083/tcp')
    with urllib.request.urlopen('http://' + binding + '/preview', timeout=3) as response:
        expect('loopback-preview', response.read().decode(), lambda r:r=='preview-canary')
    for label, url in [('host', f'http://host.docker.internal:{server.server_port}'),
                       ('outer-container', f'http://{canary_ip}:18080'),
                       ('sibling', f'http://{sibling_ip}:18082'),
                       ('internet-ip', 'http://1.1.1.1')]:
        expect('denied-' + label, http_probe(app, url), lambda r:'error' in r)
    dns = evaluate(app, "setTimeout(()=>{console.log(JSON.stringify({error:'timeout'}));process.exit(0)},2500).unref();"
                       "require('dns').promises.lookup('example.com').then(r=>console.log(JSON.stringify(r)))"
                       ".catch(e=>console.log(JSON.stringify({error:e.code})))")
    expect('denied-external-dns', dns, lambda r:'error' in r)
    forwarding = docker('exec', relay, 'cat', '/proc/sys/net/ipv4/ip_forward')
    expect('relay-forwarding-disabled', forwarding, lambda r:r=='0')
    results['network'] = json.loads(docker('network', 'inspect', inner))[0]
    results['passed'] = all(c['passed'] for c in results['checks'].values())
except Exception as e:
    results['error'] = str(e)
    results['passed'] = False
finally:
    cleanup = []
    for name in reversed(containers):
        cleanup.append({'container': name, 'result': docker('rm', '-f', name, check=False)})
    for name in reversed(networks):
        cleanup.append({'network': name, 'result': docker('network', 'rm', name, check=False)})
    server.shutdown()
    results['cleanup'] = cleanup
    Path(sys.argv[1]).write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({k:v for k,v in results.items() if k not in ('network','cleanup')}, indent=2))
sys.exit(0 if results['passed'] else 1)

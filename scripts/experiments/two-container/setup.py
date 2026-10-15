"""Dated two-container fixture: ordinary Core auth and Harness workspace setup."""
import base64
import hashlib
import json
import re
import secrets
import subprocess
import urllib.parse
import urllib.request
import uuid
from api import ROOT, CORE, request, opener, jar

def save(name, value):
    target = ROOT / 'coordinator' / name
    target.write_text(json.dumps(value, indent=2))
    target.chmod(0o600)

token_output = subprocess.check_output(['hosty', '--data-root', str(ROOT/'core-instance'), 'auth', 'setup-token'], text=True)
token = re.search(r'Setup token: (\S+)', token_output).group(1)
account = {'email': 'two-container@example.test', 'password': secrets.token_urlsafe(24)}
save('account.json', account)
request(CORE, '/api/auth/bootstrap', {'setupToken': token, **account, 'displayName': 'Container Experiment'})
# Repeat the normal password login, rather than treating bootstrap as browser proof.
form = urllib.parse.urlencode(account).encode()
with opener.open(urllib.request.Request(CORE+'/login', data=form, headers={'content-type':'application/x-www-form-urlencoded','origin':CORE}), timeout=30) as response:
    response.read()
jar.save(ignore_discard=True, ignore_expires=True)
request(CORE, '/api/auth/csrf')
origin = 'http://127.0.0.1:'+str(json.loads((ROOT/'coordinator/harness.json').read_text())['port'])
verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
code = request(CORE, '/api/auth/apps/authorize', {'appId':'hosty.harness','redirectUri':origin+'/assistant','codeChallenge':challenge,'codeChallengeMethod':'S256'})
request(origin, '/api/auth/app-code', {'code':code['code'], 'codeVerifier':verifier})
connection = request(origin, '/api/connections', {'name':'Container experiment','kind':'codex','auth':'host-login','hostDirectory':str(ROOT/'agent-data/codex')})
session = request(origin, '/api/sessions', {'title':'Separate agent and Demo App containers','appIds':['com.haas.demo-app'],'connectionId':connection['id'],'clientRequestId':str(uuid.uuid4())})
route = '/api/sessions/'+session['id']
request(origin, route+'/autonomy', {'autonomy':'autonomous'}, method='PUT')
save('session.json', {'origin':origin,'session_id':session['id']})
workspace = request(origin, route+'/workspaces', {'action':'prepare','appId':'com.haas.demo-app','requestId':str(uuid.uuid4())})
(ROOT/'evidence/workspace-before.json').write_text(json.dumps(workspace,indent=2))
git_dir = subprocess.check_output(['git','-C',workspace['path'],'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
save('runtime.json', {'workspace':workspace['path'],'workspaceId':workspace['id'],'gitDir':git_dir,'container':'hosty-two-container-agent-20261013'})
print(json.dumps({'sessionId':session['id'],'workspaceId':workspace['id'],'path':workspace['path'],'origin':origin}))

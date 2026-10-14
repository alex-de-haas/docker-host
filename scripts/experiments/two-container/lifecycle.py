"""Verify independent container lifecycles and retain synthetic data/source."""
import hashlib
import json
import subprocess
import time
import urllib.request
from pathlib import Path
from api import ROOT

cfg=json.loads((ROOT/'coordinator/runtime.json').read_text())
e=ROOT/'evidence'
(e/'stop-sampling-main').touch()
(e/'stop-sampling-final').touch()
cli=['hosty','--data-root',str(ROOT/'core-instance'),'apps']
def inspect(name):return json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
def identity(name):
    d=inspect(name)
    return {'id':d['Id'],'running':d['State']['Running'],'startedAt':d['State']['StartedAt'],'pid':d['State']['Pid']}
def get(url):
    with urllib.request.urlopen(url,timeout=3) as r:return r.status,r.read().decode()
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
seed=Path(cfg['appData'])/'agent-seed.json'
result={'agent_before':identity(cfg['container']),'app_before':identity(cfg['appContainer']),'seed_before':digest(seed)}
subprocess.run(cli+['stop','com.haas.demo-app'],check=True,capture_output=True)
result['agent_while_app_stopped']=identity(cfg['container'])
assert result['agent_while_app_stopped']==result['agent_before']
out=subprocess.check_output(['docker','exec',cfg['container'],'node','-e','console.log(require("fs").readFileSync('+json.dumps(cfg['workspace']+'/apps/demo-app/src/components/DemoOverview.tsx')+',"utf8").includes("Sandbox hot reload verified"))'],text=True)
assert out.strip()=='true'
result['agent_command_while_app_stopped']=True
started=time.time()
log=(e/'app-restart.log').open('x')
child=subprocess.Popen(cli+['start','com.haas.demo-app'],stdout=log,stderr=subprocess.STDOUT)
limited=False
ready=None
url='http://127.0.0.1:25292/'
while time.time()-started<90:
    if not limited:
        check=subprocess.run(['docker','inspect','--format','{{.State.Running}}',cfg['appContainer']],capture_output=True,text=True)
        if check.returncode==0 and check.stdout.strip()=='true':
            subprocess.run(['docker','update','--memory=4g','--memory-swap=4g','--cpus=2','--pids-limit=512',cfg['appContainer']],check=True,capture_output=True)
            limited=True
    try:
        status,body=get(url)
        if status==200:
            ready=time.time();break
    except Exception:pass
    time.sleep(.2)
assert ready is not None,'Restart never became HTTP-ready'
code=child.wait(timeout=90);log.close();assert code==0
result.update({'app_restart_http_seconds':ready-started,'app_restart_cli_seconds':time.time()-started,'app_after':identity(cfg['appContainer']),'seed_after':digest(seed),'agent_after_app_restart':identity(cfg['container'])})
assert result['seed_after']==result['seed_before']
assert result['agent_after_app_restart']==result['agent_before']
subprocess.run(['docker','stop','--time','5',cfg['container']],check=True,capture_output=True)
result['agent_stopped']=identity(cfg['container'])
result['app_after_agent_stop']=identity(cfg['appContainer'])
assert result['app_after_agent_stop']==result['app_after']
status,_=get(url);assert status==200
result['app_http_after_agent_stop']=status
assert not result['agent_stopped']['running'] and result['agent_stopped']['pid']==0
(e/'lifecycle.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'restart_http_seconds':result['app_restart_http_seconds'],'restart_cli_seconds':result['app_restart_cli_seconds'],'independent_stop':True,'seed_preserved':True}),flush=True)

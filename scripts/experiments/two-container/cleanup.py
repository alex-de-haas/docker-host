"""Stop owned test resources, release the runtime lease, remove credential copies."""
import json
import re
import socket
import subprocess
from api import ROOT, CORE, request

cfg=json.loads((ROOT/'coordinator/runtime.json').read_text())
e=ROOT/'evidence'
cli=['hosty','--data-root',str(ROOT/'core-instance')]
cleanup={}
logs=subprocess.check_output(['docker','logs',cfg['appContainer']],stderr=subprocess.STDOUT,text=True)
(e/'app-final.log').write_text(re.sub(r'([?&](?:code|state)=)[^&\s"\\]+',r'\1[redacted]',logs))
for app in ['com.haas.demo-app','hosty.harness']:
    p=subprocess.run(cli+['apps','stop',app],capture_output=True,text=True)
    cleanup[app]={'exitCode':p.returncode,'output':p.stdout,'error':p.stderr}
    assert p.returncode==0,p.stderr
lease=json.loads((ROOT/'coordinator/runtime-lease.json').read_text())
workspace=request(CORE,'/api/development/workspaces/'+cfg['workspaceId']+'/operations/release-lease',{'requestId':lease['releaseRequestId'],'leaseId':lease['leaseId']})
assert workspace['leases']==[],workspace['leases']
(e/'workspace-cleanup.json').write_text(json.dumps(workspace,indent=2))
d=json.loads(subprocess.check_output(['docker','inspect',cfg['container']],text=True))[0]
assert d['Config']['Labels']['hosty.experiment']=='two-container-20261013'
assert not d['State']['Running'] and d['State']['Pid']==0
cleanup['agentFinalState']=d['State']
subprocess.run(['docker','rm',cfg['container']],check=True,capture_output=True)
p=subprocess.run(cli+['core','stop'],capture_output=True,text=True)
cleanup['core']={'exitCode':p.returncode,'output':p.stdout,'error':p.stderr}
assert p.returncode==0,p.stderr
for relative in ['agent-data/codex/auth.json','coordinator/cookies.txt','coordinator/bridge.json','coordinator/account.json']:
    path=ROOT/relative
    path.unlink(missing_ok=True)
    cleanup[relative]='removed'
ports=[37071,37072,25292,json.loads((ROOT/'coordinator/harness.json').read_text())['port']]
cleanup['listenersClosed']={}
for port in ports:
    with socket.socket() as sock:cleanup['listenersClosed'][str(port)]=sock.connect_ex(('127.0.0.1',port))!=0
assert all(cleanup['listenersClosed'].values())
# Core stop retains stopped Docker containers; remove only this known test app after proving
# ownership and quiescence. Keep its data and cache volumes for inspection/reproduction.
app=json.loads(subprocess.check_output(['docker','inspect',cfg['appContainer']],text=True))[0]
assert app['Config']['Labels']['hosty.instance']==(ROOT/'core-instance/core/instance-id').read_text().strip()
assert app['Config']['Labels']['hosty.app.id']=='com.haas.demo-app'
assert not app['State']['Running'] and app['State']['Pid']==0
cleanup['appFinalState']=app['State']
subprocess.run(['docker','rm',cfg['appContainer']],check=True,capture_output=True)
cleanup['remainingExperimentContainers']=subprocess.check_output(['docker','ps','-a','--filter','label=hosty.experiment=two-container-20261013','--format','{{.Names}}'],text=True).strip()
cleanup['remainingCoreContainers']=subprocess.check_output(['docker','ps','-a','--filter','label=hosty.instance='+(ROOT/'core-instance/core/instance-id').read_text().strip(),'--format','{{.Names}}'],text=True).strip()
assert not cleanup['remainingExperimentContainers'] and not cleanup['remainingCoreContainers']
cleanup['workspaceRetained']=True
(e/'cleanup.json').write_text(json.dumps(cleanup,indent=2))
print('Test containers and Core/Harness stopped; mounts released, credentials removed, dirty workspace retained.')

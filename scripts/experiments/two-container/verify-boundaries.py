"""Inspect the fixture's explicit mounts and independent data access."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from api import ROOT, CORE, request

cfg=json.loads((ROOT/'coordinator/runtime.json').read_text())
results={}
suffix='-'+sys.argv[1] if len(sys.argv)>1 else ''
def probe(container, source):
    output=subprocess.check_output(['docker','exec','--user','1000:1000',container,'node','-e',source],text=True)
    return json.loads(output)
outside=str(ROOT/'outside/canary')
original='/Users/haas/Sources/haas/docker-host/AGENTS.md'
for role,name in [('agent',cfg['container']),('app',cfg['appContainer'])]:
    denied=[outside,original,'/var/run/docker.sock',str(ROOT/'core-instance/core/auth')]
    if role=='app':denied.append(str(ROOT/'agent-data/codex/auth.json'))
    source='const fs=require("fs");const paths='+json.dumps(denied)+';console.log(JSON.stringify(Object.fromEntries(paths.map(p=>{try{fs.accessSync(p);return [p,false]}catch{return [p,true]}}))))'
    results[role]={'inaccessible':probe(name,source)}
    assert all(results[role]['inaccessible'].values())
    d=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
    results[role].update({'id':d['Id'],'image':d['Image'],'state':d['State'],'mounts':d['Mounts'],'limits':{k:d['HostConfig'][k] for k in ['Memory','MemorySwap','NanoCpus','PidsLimit','Privileged','ReadonlyRootfs','CapDrop','SecurityOpt']},'processes':subprocess.check_output(['docker','top',name,'-eo','pid,uid,comm'],text=True),'cgroup':subprocess.check_output(['docker','exec',name,'sh','-c','for f in memory.current memory.peak memory.events; do echo "$f"; cat /sys/fs/cgroup/$f; done'],text=True)})
# The application source is mounted read-only; test opening the actual changed file for write,
# without truncating it even if a faulty boundary unexpectedly permits the open.
results['app']['source_write_refused']=probe(cfg['appContainer'],'const fs=require("fs");let denied=false;try{const fd=fs.openSync("/workspace/apps/demo-app/src/components/DemoOverview.tsx","r+");fs.closeSync(fd)}catch(e){denied=e.code==="EROFS"||e.code==="EACCES"}console.log(JSON.stringify(denied));')
assert results['app']['source_write_refused']
seed=Path(cfg['appData'])/'agent-seed.json'
results['seed']={'sha256':hashlib.sha256(seed.read_bytes()).hexdigest(),'data':json.loads(seed.read_text()),'appContents':probe(cfg['appContainer'],'console.log(require("fs").readFileSync("/app/data/agent-seed.json","utf8"))')}
assert results['seed']['data']==results['seed']['appContents']
assert (ROOT/'outside/canary').read_text()=='outside-agent-and-app\n'
(ROOT/'evidence'/('boundaries'+suffix+'.json')).write_text(json.dumps(results,indent=2))
workspace=request(CORE,'/api/development/workspaces/'+cfg['workspaceId'])
(ROOT/'evidence'/('workspace-after'+suffix+'.json')).write_text(json.dumps(workspace,indent=2))
patch=subprocess.check_output(['git','-C',cfg['workspace'],'diff','--binary'],text=True)
(ROOT/'evidence'/('workspace'+suffix+'.patch')).write_text(patch)
print('Mount refusal, read-only app source, shared synthetic seed and workspace checks passed.')

"""Independently verify the agent's patch under an explicit Core activity lease."""
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path
from api import ROOT, CORE, request

runtime=json.loads((ROOT/'coordinator/runtime.json').read_text())
evidence=ROOT/'evidence'
suffix='-webpack' if '--webpack-only' in sys.argv else ''
lease_file=ROOT/('coordinator/verification-lease'+suffix+'.json')
if lease_file.exists():
    raise SystemExit('Inspect and recover the recorded lease before retrying.')
lease={'leaseId':str(uuid.uuid4()),'requestId':str(uuid.uuid4()),'releaseRequestId':str(uuid.uuid4())}
lease_file.write_text(json.dumps(lease,indent=2))
route='/api/development/workspaces/'+runtime['workspaceId']
request(CORE,route+'/operations/lease',{'requestId':lease['requestId'],'leaseId':lease['leaseId']})
results={}
def cgroup(name):
    result=subprocess.check_output(['docker','exec',runtime['container'],'sh','-c','for f in memory.current memory.peak memory.events memory.stat cpu.stat; do echo "$f"; cat /sys/fs/cgroup/$f; done'],text=True)
    (evidence/name).write_text(result)
try:
    cgroup('cgroup-before-independent'+suffix+'.txt')
    commands=[('independent_webpack',['npm','run','build','--workspace','@haas/hosty-demo-app','--','--webpack'])] if suffix else [('independent_tests',['npm','test','--workspace','@haas/hosty-demo-app','--','--maxWorkers=2']),('independent_build',['npm','run','build','--workspace','@haas/hosty-demo-app'])]
    for stage,command in commands:
        (evidence/'phase').write_text(stage)
        start=time.monotonic()
        with (evidence/(stage+'.log')).open('w') as out:
            child=subprocess.Popen(['docker','exec','--workdir',runtime['workspace'],runtime['container'],*command],stdout=out,stderr=subprocess.STDOUT)
            try: code=child.wait(timeout=600)
            except subprocess.TimeoutExpired:
                # Docker exec CLI exit alone does not prove its container children stopped.
                subprocess.run(['docker','stop','--time','5',runtime['container']],check=True,capture_output=True)
                child.wait(timeout=15)
                raise
        results[stage]={'command':command,'exit_code':code,'seconds':time.monotonic()-start}
        print(json.dumps(results[stage]),flush=True)
        if code:raise RuntimeError(stage+' failed; see retained log.')
    cgroup('cgroup-after-independent'+suffix+'.txt')
    tree=Path(runtime['workspace'])
    patch=subprocess.check_output(['git','-C',str(tree),'diff','--binary'],text=True)
    (evidence/'agent-tracked.patch').write_text(patch)
    (evidence/'agent-new-test.ts').write_text((tree/'apps/demo-app/test/demo-config.test.ts').read_text())
    results['diff']=request(CORE,route+'/diff',{'path':'apps/demo-app/src/lib/demo-config.ts','view':'local'})
finally:
    released=request(CORE,route+'/operations/release-lease',{'requestId':lease['releaseRequestId'],'leaseId':lease['leaseId']})
    results['remaining_leases']=released['leases']
    (evidence/('verification'+suffix+'.json')).write_text(json.dumps(results,indent=2))
(evidence/'phase').write_text('idle_after_independent'+suffix)
time.sleep(30)
(evidence/('workspace-final'+suffix+'.json')).write_text(json.dumps(request(CORE,route),indent=2))
print('Independent verification complete; Core lease released.',flush=True)

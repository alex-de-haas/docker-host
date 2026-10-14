"""Configure a disposable Core-managed source runtime and a separate agent worker."""
import json
import subprocess
import uuid
from pathlib import Path
from api import ROOT, CORE, request

cfg=json.loads((ROOT/'coordinator/runtime.json').read_text())
tree=Path(cfg['workspace'])
lease={'leaseId':str(uuid.uuid4()),'requestId':str(uuid.uuid4()),'releaseRequestId':str(uuid.uuid4())}
lease_path=ROOT/'coordinator/runtime-lease.json'
if lease_path.exists(): raise SystemExit('Recover the existing runtime lease before retrying.')
lease_path.write_text(json.dumps(lease))
request(CORE,'/api/development/workspaces/'+cfg['workspaceId']+'/operations/lease',{'requestId':lease['requestId'],'leaseId':lease['leaseId']})
manifest_path=tree/'apps/demo-app/manifest.json'
manifest=json.loads(manifest_path.read_text())
(ROOT/'evidence/original-demo-manifest.json').write_text(json.dumps(manifest,indent=2))
manifest['runtimeProfiles']=[{'key':'dev','type':'docker','development':True,'default':True}]
manifest['defaultRuntime']='dev'
recipe_dir=tree/'apps/demo-app/.container-experiment'
recipe_dir.mkdir(exist_ok=True)
(recipe_dir/'Dockerfile').write_text('FROM hosty-two-container-dev:20261013\n')
manifest['services']=[{'key':'backend','runtimes':{'dev':{
    'type':'docker','artifact':'source','build':{'context':'apps/demo-app/.container-experiment','dockerfile':'Dockerfile','revision':'two-container-20261013-v2'},
    'sourceMount':{'path':'.','target':'/workspace','mode':'ro','caches':['node_modules','apps/demo-app/.next-experiment','apps/demo-app/node_modules']},
    'workingDirectory':'.',
    'setup':'npm ci --workspace @haas/hosty-demo-app --workspace @hosty-sdk/app --include=dev --no-audit --no-fund',
    'command':'exec npm run dev:frontend --workspace @haas/hosty-demo-app',
    'environment':{'PORT':'3000','NEXT_DIST_DIR':'.next-experiment','NEXT_TELEMETRY_DISABLED':'1','NODE_ENV':'development','DEMO_DATA_DIR':'/app/data','DEMO_LOG_DIR':'/app/cache/logs','NPM_CONFIG_CACHE':'/app/cache/npm'},
    'ports':[{'key':'http','containerPort':3000,'protocol':'http','public':True}]
}}}]
for endpoint in manifest['endpoints']: endpoint['service']='backend'
manifest['data']={'enabled':True,'targets':[{'runtime':'dev','service':'backend','containerPath':'/app/data','environment':'HOSTY_APP_DATA_DIR'}]}
manifest['cache']={'enabled':True,'targets':[{'runtime':'dev','service':'backend','containerPath':'/app/cache','environment':'HOSTY_APP_CACHE_DIR'}]}
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
tsconfig_path=tree/'apps/demo-app/tsconfig.json'
tsconfig=json.loads(tsconfig_path.read_text())
for pattern in ['.next-experiment/types/**/*.ts','.next-experiment/dev/types/**/*.ts']:
    if pattern not in tsconfig['include']: tsconfig['include'].append(pattern)
tsconfig_path.write_text(json.dumps(tsconfig,indent=2)+'\n')
(tree/'apps/demo-app/next-env.d.ts').write_text('/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "./.next-experiment/dev/types/routes.d.ts";\nimport "./.next-experiment/dev/types/root-params.d.ts";\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n')
(ROOT/'evidence/experiment-demo-manifest.json').write_text(json.dumps(manifest,indent=2))
app_data=ROOT/'core-instance/apps/com.haas.demo-app/data'
app_data.mkdir(parents=True,exist_ok=True)
(app_data/'experiment-fixture.json').write_text(json.dumps({'source':'synthetic','scenario':'separate-containers','items':[{'id':'fixture-1','title':'Only sandbox data'}]},indent=2))
cfg['appData']=str(app_data)
(ROOT/'coordinator/runtime.json').write_text(json.dumps(cfg,indent=2))
mounts=[(ROOT/'agent-data',ROOT/'agent-data','rw'),(tree,tree,'rw'),(Path(cfg['gitDir']),Path(cfg['gitDir']),'ro'),(app_data,Path('/sandbox-data'),'rw')]
args=['docker','run','-d','--name',cfg['container'],'--label','hosty.experiment=two-container-20261013','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--init','--user=1000:1000','--memory=4g','--memory-swap=4g','--cpus=2','--pids-limit=512','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m']
for src,dst,mode in mounts: args.extend(['--mount',f'type=bind,src={src},dst={dst}'+(',readonly' if mode=='ro' else '')])
args+=['--env','HOME='+str(ROOT/'agent-data/home'),'--env','CODEX_HOME='+str(ROOT/'agent-data/codex'),'--env','NPM_CONFIG_CACHE='+str(ROOT/'agent-data/npm-cache'),'--env','NEXT_TELEMETRY_DISABLED=1','hosty-agent-container-experiment:20261013','sleep','infinity']
container_id=subprocess.check_output(args,text=True).strip()
print(json.dumps({'worker':container_id,'workspace':str(tree),'manifest':str(manifest_path),'leaseId':lease['leaseId']}))

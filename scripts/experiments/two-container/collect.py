"""Export sanitized observations and reproducible resource summaries."""
import hashlib
import json
import re
import shutil
import statistics
import subprocess
from pathlib import Path
from api import ROOT

repo=Path(__file__).resolve().parents[3]
e=ROOT/'evidence'
def load(name):return json.loads((e/name).read_text())
def memory(s):
    m=re.match(r'([0-9.]+)([KMG]iB|B)',s)
    return float(m[1])*{'B':1/1048576,'KiB':1/1024,'MiB':1,'GiB':1024}[m[2]] if m else None
def summarize(rows):
    groups={}
    for x in rows:
        value=memory(x['MemUsage'])
        if value is not None:groups.setdefault(x['phase'],{}).setdefault(x['Name'],[]).append((value,x['CPUPerc']))
    return {phase:{name:{'samples':len(a),'medianMiB':statistics.median(v for v,_ in a),'maximumMiB':max(v for v,_ in a),'maximumCpuPercent':max(float(cpu.rstrip('%')) for _,cpu in a)} for name,a in group.items()} for phase,group in groups.items()}
def sanitize(s):return re.sub(r'([?&](?:code|state)=)[^&\s"\\]+',r'\1[redacted]',s)
main=[json.loads(x) for x in (e/'stats-main.jsonl').read_text().splitlines()]
final=[json.loads(x) for x in (e/'stats-final.jsonl').read_text().splitlines()]
result={'date':'2026-10-13','scope':'Harness agent and separate Core-managed Demo App Docker development container; disposable Core, not a shipped sandbox-instance backend','coordinatorSourceCommit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),'applicationSourceCommit':load('workspace-before.json')['originalBase'],'mainSummary':summarize(main),'finalRecipeSummary':summarize(final),'mainSamples':main,'finalRecipeSamples':final,'earlierSetupSamplesExcluded':len((e/'stats.jsonl').read_text().splitlines())}
for name in ['workspace-before','workspace-after','workspace-after-v2','containers-before','boundaries','boundaries-v2','source-edit-time','recheck-source-time','warmup-result','edit-result','recheck-result','browser','browser-v2','browser-ui-observations','lifecycle','cleanup','workspace-cleanup','restart-failure','app-update-plan','app-update-plan-build','app-update-plan-port','app-update-plan-cache']:
    result[name]=json.loads(sanitize((e/(name+'.json')).read_text()))
result['logs']={p.name:sanitize(p.read_text()) for p in sorted((ROOT/'agent-data/verification').glob('*')) if p.suffix in ['.log','.exit-status']}
result['applicationLogs']={p.name:sanitize(p.read_text()) for p in e.glob('app-*.log')}
result['patch']=(e/'workspace-v2.patch').read_text()
result['taskPrompts']={p.name:p.read_text() for p in e.glob('*-task.txt')}
result['recipeSha256']={str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.iterdir() if p.is_file()}
target=e/'two-container-evidence.json'
target.write_text(json.dumps(result,indent=2)+'\n')
shutil.copy2(e/'hot-reload-v2.jpg',target.with_name('2026-10-13-two-container-preview.jpg'))
print(json.dumps({'evidence':str(target),'mainSamples':len(main),'finalSamples':len(final),'mainSummary':result['mainSummary'],'finalRecipeSummary':result['finalRecipeSummary']},indent=2))

"""Run one operator-provided experimental task through the real Harness API."""
import json
import sys
import time
from pathlib import Path
from api import ROOT, request

state=json.loads((ROOT/'coordinator/session.json').read_text())
record_path=ROOT/'core-instance/apps/hosty.harness/data/sessions'/state['session_id']/'record.json'
name=sys.argv[1]
prompt=(ROOT/'evidence'/f'{name}-task.txt').read_text()
started=time.time()
request(state['origin'],'/api/sessions/'+state['session_id']+'/messages',{'text':prompt})
while time.time()-started<900:
    time.sleep(1)
    record=json.loads(record_path.read_text())
    if record['status'] in ['idle','failed','cancelled','awaiting_approval','awaiting_question']:
        result={'status':record['status'],'started':started,'finished':time.time(),'harnessSessionId':record.get('harnessSessionId')}
        (ROOT/'evidence'/f'{name}-result.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result),flush=True)
        break
else:raise RuntimeError('Task exceeded experiment deadline; inspect before retrying.')

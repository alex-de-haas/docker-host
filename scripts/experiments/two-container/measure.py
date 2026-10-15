"""Sample both experiment containers without exposing environment credentials."""
import json
import re
import subprocess
import sys
import time
from api import ROOT

evidence=ROOT/'evidence'
config=json.loads((ROOT/'coordinator/runtime.json').read_text())
names=[config['container'],config['appContainer']]
started=time.monotonic()
suffix='-'+sys.argv[1] if len(sys.argv)>1 else ''
process=subprocess.Popen(['docker','stats','--format','{{json .}}',*names],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
    with (evidence/('stats'+suffix+'.jsonl')).open('x') as stream:
        for line in process.stdout:
            if (evidence/('stop-sampling'+suffix)).exists():break
            try: sample=json.loads(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',line).strip())
            except ValueError:continue
            phase=(evidence/'phase').read_text().strip()
            stream.write(json.dumps({'elapsed':time.monotonic()-started,'unixTime':time.time(),'phase':phase,**sample})+'\n')
            stream.flush()
finally:
    process.terminate();process.wait(timeout=10)

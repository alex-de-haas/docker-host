"""Collect Docker working-set samples and separate host coordinator RSS."""
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from api import ROOT

evidence = ROOT / 'evidence'
config = json.loads((ROOT / 'coordinator/runtime.json').read_text())
pids = json.loads((ROOT / 'coordinator/processes.json').read_text())
started = time.monotonic()
suffix = '-webpack' if '--webpack' in sys.argv else ''
stop = evidence / ('stop-sampling'+suffix)
def phase():
    return (evidence / 'phase').read_text().strip()

def host():
    with (evidence / ('host-rss'+suffix+'.jsonl')).open('w') as stream:
        while not stop.exists():
            rows = [list(map(int, line.split())) for line in subprocess.check_output(['ps','-axo','pid=,ppid=,rss='], text=True).splitlines() if len(line.split()) == 3]
            owned = {pids['launcherPid']}
            for _ in range(10):
                owned.update(pid for pid, parent, _ in rows if parent in owned)
            stream.write(json.dumps({'elapsed':time.monotonic()-started,'phase':phase(),'rss_kib':sum(rss for pid, _, rss in rows if pid in owned),'process_count':sum(pid in owned for pid,_,_ in rows)})+'\n');stream.flush()
            time.sleep(1)
threading.Thread(target=host, daemon=True).start()
process = subprocess.Popen(['docker','stats','--format','{{json .}}',config['container']], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    with (evidence / ('stats'+suffix+'.jsonl')).open('w') as stream:
        for line in process.stdout:
            if stop.exists():break
            try: sample=json.loads(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',line).strip())
            except ValueError:continue
            stream.write(json.dumps({'elapsed':time.monotonic()-started,'phase':phase(),**sample})+'\n');stream.flush()
finally:
    process.terminate();process.wait(timeout=10)

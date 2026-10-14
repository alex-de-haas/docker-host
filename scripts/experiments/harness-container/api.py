"""Local experiment HTTP client. Cookie/password files stay outside agent mounts."""
from pathlib import Path
import http.cookiejar
import json
import urllib.request
import urllib.error

ROOT = Path('/private/tmp/hosty-harness-container-20261013')
CORE = 'http://127.0.0.1:37071'
jar = http.cookiejar.MozillaCookieJar(str(ROOT / 'coordinator/cookies.txt'))
if Path(jar.filename).exists():
    jar.load(ignore_discard=True, ignore_expires=True)
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def request(origin, route, body=None, method=None, headers=None):
    hdr = {'content-type': 'application/json', 'origin': origin, **(headers or {})}
    csrf = next((c.value for c in jar if c.name == 'hosty_csrf'), None)
    if csrf:
        hdr['X-Hosty-CSRF'] = csrf
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(origin + route, data=data, headers=hdr, method=method or ('POST' if body is not None else 'GET'))
    try:
        with opener.open(req, timeout=180) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(str(error.code)+' '+error.read().decode()[:1500]) from None
    jar.save(ignore_discard=True, ignore_expires=True)
    Path(jar.filename).chmod(0o600)
    return json.loads(raw) if raw else None

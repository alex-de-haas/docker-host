import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const servicePaths = new Map([
  ['GET /api/auth/apps/protocol', 'protocol'],
  ['POST /api/auth/apps/token', 'token'],
  ['POST /api/auth/apps/revalidate', 'revalidate'],
  ['GET /api/auth/apps/directory', 'directory'],
]);
const cookieName = 'hosty_sandbox_preview';
const proofCookie = 'hosty_sandbox_proof';
export function safePath(raw) {
  // Never let WHATWG normalization turn a denied input into an allowed upstream route.
  if (!raw?.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) return null;
  const path = raw.split('?')[0];
  if (/%(?:2e|2f|5c|00)/i.test(path)) return null;
  if (path.split('/').some(p => p === '.' || p === '..')) return null;
  return path;
}
function cookies(req) {
  return new Map((req.headers.cookie ?? '').split(';').map(v => v.trim().split(/=(.*)/s)).filter(v => v.length > 1));
}
function deny(res, status = 403) { if (res.headersSent) { res.destroy(); return; } res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); }
function cleanHeaders(headers) {
  const result = { ...headers };
  for (const key of Object.keys(result)) if (key.startsWith('x-hosty-') || key.startsWith('x-forwarded-') ||
    ['x-docker-host-identity', 'authorization', 'proxy-authorization', 'proxy-connection', 'connection', 'transfer-encoding', 'upgrade'].includes(key)) delete result[key];
  return result;
}
export function createRelay(config, serviceToken) {
  const core = new URL(config.coreOrigin);
  if (core.protocol !== 'http:' || core.pathname !== '/' || core.username || core.password) throw new Error('Invalid fixed Core origin');
  const root = `/api/sandbox-runtime/${config.instanceId}/`;
  const proofs = new Map();
  const sockets = new Set();
  function upstream(path, options = {}) {
    return http.request({ hostname: core.hostname, port: core.port, method: options.method ?? 'GET', path: root + path,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}`, ...options.headers }, timeout: 5000 });
  }
  async function call(path, body) {
    return new Promise((resolve, reject) => {
      const request = upstream(path, { method: 'POST' });
      request.on('timeout', () => request.destroy()); request.on('error', reject);
      request.on('response', response => {
        let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 65536) response.destroy(); });
        response.on('error', reject); response.on('end', () => {
          if (response.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }); request.end(JSON.stringify(body));
    });
  }
  async function identity(req) {
    const accessToken = cookies(req).get(cookieName);
    if (!accessToken?.startsWith('hostysb_grant_')) return null;
    const result = await call('revalidate', { accessToken });
    return result?.active && result.runtimeInstanceId === config.instanceId && result.generation === config.generation &&
      result.dataRevision === config.dataRevision ? accessToken : null;
  }
  function forwardCore(req, res, route, browser = false) {
    const request = upstream(route, { method: req.method, headers: browser ? {
      'content-type': req.headers['content-type'] ?? 'application/json',
      ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
      'x-hosty-sandbox-origin': `http://${req.headers.host}`, origin: req.headers.origin ?? '',
    } : { authorization: req.headers.authorization ?? '', 'x-hosty-user-token': req.headers['x-hosty-user-token'] ?? '', 'content-type': req.headers['content-type'] ?? 'application/json' } });
    request.on('timeout', () => request.destroy()); request.on('error', () => deny(res, 503));
    request.on('response', response => {
      const headers = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': browser && req.method === 'GET' ? 'origin' : 'no-referrer' };
      // Realm endpoints cannot set a Core cookie through a sibling hostname.
      delete headers['set-cookie']; res.writeHead(response.statusCode ?? 502, headers); response.pipe(res);
    }); req.pipe(request);
  }
  const appCore = http.createServer((req, res) => {
    const path = safePath(req.url), route = servicePaths.get(`${req.method} ${path}`);
    if (!route || req.url !== path || req.headers.host !== 'sandbox-core:8090') return deny(res);
    forwardCore(req, res, route);
  });
  const preview = http.createServer(async (req, res) => {
    try {
      const path = safePath(req.url); if (!path) return deny(res);
      const host = req.headers.host, endpoint = config.endpoints.find(e => e.host === host);
      if (host === config.authHost) {
        if ((req.method === 'GET' || req.method === 'POST') && path === '/login')
          return forwardCore(req, res, 'browser/login' + req.url.slice(path.length), true);
        return deny(res);
      }
      if (!endpoint) return deny(res);
      if (req.headers.origin && !config.endpoints.some(e => `http://${e.host}` === req.headers.origin)) return deny(res);
      if (req.method === 'GET' && path === '/_hosty/healthz') {
        const request = http.get({ hostname: endpoint.service, port: endpoint.port, path: '/', timeout: 2000 }, response => {
          response.resume(); res.writeHead(response.statusCode < 500 ? 200 : 503); res.end();
        }); request.on('timeout', () => request.destroy()); request.on('error', () => deny(res, 503)); return;
      }
      if (req.method === 'GET' && path === '/_hosty/callback') {
        const query = new URL(req.url, `http://${host}`).searchParams;
        const state = query.get('state'), proof = proofs.get(state); proofs.delete(state);
        if (!proof || proof.expires <= Date.now() || cookies(req).get(proofCookie) !== state || proof.host !== host) return deny(res);
        const result = await call('token', { code: query.get('code'), codeVerifier: proof.verifier });
        if (!result?.accessToken?.startsWith('hostysb_grant_')) return deny(res);
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [
          `${cookieName}=${result.accessToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
          `${proofCookie}=; HttpOnly; SameSite=Lax; Path=/_hosty/callback; Max-Age=0`,
        ] }); res.end(); return;
      }
      const persona = new URL(req.url, `http://${host}`).searchParams.get('hosty_sandbox_persona');
      if (persona && (req.method !== 'GET' || !/^(?:core|sandbox_[a-f0-9]{32})$/.test(persona))) return deny(res, 400);
      const token = persona ? null : await identity(req);
      if (!token) {
        if (req.method !== 'GET' || path.startsWith('/_hosty/')) return deny(res, 401);
        for (const [key, value] of proofs) if (value.expires <= Date.now()) proofs.delete(key);
        if (proofs.size >= 256) return deny(res, 429);
        const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url');
        proofs.set(state, { verifier, host, expires: Date.now() + 600000 });
        const login = new URL(`http://${config.authHost}/login`);
        login.searchParams.set('state', state); login.searchParams.set('codeChallenge', createHash('sha256').update(verifier).digest('base64url'));
        login.searchParams.set('redirectUri', `http://${host}/_hosty/callback`);
        if (persona) login.searchParams.set('persona', persona);
        res.writeHead(303, { location: login.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'set-cookie': `${proofCookie}=${state}; HttpOnly; SameSite=Lax; Path=/_hosty/callback; Max-Age=600` }); res.end(); return;
      }
      const headers = cleanHeaders(req.headers);
      headers.cookie = (req.headers.cookie ?? '').split(';').filter(v => !v.trim().startsWith('hosty_sandbox_')).join(';');
      headers['x-docker-host-identity'] = token; headers['x-forwarded-proto'] = 'http'; headers['x-forwarded-host'] = host;
      const request = http.request({ hostname: endpoint.service, port: endpoint.port, path: req.url, method: req.method, headers, timeout: 30000 }, response => {
        const output = cleanHeaders(response.headers);
        if (output['set-cookie']) output['set-cookie'] = output['set-cookie'].filter(v => !v.toLowerCase().startsWith('hosty_sandbox_'));
        // Cookies on the preview origin cannot escape to other local Core/app origins.
        if (output['set-cookie']) output['set-cookie'] = output['set-cookie'].map(v => v.replace(/;\s*domain=[^;]+/gi, ''));
        output['cache-control'] = 'no-store'; output['referrer-policy'] = 'no-referrer';
        res.writeHead(response.statusCode ?? 502, output); response.pipe(res);
      }); request.on('timeout', () => request.destroy()); request.on('error', () => deny(res, 502)); req.pipe(request);
    } catch { deny(res, 503); }
  });
  preview.on('upgrade', async (req, socket, head) => {
    try {
      const endpoint = config.endpoints.find(e => e.host === req.headers.host);
      if (!endpoint || !safePath(req.url) || req.headers.origin !== `http://${endpoint.host}` || !await identity(req)) return socket.destroy();
      const headers = cleanHeaders(req.headers); headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      headers.cookie = ''; headers['x-docker-host-identity'] = await identity(req);
      const request = http.request({ hostname: endpoint.service, port: endpoint.port, path: req.url, headers, timeout: 5000 });
      request.on('timeout', () => request.destroy()); request.on('error', () => socket.destroy());
      request.on('response', () => socket.destroy());
      request.on('upgrade', (response, peer, peerHead) => {
        const allowed = ['connection', 'upgrade', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'];
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([k]) => allowed.includes(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        request.setTimeout(0); peer.setTimeout(0);
        if (peerHead.length) socket.write(peerHead); if (head.length) peer.write(head);
        peer.pipe(socket); socket.pipe(peer); sockets.add(socket);
        const timer = setInterval(() => { identity(req).then(value => { if (!value) socket.destroy(); }).catch(() => socket.destroy()); }, 1000);
        socket.on('close', () => { clearInterval(timer); peer.destroy(); sockets.delete(socket); }); peer.on('error', () => socket.destroy());
      }); request.end();
    } catch { socket.destroy(); }
  });
  function browserTarget(req, upgrade = false) {
    let url; try { url = new URL(req.url); } catch { return null; }
    const prefix = `${url.protocol}//${url.host}`;
    const rawPath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : null;
    if (!(url.protocol === 'http:' || upgrade && url.protocol === 'ws:') || url.username || url.password || url.hash || req.headers.host !== url.host ||
      rawPath === null || !safePath(rawPath.startsWith('?') || rawPath === '' ? '/' + rawPath : rawPath)) return null;
    if (!config.endpoints.some(e => e.host === url.host) && !(url.host === config.authHost && url.pathname === '/login')) return null;
    return url;
  }
  const browserProxy = http.createServer((req, res) => {
    const target = browserTarget(req); if (!target) return deny(res);
    const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const request = http.request({ hostname: '127.0.0.1', port: preview.address().port,
      path: target.pathname + target.search, method: req.method, headers, timeout: 30000 }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => deny(res, 502)); req.pipe(request);
  });
  browserProxy.on('upgrade', (req, socket, head) => {
    const target = browserTarget(req, true); if (!target) return socket.destroy();
    req.url = target.pathname + target.search; preview.emit('upgrade', req, socket, head);
  });
  // Chromium tunnels ws:// over an HTTP proxy with CONNECT. The authority is only a
  // selector: every permitted tunnel reaches this instance's authenticated preview listener,
  // never the requested network address. Nested CONNECT and foreign Host headers are refused.
  browserProxy.on('connect', (req, socket, head) => {
    if (req.url !== req.headers.host || !config.endpoints.some(e => e.host === req.url)) return socket.destroy();
    const peer = net.connect(preview.address().port, '127.0.0.1');
    sockets.add(socket);
    peer.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) peer.write(head); socket.pipe(peer); peer.pipe(socket); });
    peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
    socket.on('close', () => { peer.destroy(); sockets.delete(socket); }); peer.on('close', () => socket.destroy());
  });
  for (const server of [appCore, preview, browserProxy]) {
    server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
    if (server !== browserProxy) server.on('connect', (_req, socket) => socket.destroy());
  }
  return { appCore, preview, browserProxy, close() { for (const socket of sockets) socket.destroy(); appCore.closeAllConnections(); preview.closeAllConnections(); appCore.close(); preview.close(); browserProxy.closeAllConnections(); browserProxy.close(); proofs.clear(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile('/run/hosty/relay.json', 'utf8'));
  const relay = createRelay(config, process.env.HOSTY_SANDBOX_SERVICE_TOKEN);
  relay.appCore.listen(8090, '0.0.0.0'); relay.preview.listen(8091, '0.0.0.0');
  if (config.browserAddress) relay.browserProxy.listen(8092, config.browserAddress);
  process.on('SIGTERM', () => { relay.close(); process.exit(0); });
}

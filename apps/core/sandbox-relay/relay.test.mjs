import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRelay, safePath } from './relay.mjs';

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function request(port, host, path = '/', headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }); req.on('error', reject); req.end(body);
  });
}
async function fixture(t) {
  const config = { instanceId: 'a'.repeat(32), generation: 'b'.repeat(32), dataRevision: 'c'.repeat(32), endpoints: [] };
  const state = { coreCalls: [], appCalls: [], active: true, challenge: '' };
  const core = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    state.coreCalls.push({ path: req.url, headers: req.headers, body });
    if (req.url.endsWith('/protocol')) { res.end('{"version":2}'); return; }
    if (req.headers.authorization !== 'Bearer instance-service') { res.writeHead(401); res.end(); return; }
    const json = body && req.headers['content-type'] === 'application/json' ? JSON.parse(body) : {};
    if (req.url.endsWith('/revalidate')) res.end(JSON.stringify({ active: state.active && json.accessToken === 'hostysb_grant_test',
      runtimeInstanceId: config.instanceId, generation: config.generation, dataRevision: config.dataRevision }));
    else if (req.url.endsWith('/token')) {
      assert.equal(createHash('sha256').update(json.codeVerifier).digest('base64url'), state.challenge);
      res.end('{"accessToken":"hostysb_grant_test","expiresInSeconds":600}');
    } else { res.end('sandbox-auth'); }
  });
  const app = http.createServer((req, res) => { state.appCalls.push(req.headers); res.setHeader('set-cookie', ['hosty_sandbox_preview=forged; Domain=.hosty.localhost', 'app=value; Domain=.hosty.localhost; Path=/']); res.end('app-content'); });
  const appSockets = new Set();
  app.on('upgrade', (req, socket) => {
    appSockets.add(socket); socket.on('close', () => appSockets.delete(socket));
    state.appCalls.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  t.after(() => { for (const socket of appSockets) socket.destroy(); });
  const corePort = await listen(core), appPort = await listen(app);
  config.coreOrigin = `http://127.0.0.1:${corePort}`;
  const relay = createRelay(config, 'instance-service');
  const coreRelayPort = await listen(relay.appCore), previewPort = await listen(relay.preview), browserProxyPort = await listen(relay.browserProxy);
  config.authHost = `auth.sandbox.hosty.localhost:${previewPort}`;
  config.endpoints.push({ host: `app.sandbox.hosty.localhost:${previewPort}`, service: '127.0.0.1', port: appPort });
  t.after(() => { relay.close(); for (const server of [app, core]) { server.closeAllConnections(); server.close(); } });
  return { config, state, coreRelayPort, previewPort, browserProxyPort, host: config.endpoints[0].host };
}
test('rejects ambiguous paths before URL normalization', () => {
  for (const path of ['//admin', '/x/../api', '/api/%2e%2e/admin', '/%2fadmin', '/api\\admin', '/api/\0']) assert.equal(safePath(path), null);
  assert.equal(safePath('/api/auth/apps/token'), '/api/auth/apps/token');
});
test('fixed app-to-Core relay denies administration, wrong methods, hosts and escaped paths', async t => {
  const f = await fixture(t);
  for (const path of ['/api/users', '/control/stop', '/api/auth/apps/token?target=other', '//api/auth/apps/token', '/api/%2e%2e/auth/apps/token']) {
    assert.equal((await request(f.coreRelayPort, 'sandbox-core:8090', path, {}, 'POST', '{}')).status, 403);
  }
  assert.equal((await request(f.coreRelayPort, 'evil.test', '/api/auth/apps/protocol')).status, 403);
  assert.equal((await request(f.coreRelayPort, 'sandbox-core:8090', '/api/auth/apps/token')).status, 403);
  assert.equal(f.state.coreCalls.length, 0);
  assert.equal((await request(f.coreRelayPort, 'sandbox-core:8090', '/api/auth/apps/protocol')).status, 200);
});
test('never upgrades the application service credential', async t => {
  const f = await fixture(t);
  const result = await request(f.coreRelayPort, 'sandbox-core:8090', '/api/auth/apps/revalidate', { authorization: 'Bearer wrong', 'content-type': 'application/json' }, 'POST', '{}');
  assert.equal(result.status, 401);
  assert.equal(f.state.coreCalls[0].headers.authorization, 'Bearer wrong');
});
test('preview authenticates each request and strips caller identity and escaping cookies', async t => {
  const f = await fixture(t);
  const unauthenticated = await request(f.previewPort, f.host);
  assert.equal(unauthenticated.status, 303);
  assert.equal(new URL(unauthenticated.headers.location).host, f.config.authHost);
  assert.equal(f.state.appCalls.length, 0);
  const result = await request(f.previewPort, f.host, '/', { cookie: 'hosty_sandbox_preview=hostysb_grant_test',
    authorization: 'Bearer core-secret', 'x-docker-host-identity': 'forged', 'x-hosty-app-identity': 'forged' });
  assert.equal(result.status, 200); assert.equal(result.body, 'app-content');
  assert.equal(f.state.appCalls[0]['x-docker-host-identity'], 'hostysb_grant_test');
  assert.equal(f.state.appCalls[0].authorization, undefined); assert.equal(f.state.appCalls[0]['x-hosty-app-identity'], undefined);
  assert.equal(f.state.appCalls[0].cookie, ''); assert.deepEqual(result.headers['set-cookie'], ['app=value; Path=/']);
  f.state.active = false;
  assert.equal((await request(f.previewPort, f.host, '/', { cookie: 'hosty_sandbox_preview=hostysb_grant_test' }, 'POST')).status, 401);
  assert.equal(f.state.appCalls.length, 1);
});
test('callback is bound to a private proof, browser nonce, host and single use', async t => {
  const f = await fixture(t);
  const initial = await request(f.previewPort, f.host);
  const location = new URL(initial.headers.location), state = location.searchParams.get('state');
  f.state.challenge = location.searchParams.get('codeChallenge');
  assert.ok(!initial.headers.location.includes('codeVerifier'));
  const callback = `/_hosty/callback?code=hostysb_code_test&state=${state}`;
  const response = await request(f.previewPort, f.host, callback, { cookie: `hosty_sandbox_proof=${state}` });
  assert.equal(response.status, 303);
  assert.ok(response.headers['set-cookie'][0].includes('HttpOnly'));
  assert.equal((await request(f.previewPort, f.host, callback, { cookie: `hosty_sandbox_proof=${state}` })).status, 403);
});
test('unknown preview hosts and cross-origin writes never reach the app', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.previewPort, 'another.hosty.localhost')).status, 403);
  assert.equal((await request(f.previewPort, f.host, '/', { origin: 'http://evil.test', cookie: 'hosty_sandbox_preview=hostysb_grant_test' }, 'POST')).status, 403);
  assert.equal(f.state.appCalls.length, 0);
});

test('private browser proxy permits only the selected instance and authentication origin', async t => {
  const f = await fixture(t);
  for (const host of ['example.com', 'host.docker.internal:7070', 'sandbox-core:8090', 'another.hosty.localhost'])
    assert.equal((await request(f.browserProxyPort, host, `http://${host}/`)).status, 403);
  assert.equal((await request(f.browserProxyPort, f.host, `https://${f.host}/`)).status, 403);
  assert.equal((await request(f.browserProxyPort, f.host, `http://${f.config.authHost}/login`)).status, 403);
  assert.equal((await request(f.browserProxyPort, f.config.authHost, `http://${f.config.authHost}/api/users`)).status, 403);
  const response = await request(f.browserProxyPort, f.host, `http://${f.host}/`, { cookie: 'hosty_sandbox_preview=hostysb_grant_test' });
  assert.equal(response.status, 200); assert.equal(response.body, 'app-content');
  assert.equal(f.state.appCalls.length, 1);
});

test('persona selection starts a new proof exchange even when another preview user is signed in', async t => {
  const f = await fixture(t);
  const persona = 'sandbox_' + 'd'.repeat(32);
  const response = await request(f.previewPort, f.host, '/?hosty_sandbox_persona=' + persona, { cookie: 'hosty_sandbox_preview=hostysb_grant_test' });
  assert.equal(response.status, 303);
  const redirect = new URL(response.headers.location);
  assert.equal(redirect.host, f.config.authHost);
  assert.equal(redirect.searchParams.get('persona'), persona);
  assert.equal(f.state.appCalls.length, 0);
  assert.equal((await request(f.previewPort, f.host, '/?hosty_sandbox_persona=foreign')).status, 400);
});


test('login query preserves the encoded callback while path escapes remain denied', async t => {
  const f = await fixture(t);
  const initial = await request(f.previewPort, f.host);
  const login = new URL(initial.headers.location);
  const response = await request(f.browserProxyPort, login.host, login.href);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'sandbox-auth');
  assert.equal(response.headers['referrer-policy'], 'origin');
  const upstream = new URL(f.state.coreCalls[0].path, 'http://core');
  assert.equal(upstream.searchParams.get('redirectUri'), `http://${f.host}/_hosty/callback`);
  for (const path of ['/x/../login', '/x/%2e%2e/login', '/%2flogin']) {
    assert.equal((await request(f.browserProxyPort, login.host, `http://${login.host}${path}`)).status, 403);
  }
  assert.equal(f.state.coreCalls.length, 1);
});

test('private browser proxy forwards same-origin ws upgrades but rejects foreign targets', async t => {
  const f = await fixture(t);
  const upgrade = (host, origin = `http://${host}`) => new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port: f.browserProxyPort,
      path: `ws://${host}/_next/hmr`, headers: { host, origin, connection: 'Upgrade', upgrade: 'websocket',
        cookie: 'hosty_sandbox_preview=hostysb_grant_test' }, timeout: 2000 });
    req.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    req.on('error', () => resolve(null)); req.on('timeout', () => req.destroy()); req.end();
  });
  assert.equal(await upgrade(f.host), 101);
  assert.equal(f.state.appCalls.at(-1)['x-docker-host-identity'], 'hostysb_grant_test');
  assert.equal(await upgrade('foreign.hosty.localhost'), null);
  assert.equal(await upgrade(f.host, 'http://foreign.hosty.localhost'), null);
});

test('Chromium CONNECT reaches only the authenticated instance preview, never an arbitrary address', async t => {
  const f = await fixture(t);
  const tunnel = host => new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port: f.browserProxyPort,
      method: 'CONNECT', path: host, headers: { host }, timeout: 2000 });
    req.on('connect', (_response, socket) => resolve(socket));
    req.on('error', () => resolve(null)); req.on('timeout', () => req.destroy()); req.end();
  });
  assert.equal(await tunnel('host.docker.internal:7070'), null);
  assert.equal(await tunnel(f.config.authHost), null);
  const socket = await tunnel(f.host); assert.ok(socket);
  const response = new Promise(resolve => socket.once('data', bytes => resolve(bytes.toString())));
  socket.write(`GET /_next/hmr HTTP/1.1\r\nHost: ${f.host}\r\nOrigin: http://${f.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: hosty_sandbox_preview=hostysb_grant_test\r\n\r\n`);
  assert.match(await response, /^HTTP\/1.1 101/); socket.destroy();
  const denied = await tunnel(f.host);
  const denial = new Promise(resolve => denied.once('data', bytes => resolve(bytes.toString())));
  denied.write('GET /api/users HTTP/1.1\r\nHost: host.docker.internal:7070\r\n\r\n');
  assert.match(await denial, /^HTTP\/1.1 403/); denied.destroy();
});

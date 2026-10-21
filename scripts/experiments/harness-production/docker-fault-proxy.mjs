import http from 'node:http';
import net from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Only clients explicitly launched with this Unix socket are affected. The upstream engine,
// its images and unrelated applications stay intact. Request bodies/headers are never logged.
export async function startDockerFaultProxy(socketPath, upstreamPath, imageIds = {}) {
  const modes = new Set(['none', 'offline', 'worker-image', 'coordinator-image', 'deny-remove', 'lose-remove-reply']);
  const sockets = new Set();
  const hits = [];
  let mode = 'none';
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket; };
  const reject = (response, code, message) => {
    response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message }));
  };
  const server = http.createServer((request, response) => {
    if (mode === 'offline') { hits.push({ mode, method: request.method, path: '/' }); request.socket.destroy(); return; }
    const url = new URL(request.url, 'http://docker');
    const pathname = decodeURIComponent(url.pathname);
    const image = mode === 'worker-image' ? 'hosty-harness-worker' : mode === 'coordinator-image' ? 'hosty-harness' : null;
    if (image && pathname.includes('/images/') && (pathname.includes(image) || pathname.includes(imageIds[mode] ?? 'not-an-image-id') || url.searchParams.get('fromImage')?.includes(image))) {
      hits.push({ mode, method: request.method, path: pathname });
      reject(response, request.method === 'GET' ? 404 : 500, 'Acceptance fault: image unavailable / pull refused'); return;
    }
    const removal = request.method === 'DELETE' && pathname.includes('/containers/hosty-agent-');
    if (removal && mode === 'deny-remove') {
      hits.push({ mode, method: request.method, path: pathname });
      reject(response, 500, 'Acceptance fault: worker removal unavailable'); return;
    }
    const loseReply = removal && mode === 'lose-remove-reply';
    const upstream = http.request({ socketPath: upstreamPath, method: request.method, path: request.url, headers: request.headers }, reply => {
      if (loseReply) {
        reply.resume();
        reply.on('end', () => { hits.push({ mode: 'lose-remove-reply', method: request.method, path: pathname, upstreamStatus: reply.statusCode }); response.destroy(); });
      } else { response.writeHead(reply.statusCode, reply.headers); response.flushHeaders(); reply.pipe(response); }
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!response.headersSent) reject(response, 502, 'Acceptance proxy upstream unavailable'); else response.destroy(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on('connection', track);
  // Docker exec uses HTTP hijacking; preserve the byte stream after the ordinary upgrade request.
  server.on('upgrade', (request, client, head) => {
    if (mode === 'offline') { client.destroy(); return; }
    const upstream = track(net.connect(upstreamPath));
    upstream.once('connect', () => {
      let header = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) header += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      upstream.write(header + '\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const token = randomBytes(32).toString('hex');
  const control = http.createServer(async (request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reject(response, 403, 'Denied');
    if (request.method === 'PUT' && request.url === '/fault') {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1024) return reject(response, 413, 'Too large'); }
      let input; try { input = JSON.parse(body); } catch { return reject(response, 400, 'Invalid JSON'); }
      if (!modes.has(input.mode)) return reject(response, 400, 'Invalid fault');
      mode = input.mode;
      if (mode === 'offline') for (const socket of sockets) socket.destroy();
    } else if (request.method !== 'GET' || request.url !== '/fault') return reject(response, 404, 'Not found');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ mode, hits }));
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${control.address().port}`, token, hits,
    async close() {
      mode = 'none';
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => control.close(resolve))]);
      await rm(socketPath, { force: true });
    },
  };
}

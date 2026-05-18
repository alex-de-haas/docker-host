import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  MODULE_IDENTITY_ISSUER,
  getModuleIdentityJwks,
} from './module-identity.mjs';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('gateway HTTP proxy injects signed identity and strips Host-owned request headers', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config);
  const { proxyHttpRequest } = await import('../../server.mjs');
  const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string; body: string }> = [];
  const upstream = createHttpServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamRequests.push({
        headers: req.headers,
        url: req.url,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });

  try {
    await listen(upstream);
    const target = gatewayTarget({
      containerPort: getPort(upstream),
      exposurePolicy: 'loginRequired',
      accessReason: 'authenticated',
    });
    const proxy = createHttpServer((req, res) => {
      void proxyHttpRequest(req, res, target).catch(error => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'proxy failed');
      });
    });

    try {
      await listen(proxy);
      const response = await sendHttpRequest(getPort(proxy), {
        method: 'POST',
        path: '/reports?range=week',
        headers: {
          Host: 'reports.example.test',
          Authorization: 'Bearer cli-token',
          Cookie: 'docker_host_session=host-session; module_cookie=kept',
          'X-Docker-Host-Identity': 'spoofed-token',
          'X-Docker-Host-Other': 'spoofed',
          'X-Custom': 'kept',
        },
      }, 'request body');

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'ok');
      assert.equal(upstreamRequests.length, 1);
      const captured = upstreamRequests[0]!;
      assert.equal(captured.url, '/reports?range=week');
      assert.equal(captured.body, 'request body');
      assert.equal(captured.headers.host, 'reports.example.test');
      assert.equal(captured.headers.authorization, undefined);
      assert.equal(captured.headers.cookie, 'module_cookie=kept');
      assert.equal(captured.headers['x-docker-host-other'], undefined);
      assert.equal(captured.headers['x-custom'], 'kept');

      const identityToken = captured.headers['x-docker-host-identity'];
      assert.equal(typeof identityToken, 'string');
      assert.notEqual(identityToken, 'spoofed-token');
      const verified = await jwtVerify(identityToken as string, createLocalJWKSet(await getModuleIdentityJwks(config)), {
        issuer: MODULE_IDENTITY_ISSUER,
        audience: 'com.example.reports',
      });
      assert.equal(verified.payload.sub, 'user_1');
      assert.equal(verified.payload.moduleAccess, 'authenticated');
    } finally {
      await closeServer(proxy);
    }
  } finally {
    restoreEnv();
    await closeServer(upstream);
  }
});

test('gateway HTTP proxy honors public identity defaults and optional public identity', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config);
  const { proxyHttpRequest } = await import('../../server.mjs');
  const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined> }> = [];
  const upstream = createHttpServer((req, res) => {
    upstreamRequests.push({ headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

  try {
    await listen(upstream);
    let target = gatewayTarget({
      moduleId: 'com.example.public',
      hostname: 'public.example.test',
      containerPort: getPort(upstream),
      exposurePolicy: 'public',
      accessReason: 'public',
    });
    const proxy = createHttpServer((req, res) => {
      void proxyHttpRequest(req, res, target).catch(error => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'proxy failed');
      });
    });

    try {
      await listen(proxy);
      await sendHttpRequest(getPort(proxy), { headers: { Host: 'public.example.test' } });
      assert.equal(upstreamRequests[0]?.headers['x-docker-host-identity'], undefined);

      target = gatewayTarget({
        moduleId: 'com.example.public',
        hostname: 'public.example.test',
        containerPort: getPort(upstream),
        exposurePolicy: 'public',
        identityMode: 'optional',
        accessReason: 'public',
      });
      await sendHttpRequest(getPort(proxy), { headers: { Host: 'public.example.test' } });

      const identityToken = upstreamRequests[1]?.headers['x-docker-host-identity'];
      assert.equal(typeof identityToken, 'string');
      const verified = await jwtVerify(identityToken as string, createLocalJWKSet(await getModuleIdentityJwks(config)), {
        issuer: MODULE_IDENTITY_ISSUER,
        audience: 'com.example.public',
      });
      assert.equal(verified.payload.moduleAccess, 'publicAuthenticated');
    } finally {
      await closeServer(proxy);
    }
  } finally {
    restoreEnv();
    await closeServer(upstream);
  }
});

test('gateway websocket proxy injects signed identity into upgrade handshake', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config);
  const { proxyWebSocketUpgrade } = await import('../../server.mjs');
  let resolveRawHandshake: (value: string) => void = () => undefined;
  const rawHandshake = new Promise<string>(resolve => {
    resolveRawHandshake = resolve;
  });
  const upstream = net.createServer(socket => {
    socket.once('data', data => {
      resolveRawHandshake(data.toString('utf8'));
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
  });

  try {
    await listen(upstream);
    const target = gatewayTarget({
      containerPort: getPort(upstream),
      exposurePolicy: 'loginRequired',
      accessReason: 'authenticated',
    });
    const proxy = createHttpServer();
    proxy.on('upgrade', (req, socket, head) => {
      void proxyWebSocketUpgrade(req, socket, head, target).catch(() => socket.destroy());
    });

    try {
      await listen(proxy);
      const client = net.connect(getPort(proxy), '127.0.0.1', () => {
        client.write([
          'GET /socket HTTP/1.1',
          'Host: reports.example.test',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'X-Docker-Host-Identity: spoofed-token',
          '',
          '',
        ].join('\r\n'));
      });
      client.on('error', () => undefined);
      const raw = await rawHandshake;
      client.destroy();

      assert.doesNotMatch(raw, /spoofed-token/);
      const match = raw.match(/^X-Docker-Host-Identity: (.+)$/mi);
      assert.ok(match, raw);
      const verified = await jwtVerify(match[1]!, createLocalJWKSet(await getModuleIdentityJwks(config)), {
        issuer: MODULE_IDENTITY_ISSUER,
        audience: 'com.example.reports',
      });
      assert.equal(verified.payload.sub, 'user_1');
      assert.equal(verified.payload.moduleAccess, 'authenticated');
    } finally {
      await closeServer(proxy);
    }
  } finally {
    restoreEnv();
    await closeServer(upstream);
  }
});

function gatewayTarget(input: {
  moduleId?: string;
  hostname?: string;
  containerPort: number;
  exposurePolicy: 'public' | 'loginRequired' | 'assignedUsersOnly';
  identityMode?: 'none' | 'optional' | 'required';
  accessReason: 'public' | 'authenticated' | 'assigned' | 'hostAdmin';
}) {
  const moduleId = input.moduleId || 'com.example.reports';
  const hostname = input.hostname || 'reports.example.test';
  return {
    exposure: {
      id: `gw_${moduleId.replace(/[^a-z0-9]+/gi, '_')}`,
      moduleId,
      hostname,
      portKey: 'web',
      exposurePolicy: input.exposurePolicy,
      ...(input.identityMode ? { identityMode: input.identityMode } : {}),
    },
    access: {
      allowed: true,
      policy: input.exposurePolicy,
      reason: input.accessReason,
    },
    principal: {
      id: 'user_1',
      role: 'host.user',
      email: 'user@example.test',
      displayName: 'User One',
    },
    networkAlias: '127.0.0.1',
    containerPort: input.containerPort,
    targetOrigin: `http://127.0.0.1:${input.containerPort}`,
    requestHost: hostname,
    requestProtocol: 'https',
  };
}

function sendHttpRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
  },
  body = ''
): Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: options.headers,
    }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listen(server: { listen: (...args: unknown[]) => unknown; address: () => unknown }) {
  server.listen(0, '127.0.0.1');
  await once(server as never, 'listening');
}

async function closeServer(server: { close: (callback: (error?: Error) => void) => void; listening?: boolean }) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getPort(server: { address: () => unknown }) {
  const address = server.address();
  assert.ok(address && typeof address === 'object' && 'port' in address);
  return Number(address.port);
}

async function createGatewayServerTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-gateway-server-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer: path.join(dataRootContainer, 'gateway'),
    gatewayExposuresPath: path.join(dataRootContainer, 'gateway', 'exposures.json'),
    gatewayBaseDomain: 'example.test',
    hostPublicOrigin: 'https://host.example.test',
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}

function applyRuntimeEnv(config: HostRuntimeConfig) {
  const keys = [
    'HOST_DATA_ROOT_HOST',
    'HOST_DATA_ROOT_CONTAINER',
    'HOST_GATEWAY_BASE_DOMAIN',
    'HOST_PUBLIC_ORIGIN',
    'HOST_INTERNAL_ORIGIN',
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  process.env.HOST_DATA_ROOT_HOST = config.dataRootHost;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  process.env.HOST_GATEWAY_BASE_DOMAIN = config.gatewayBaseDomain || '';
  process.env.HOST_PUBLIC_ORIGIN = config.hostPublicOrigin || '';
  process.env.HOST_INTERNAL_ORIGIN = config.hostInternalOrigin || '';

  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

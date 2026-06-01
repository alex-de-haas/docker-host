import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type KeyLike,
} from 'jose';
import { hashToken } from './auth-crypto.ts';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import type { AuthTrustedProxyProviderRecord } from './auth-store.ts';
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
          Cookie: 'docker_host_session=host-session; docker_host_accounts=account-set; module_cookie=kept',
          'Cf-Access-Jwt-Assertion': 'trusted-proxy-assertion',
          Forwarded: 'for=10.0.0.1;proto=https;host=evil.example.test',
          'X-Forwarded-For': '10.0.0.1',
          'X-Forwarded-Host': 'evil.example.test',
          'X-Forwarded-Proto': 'gopher',
          'X-Real-Ip': '10.0.0.2',
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
      assert.equal(captured.headers['cf-access-jwt-assertion'], undefined);
      assert.equal(captured.headers.cookie, 'module_cookie=kept');
      assert.equal(captured.headers['x-docker-host-other'], undefined);
      assert.equal(captured.headers['x-custom'], 'kept');
      assert.equal(captured.headers.forwarded, undefined);
      assert.equal(captured.headers['x-real-ip'], undefined);
      assert.equal(captured.headers['x-forwarded-host'], 'reports.example.test');
      assert.equal(captured.headers['x-forwarded-proto'], 'https');
      assert.doesNotMatch(String(captured.headers['x-forwarded-for']), /10\.0\.0\.1/);

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
          'Cookie: docker_host_session=host-session; docker_host_accounts=account-set; module_cookie=kept',
          'X-Repeat: one',
          'X-Repeat: two',
          'Forwarded: for=10.0.0.1;host=evil.example.test',
          'X-Forwarded-For: 10.0.0.1',
          'X-Forwarded-Host: evil.example.test',
          'X-Forwarded-Proto: gopher',
          'X-Real-Ip: 10.0.0.2',
          'X-Docker-Host-Identity: spoofed-token',
          '',
          '',
        ].join('\r\n'));
      });
      client.on('error', () => undefined);
      const raw = await rawHandshake;
      client.destroy();

      assert.doesNotMatch(raw, /spoofed-token/);
      assert.doesNotMatch(raw, /docker_host_session/);
      assert.doesNotMatch(raw, /evil\.example\.test/);
      assert.doesNotMatch(raw, /gopher/);
      assert.doesNotMatch(raw, /^Forwarded:/mi);
      assert.doesNotMatch(raw, /^X-Real-Ip:/mi);
      assert.doesNotMatch(raw, /^X-Forwarded-For: 10\.0\.0\.1$/mi);
      assert.match(raw, /^Cookie: module_cookie=kept$/mi);
      assert.equal(raw.match(/^X-Repeat:/gmi)?.length, 2);
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

test('gateway resolves unavailable installed module as service unavailable', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config);
  await seedGatewayTargetFiles(config, { operationStatus: 'updating' });
  const { GatewayHttpError, resolveGatewayRequest } = await import('../../server.mjs');
  const resolver = createHttpServer((req, res) => {
    void resolveGatewayRequest(req).then(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('resolved');
    }).catch(error => {
      res.writeHead(error instanceof GatewayHttpError ? error.status : 500, { 'Content-Type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'resolve failed');
    });
  });

  try {
    await listen(resolver);
    const response = await sendHttpRequest(getPort(resolver), {
      headers: {
        Host: 'reports.example.test',
      },
    });

    assert.equal(response.statusCode, 503);
    assert.match(response.body, /not ready for gateway traffic/);
  } finally {
    restoreEnv();
    await closeServer(resolver);
  }
});

test('gateway reports unavailable data root when marker JSON is malformed', async () => {
  const config = await createGatewayServerTestConfig();
  const markerPath = path.join(config.dataRootContainer, '.docker-host-root.json');
  await fs.writeFile(markerPath, '{');
  const restoreEnv = applyRuntimeEnv(config, { dataRootMarker: 'root_expected' });
  const { GatewayHttpError, resolveGatewayRequest } = await import('../../server.mjs');

  try {
    await assert.rejects(
      resolveGatewayRequest({
        headers: {
          host: 'reports.example.test',
        },
      }),
      (error: unknown) => error instanceof GatewayHttpError &&
        error.status === 503 &&
        error.code === 'data_root_unavailable' &&
        /not valid JSON/.test(error.message)
    );
  } finally {
    restoreEnv();
  }
});

test('gateway trusted proxy mode requires assertion instead of browser session fallback', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config);
  const signing = await createTrustedProxySigningFixture();
  const sessionToken = 'dhs_gateway_session';
  const now = new Date();
  const localUser = {
    id: 'user_local',
    email: 'local@example.test',
    role: 'host.user' as const,
    authProvider: 'local' as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await seedGatewayTargetFiles(config);
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [localUser],
    sessions: [{
      id: 'session_local',
      userId: localUser.id,
      tokenHash: hashToken(sessionToken),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }],
    trustedProxyProviders: [trustedProxyProvider(signing.publicJwk)],
  }, config);

  const { resolveGatewayRequest } = await import('../../server.mjs');
  const resolver = createHttpServer((req, res) => {
    void resolveGatewayRequest(req).then(target => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allowed: target?.access.allowed,
        reason: target?.access.reason,
        principalId: target?.principal?.id ?? null,
      }));
    }).catch(error => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'resolve failed');
    });
  });

  try {
    await listen(resolver);

    const withoutAssertion = await sendHttpRequest(getPort(resolver), {
      headers: {
        Host: 'reports.example.test',
        Cookie: `docker_host_session=${encodeURIComponent(sessionToken)}`,
      },
    });
    assert.deepEqual(JSON.parse(withoutAssertion.body), {
      allowed: false,
      reason: 'loginRequired',
      principalId: null,
    });

    const assertion = await signTrustedProxyAssertion(signing.privateKey, {
      subject: 'proxy-user',
      groups: ['docker-host-users'],
      email: 'proxy@example.test',
      name: 'Proxy User',
    });
    const withAssertion = await sendHttpRequest(getPort(resolver), {
      headers: {
        Host: 'reports.example.test',
        'Cf-Access-Jwt-Assertion': assertion,
      },
    });
    const resolved = JSON.parse(withAssertion.body);
    assert.equal(resolved.allowed, true);
    assert.equal(resolved.reason, 'authenticated');
    assert.notEqual(resolved.principalId, null);
    assert.notEqual(resolved.principalId, localUser.id);
  } finally {
    restoreEnv();
    await closeServer(resolver);
  }
});

test('gateway developer target proxies to local override and keeps Host identity', async () => {
  const config = await createGatewayServerTestConfig();
  const restoreEnv = applyRuntimeEnv(config, { moduleDevMode: true });
  const { proxyHttpRequest, resolveGatewayRequest } = await import('../../server.mjs');
  const sessionToken = 'dhs_gateway_dev_session';
  const now = new Date();
  const user = {
    id: 'user_dev',
    email: 'dev@example.test',
    displayName: 'Dev User',
    role: 'host.user' as const,
    authProvider: 'local' as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string }> = [];
  const upstream = createHttpServer((req, res) => {
    upstreamRequests.push({
      headers: req.headers,
      url: req.url,
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('dev ok');
  });

  try {
    await listen(upstream);
    await fs.mkdir(path.join(config.dataRootContainer, 'dev'), { recursive: true });
    await fs.writeFile(path.join(config.dataRootContainer, 'dev', 'module-targets.json'), `${JSON.stringify({
      schemaVersion: '0.2',
      targets: [{
        id: 'mdev_reports',
        moduleId: 'com.example.reports',
        moduleName: 'Reports',
        moduleVersion: '1.0.0',
        metadataUrl: 'http://127.0.0.1/metadata.json',
        hostname: 'reports.example.test',
        portKey: 'web',
        targetBaseUrl: `http://127.0.0.1:${getPort(upstream)}/dev`,
        targetPathPrefix: '/dev',
        containerPort: 8080,
        protocol: 'http',
        exposurePolicy: 'loginRequired',
        identityMode: 'required',
        enabled: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }],
    }, null, 2)}\n`, 'utf-8');
    await writeAuthState({
      ...createEmptyAuthState(),
      users: [user],
      sessions: [{
        id: 'session_dev',
        userId: user.id,
        tokenHash: hashToken(sessionToken),
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        idleExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }],
    }, config);

    const proxy = createHttpServer((req, res) => {
      void resolveGatewayRequest(req).then(target => {
        assert.ok(target);
        assert.equal(target.developerMode, true);
        return proxyHttpRequest(req, res, target);
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'proxy failed');
      });
    });

    try {
      await listen(proxy);
      const response = await sendHttpRequest(getPort(proxy), {
        path: '/reports?range=day',
        headers: {
          Host: 'reports.example.test',
          Cookie: `docker_host_session=${encodeURIComponent(sessionToken)}`,
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'dev ok');
      assert.equal(upstreamRequests.length, 1);
      assert.equal(upstreamRequests[0]?.url, '/dev/reports?range=day');
      const identityToken = upstreamRequests[0]?.headers['x-docker-host-identity'];
      assert.equal(typeof identityToken, 'string');
      const verified = await jwtVerify(identityToken as string, createLocalJWKSet(await getModuleIdentityJwks(config)), {
        issuer: MODULE_IDENTITY_ISSUER,
        audience: 'com.example.reports',
      });
      assert.equal(verified.payload.sub, user.id);
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
      endpointKey: 'web',
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

async function seedGatewayTargetFiles(
  config: HostRuntimeConfig,
  options: { operationStatus?: string } = {}
) {
  const moduleId = 'com.example.reports';
  const moduleRoot = path.join(config.modulesRootContainer, moduleId);
  const metadataPath = path.join(moduleRoot, 'metadata.json');
  await fs.mkdir(moduleRoot, { recursive: true });
  await fs.mkdir(config.gatewayRootContainer, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify({
    schemaVersion: '0.2',
    hostSettings: {},
    modules: [{
      id: moduleId,
      metadataUrl: 'https://modules.example.test/reports.json',
      metadataPath,
      operationStatus: options.operationStatus || 'installed',
      containers: [{
        key: 'app',
        containerName: 'mod-com-example-reports-app',
        networkAlias: 'mod-com-example-reports-app',
        image: {
          repository: 'reports-module',
          tag: 'latest',
          reference: 'reports-module:latest',
          pullPolicy: 'ifNotPresent',
        },
      }],
    }],
  }, null, 2)}\n`, 'utf-8');
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: '0.2',
    id: moduleId,
    name: 'Reports',
    version: '1.0.0',
    containers: [{
      key: 'app',
      image: {
        repository: 'reports-module',
        tag: 'latest',
      },
      runtime: {
        ports: [{
          key: 'http',
          containerPort: 8080,
          protocol: 'http',
        }],
      },
    }],
    endpoints: [{
      key: 'web',
      container: 'app',
      port: 'http',
      public: true,
    }],
  }, null, 2)}\n`, 'utf-8');
  await fs.writeFile(config.gatewayExposuresPath, `${JSON.stringify({
    schemaVersion: '0.2',
    exposures: [{
      id: 'gw_reports',
      moduleId,
      hostname: 'reports.example.test',
      endpointKey: 'web',
      exposurePolicy: 'loginRequired',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2)}\n`, 'utf-8');
}

function trustedProxyProvider(jwk: JsonWebKey): AuthTrustedProxyProviderRecord {
  const now = new Date().toISOString();
  return {
    id: 'trusted_proxy_1',
    type: 'trusted-proxy',
    enabled: true,
    label: 'Cloudflare Access',
    issuer: 'https://access.example.test',
    audience: 'docker-host-audience',
    assertionHeader: 'cf-access-jwt-assertion',
    jwks: {
      keys: [jwk],
    },
    roleMappings: [{
      claim: 'groups',
      values: ['docker-host-users'],
      role: 'host.user',
    }],
    createdAt: now,
    updatedAt: now,
  };
}

async function createTrustedProxySigningFixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: {
      ...publicJwk,
      kid: 'trusted-proxy-test-key',
      alg: 'ES256',
      use: 'sig',
    },
  };
}

async function signTrustedProxyAssertion(
  privateKey: KeyLike,
  input: {
    subject: string;
    groups: string[];
    email?: string;
    name?: string;
  }
) {
  return await new SignJWT({
    groups: input.groups,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: 'trusted-proxy-test-key',
      typ: 'JWT',
    })
    .setIssuer('https://access.example.test')
    .setSubject(input.subject)
    .setAudience('docker-host-audience')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function createGatewayServerTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-gateway-server-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    dataRootMarkerPath: path.join(dataRootContainer, '.docker-host-root.json'),
    dataRootExpectedMarker: null,
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

function applyRuntimeEnv(config: HostRuntimeConfig, options: { moduleDevMode?: boolean; dataRootMarker?: string } = {}) {
  const keys = [
    'HOST_DATA_ROOT_HOST',
    'HOST_DATA_ROOT_CONTAINER',
    'HOST_DATA_ROOT_MARKER',
    'HOST_GATEWAY_BASE_DOMAIN',
    'HOST_PUBLIC_ORIGIN',
    'HOST_INTERNAL_ORIGIN',
    'HOST_MODULE_DEV_MODE',
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  process.env.HOST_DATA_ROOT_HOST = config.dataRootHost;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  process.env.HOST_DATA_ROOT_MARKER = options.dataRootMarker || '';
  process.env.HOST_GATEWAY_BASE_DOMAIN = config.gatewayBaseDomain || '';
  process.env.HOST_PUBLIC_ORIGIN = config.hostPublicOrigin || '';
  process.env.HOST_INTERNAL_ORIGIN = config.hostInternalOrigin || '';
  process.env.HOST_MODULE_DEV_MODE = options.moduleDevMode ? 'enabled' : '';

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

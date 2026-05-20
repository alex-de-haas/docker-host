import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { canAccessModule } from './auth-policy.ts';
import { SESSION_COOKIE_NAME } from './auth-service.ts';
import {
  HostAppEmbedError,
  appEmbedErrorResponse,
  buildAppEmbedUrl,
  buildEmbedUrl,
  normalizeEmbedModulePath,
  proxyHostAppEmbedRequest,
  rewriteEmbeddedContent,
  type HostAppEmbedTarget,
} from './app-embed-service.ts';
import {
  MODULE_IDENTITY_ISSUER,
  MODULE_IDENTITY_TOKEN_HEADER,
  getModuleIdentityJwks,
} from './module-identity.mjs';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostPrincipal } from '../types/auth.ts';

test('normalizes same-origin embedded module paths', () => {
  assert.equal(normalizeEmbedModulePath(null), '/');
  assert.equal(normalizeEmbedModulePath('/people?team=ops#active'), '/people?team=ops#active');
});

test('rejects unsafe embedded module paths', () => {
  for (const value of ['https://reports.example.test', '//reports.example.test', '/people\\admin', 'people']) {
    assert.throws(
      () => normalizeEmbedModulePath(value),
      (error: unknown) => error instanceof HostAppEmbedError && error.code === 'invalid_embed_path'
    );
  }
});

test('rewrites root-relative module links through reserved embed URLs', () => {
  const rewritten = rewriteEmbeddedContent(
    '<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script><a href="/people">People</a><img srcset="/a.png 1x, /b.png 2x"><style>.x{background:url(/hero.png)}</style>',
    {
      app: {
        id: 'com.example.reports',
        source: 'installed',
        moduleId: 'com.example.reports',
        displayName: 'Reports',
        version: '1.0.0',
        status: 'available',
        statusReason: 'available',
        accessMode: 'allAuthenticated',
        entryPath: '/apps/com.example.reports',
        embeddedUrl: buildEmbedUrl('com.example.reports', '/'),
        navigation: [],
      },
    }
  );

  assert.match(rewritten, /href="\/api\/apps\/com\.example\.reports\/embed\?path=%2F_next%2Fstatic%2Fapp\.css"/);
  assert.match(rewritten, /src="\/api\/apps\/com\.example\.reports\/embed\?path=%2F_next%2Fstatic%2Fapp\.js"/);
  assert.match(rewritten, /href="\/api\/apps\/com\.example\.reports\/embed\?path=%2Fpeople"/);
  assert.match(rewritten, /\/api\/apps\/com\.example\.reports\/embed\?path=%2Fa\.png 1x/);
  assert.match(rewritten, /url\(\/api\/apps\/com\.example\.reports\/embed\?path=%2Fhero\.png\)/);
});

test('builds reserved embed URLs for developer apps', () => {
  assert.equal(
    buildAppEmbedUrl({
      source: 'developer',
      moduleId: 'com.example.reports',
      developerTargetId: 'mdev_reports',
    }, '/people'),
    '/api/apps/dev/mdev_reports/embed?path=%2Fpeople'
  );
});

test('embed proxy strips Host-owned headers and injects a scoped identity token', async t => {
  const config = await createEmbedTestConfig();
  const target = createInstalledEmbedTarget(config);
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  let capturedHeaders = new Headers();

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    capturedHeaders = new Headers(init?.headers);
    return new Response('<a href="/people">People</a>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'module_session=abc; Domain=module.example.test; Path=/; HttpOnly',
      },
    });
  }) as typeof fetch;

  const request = new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2F', {
    headers: {
      authorization: 'Bearer cli-token',
      cookie: `${SESSION_COOKIE_NAME}=host-session; module_cookie=kept`,
      'cf-access-jwt-assertion': 'trusted-proxy-assertion',
      'x-docker-host-identity': 'spoofed-token',
      'x-docker-host-other': 'spoofed',
      'x-custom': 'kept',
    },
  });

  const response = await proxyHostAppEmbedRequest(request, target);
  const body = await response.text();

  assert.equal(capturedUrl, 'http://mod-com-example-reports:3000/');
  assert.equal(capturedHeaders.get('authorization'), null);
  assert.equal(capturedHeaders.get('cookie'), 'module_cookie=kept');
  assert.equal(capturedHeaders.get('cf-access-jwt-assertion'), null);
  assert.equal(capturedHeaders.get('x-docker-host-other'), null);
  assert.equal(capturedHeaders.get('x-custom'), 'kept');
  assert.equal(capturedHeaders.get('x-forwarded-host'), 'host.example.test');
  assert.equal(capturedHeaders.get('x-forwarded-proto'), 'https');
  assert.notEqual(capturedHeaders.get(MODULE_IDENTITY_TOKEN_HEADER), 'spoofed-token');

  const identityToken = capturedHeaders.get(MODULE_IDENTITY_TOKEN_HEADER);
  assert.equal(typeof identityToken, 'string');
  const verified = await jwtVerify(identityToken!, createLocalJWKSet(await getModuleIdentityJwks(config)), {
    issuer: MODULE_IDENTITY_ISSUER,
    audience: 'com.example.reports',
  });
  assert.equal(verified.payload.sub, 'user_1');
  assert.equal(verified.payload.moduleAccess, 'authenticated');

  assert.match(body, /\/api\/apps\/com\.example\.reports\/embed\?path=%2Fpeople/);
  assert.equal(response.headers.get('set-cookie'), 'module_session=abc; HttpOnly; Path=/api/apps/com.example.reports/embed');
});

test('embed proxy returns a blocked iframe fallback when module headers deny framing', async t => {
  const config = await createEmbedTestConfig();
  const target = createInstalledEmbedTarget(config);
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response('<h1>Blocked</h1>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
    },
  })) as typeof fetch;

  const response = await proxyHostAppEmbedRequest(
    new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2F'),
    target
  );
  const body = await response.text();

  assert.equal(response.status, 409);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(body, /Module UI cannot be embedded/);
  assert.match(body, /X-Frame-Options: DENY/);
});

test('renders authenticated embed failures as iframe-friendly HTML', async t => {
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
  });
  console.error = () => undefined;

  const response = appEmbedErrorResponse(new Error('Module gateway target is unavailable.'));
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(body, /Module UI unavailable/);
  assert.match(body, /Module gateway target is unavailable/);
});

async function createEmbedTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-embed-service-'));
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

function createInstalledEmbedTarget(config: HostRuntimeConfig): HostAppEmbedTarget {
  const principal: HostPrincipal = {
    id: 'user_1',
    role: 'host.user',
    email: 'user@example.test',
  };

  return {
    app: {
      id: 'com.example.reports',
      source: 'installed',
      moduleId: 'com.example.reports',
      displayName: 'Reports',
      version: '1.0.0',
      status: 'available',
      statusReason: 'available',
      accessMode: 'allAuthenticated',
      entryPath: '/apps/com.example.reports',
      embeddedUrl: buildEmbedUrl('com.example.reports', '/'),
      navigation: [],
    },
    config,
    modulePath: '/',
    targetOrigin: 'http://mod-com-example-reports:3000',
    upstreamUrl: 'http://mod-com-example-reports:3000/',
    requestHost: 'host.example.test',
    requestProtocol: 'https',
    identityInput: {
      exposure: {
        id: 'shell_com.example.reports',
        moduleId: 'com.example.reports',
        hostname: 'host.example.test',
        portKey: 'http',
        exposurePolicy: 'loginRequired',
        identityMode: 'required',
      },
      access: canAccessModule({
        principal,
        moduleId: 'com.example.reports',
        exposurePolicy: 'loginRequired',
        assignments: [],
      }),
      principal,
    },
  };
}

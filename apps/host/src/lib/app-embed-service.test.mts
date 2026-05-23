import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { canAccessModule } from './auth-policy.ts';
import { ACCOUNT_SET_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth-service.ts';
import {
  HostAppEmbedError,
  appEmbedErrorResponse,
  buildAppEmbedUrl,
  buildEmbedUrl,
  getInstalledEmbedModulePathFromRequest,
  isHostAppEmbedStaticAssetRequest,
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

test('extracts path-shaped and legacy embedded module paths', () => {
  assert.equal(
    getInstalledEmbedModulePathFromRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed/_next/static/chunks/app.js?embedToken=token'),
      'com.example.reports'
    ),
    '/_next/static/chunks/app.js'
  );
  assert.equal(
    getInstalledEmbedModulePathFromRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed/release-planner?_rsc=abc&embedToken=token'),
      'com.example.reports'
    ),
    '/release-planner?_rsc=abc'
  );
  assert.equal(
    getInstalledEmbedModulePathFromRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2Fpeople%3Fteam%3Dops&embedToken=token'),
      'com.example.reports'
    ),
    '/people?team=ops'
  );
});

test('rejects unsafe embedded module paths', () => {
  for (const value of ['https://reports.example.test', '//reports.example.test', '/people\\admin', 'people']) {
    assert.throws(
      () => normalizeEmbedModulePath(value),
      (error: unknown) => error instanceof HostAppEmbedError && error.code === 'invalid_embed_path'
    );
  }
});

test('recognizes static framework assets embedded from sandboxed module UIs', () => {
  assert.equal(
    isHostAppEmbedStaticAssetRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2F_next%2Fstatic%2Fapp.css')
    ),
    true
  );
  assert.equal(
    isHostAppEmbedStaticAssetRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed/_next/static/app.css')
    ),
    true
  );
  assert.equal(
    isHostAppEmbedStaticAssetRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2Fpeople')
    ),
    false
  );
  assert.equal(
    isHostAppEmbedStaticAssetRequest(
      new Request('https://host.example.test/api/apps/com.example.reports/embed?path=%2F_next%2Fstatic%2Fapp.css', {
        method: 'POST',
      })
    ),
    false
  );
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

  assert.match(rewritten, /href="\/api\/apps\/com\.example\.reports\/embed\/_next\/static\/app\.css"/);
  assert.match(rewritten, /src="\/api\/apps\/com\.example\.reports\/embed\/_next\/static\/app\.js"/);
  assert.match(rewritten, /href="\/api\/apps\/com\.example\.reports\/embed\/people"/);
  assert.match(rewritten, /\/api\/apps\/com\.example\.reports\/embed\/a\.png 1x/);
  assert.match(rewritten, /url\(\/api\/apps\/com\.example\.reports\/embed\/hero\.png\)/);
});

test('leaves inline scripts unchanged while rewriting tag attributes and style content', () => {
  const rewritten = rewriteEmbeddedContent(
    '<script src="/_next/static/app.js"></script><script>const html = \'<a href="/people">People</a>\'; const image = "url(/hero.png)";</script><div style="background:url(/tile.png)"></div><style>.hero{background:url(/hero.png)}</style>',
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

  assert.match(rewritten, /src="\/api\/apps\/com\.example\.reports\/embed\/_next\/static\/app\.js"/);
  assert.match(rewritten, /<script>const html = '<a href="\/people">People<\/a>'; const image = "url\(\/hero\.png\)";<\/script>/);
  assert.match(rewritten, /style="background:url\(\/api\/apps\/com\.example\.reports\/embed\/tile\.png\)"/);
  assert.match(rewritten, /\.hero\{background:url\(\/api\/apps\/com\.example\.reports\/embed\/hero\.png\)\}/);
});

test('builds reserved embed URLs for developer apps', () => {
  assert.equal(
    buildAppEmbedUrl({
      source: 'developer',
      moduleId: 'com.example.reports',
      developerTargetId: 'mdev_reports',
    }, '/people'),
    '/api/apps/dev/mdev_reports/embed/people'
  );
  assert.equal(
    buildAppEmbedUrl({
      source: 'developer',
      moduleId: 'com.example.reports',
      developerTargetId: 'mdev_reports',
    }, '/people?team=ops'),
    '/api/apps/dev/mdev_reports/embed/people?team=ops'
  );
});

test('proxies a minimal Next Turbopack-shaped fixture with path-shaped assets and RSC', async t => {
  const config = await createEmbedTestConfig();
  const target = createInstalledEmbedTarget(config);
  const originalFetch = globalThis.fetch;
  const upstreamRequests: string[] = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const upstreamUrl = input instanceof Request ? input.url : String(input);
    upstreamRequests.push(upstreamUrl);
    const parsed = new URL(upstreamUrl);
    const pathAndSearch = `${parsed.pathname}${parsed.search}`;

    if (parsed.pathname === '/') {
      return new Response(`<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/_next/static/css/app.css">
  <script src="/_next/static/chunks/turbopack-runtime.js"></script>
  <script src="/_next/static/chunks/dynamic.js"></script>
</head>
<body><main id="app">Loading</main><a href="/release-planner">Release planner</a></body>
</html>`, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });
    }

    if (parsed.pathname === '/_next/static/css/app.css') {
      return new Response('main { color: rgb(0, 128, 0); background: url(/font.woff2); }', {
        status: 200,
        headers: {
          'content-type': 'text/css',
        },
      });
    }

    if (parsed.pathname === '/_next/static/chunks/turbopack-runtime.js') {
      return new Response(`
var scriptUrl = new URL(document.currentScript.src);
if (!scriptUrl.pathname.includes('/_next/')) throw new Error('missing _next in currentScript pathname');
if (!scriptUrl.pathname.endsWith('.js')) throw new Error('script pathname does not end in .js');
globalThis.__fixtureHydrated = true;
`, {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
        },
      });
    }

    if (parsed.pathname === '/_next/static/chunks/dynamic.js') {
      return new Response(`
var scriptUrl = new URL(document.currentScript.src);
if (!scriptUrl.pathname.endsWith('.js')) throw new Error('dynamic chunk type was not inferable');
globalThis.__fixtureDynamicChunkLoaded = true;
`, {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
        },
      });
    }

    if (pathAndSearch === '/release-planner?_rsc=fixture') {
      return new Response('1:["$","main",null,{"children":"Release planner"}]', {
        status: 200,
        headers: {
          'content-type': 'text/x-component',
        },
      });
    }

    return new Response(`unexpected upstream path ${pathAndSearch}`, { status: 404 });
  }) as typeof fetch;

  const initialResponse = await proxyHostAppEmbedRequest(
    new Request('https://host.example.test/api/apps/com.example.reports/embed/'),
    target
  );
  const initialHtml = await initialResponse.text();
  const embedToken = /embedToken=([^"&]+)/.exec(initialHtml)?.[1];
  assert.equal(initialResponse.status, 200);
  assert.equal(typeof embedToken, 'string');
  assert.match(initialHtml, /id="__docker-host-embed-runtime"/);
  assert.match(initialHtml, /href="\/api\/apps\/com\.example\.reports\/embed\/_next\/static\/css\/app\.css\?embedToken=/);
  assert.match(initialHtml, /src="\/api\/apps\/com\.example\.reports\/embed\/_next\/static\/chunks\/turbopack-runtime\.js\?embedToken=/);
  assert.match(initialHtml, /href="\/api\/apps\/com\.example\.reports\/embed\/release-planner\?embedToken=/);
  assert.deepEqual(
    await executeInjectedFetchRewrite(initialHtml, '/release-planner?_rsc=fixture'),
    [`/api/apps/com.example.reports/embed/release-planner?_rsc=fixture&embedToken=${embedToken}`]
  );

  const scriptContext = createFixtureScriptContext();
  for (const scriptSrc of extractAttributeValues(initialHtml, 'script', 'src')) {
    const chunkResponse = await proxyHostAppEmbedRequest(
      new Request(new URL(scriptSrc, 'https://host.example.test')),
      createInstalledEmbedTarget(config, getInstalledEmbedModulePathFromRequest(
        new Request(new URL(scriptSrc, 'https://host.example.test')),
        'com.example.reports'
      ))
    );
    scriptContext.document.currentScript.src = new URL(scriptSrc, 'https://host.example.test').toString();
    runInNewContext(await chunkResponse.text(), scriptContext);
  }

  assert.equal(scriptContext.__fixtureHydrated, true);
  assert.equal(scriptContext.__fixtureDynamicChunkLoaded, true);

  const stylesheetHref = extractAttributeValues(initialHtml, 'link', 'href')[0];
  assert.equal(typeof stylesheetHref, 'string');
  const cssResponse = await proxyHostAppEmbedRequest(
    new Request(new URL(stylesheetHref!, 'https://host.example.test')),
    createInstalledEmbedTarget(config, getInstalledEmbedModulePathFromRequest(
      new Request(new URL(stylesheetHref!, 'https://host.example.test')),
      'com.example.reports'
    ))
  );
  assert.equal(cssResponse.status, 200);
  const cssBody = await cssResponse.text();
  assert.match(cssBody, /rgb\(0, 128, 0\)/);
  assert.match(cssBody, /url\(\/api\/apps\/com\.example\.reports\/embed\/font\.woff2\?embedToken=/);

  const rscUrl = `https://host.example.test/api/apps/com.example.reports/embed/release-planner?_rsc=fixture&embedToken=${embedToken}`;
  const rscResponse = await proxyHostAppEmbedRequest(
    new Request(rscUrl),
    createInstalledEmbedTarget(config, getInstalledEmbedModulePathFromRequest(
      new Request(rscUrl),
      'com.example.reports'
    ))
  );
  assert.equal(rscResponse.status, 200);
  assert.match(await rscResponse.text(), /Release planner/);
  assert.deepEqual(upstreamRequests, [
    'http://mod-com-example-reports:3000/',
    'http://mod-com-example-reports:3000/_next/static/chunks/turbopack-runtime.js',
    'http://mod-com-example-reports:3000/_next/static/chunks/dynamic.js',
    'http://mod-com-example-reports:3000/_next/static/css/app.css',
    'http://mod-com-example-reports:3000/release-planner?_rsc=fixture',
  ]);
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
      cookie: `${SESSION_COOKIE_NAME}=host-session; ${ACCOUNT_SET_COOKIE_NAME}=account-set; module_cookie=kept`,
      'cf-access-jwt-assertion': 'trusted-proxy-assertion',
      forwarded: 'for=10.0.0.1;proto=https;host=evil.example.test',
      'x-forwarded-for': '10.0.0.1',
      'x-forwarded-host': 'evil.example.test',
      'x-forwarded-proto': 'gopher',
      'x-real-ip': '10.0.0.2',
      'x-docker-host-remote-address': '203.0.113.10',
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
  assert.equal(capturedHeaders.get('forwarded'), null);
  assert.equal(capturedHeaders.get('x-docker-host-other'), null);
  assert.equal(capturedHeaders.get('x-real-ip'), null);
  assert.equal(capturedHeaders.get('x-custom'), 'kept');
  assert.equal(capturedHeaders.get('x-forwarded-host'), 'host.example.test');
  assert.equal(capturedHeaders.get('x-forwarded-proto'), 'https');
  assert.equal(capturedHeaders.get('x-forwarded-for'), '203.0.113.10');
  assert.notEqual(capturedHeaders.get(MODULE_IDENTITY_TOKEN_HEADER), 'spoofed-token');

  const identityToken = capturedHeaders.get(MODULE_IDENTITY_TOKEN_HEADER);
  assert.equal(typeof identityToken, 'string');
  const verified = await jwtVerify(identityToken!, createLocalJWKSet(await getModuleIdentityJwks(config)), {
    issuer: MODULE_IDENTITY_ISSUER,
    audience: 'com.example.reports',
  });
  assert.equal(verified.payload.sub, 'user_1');
  assert.equal(verified.payload.moduleAccess, 'authenticated');

  assert.match(body, /\/api\/apps\/com\.example\.reports\/embed\/people\?embedToken=/);
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

function createInstalledEmbedTarget(config: HostRuntimeConfig, modulePath = '/'): HostAppEmbedTarget {
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
    modulePath,
    targetOrigin: 'http://mod-com-example-reports:3000',
    upstreamUrl: new URL(modulePath, 'http://mod-com-example-reports:3000').toString(),
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

function extractAttributeValues(html: string, tagName: string, attributeName: string) {
  const values: string[] = [];
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const tagMatch of html.matchAll(tagPattern)) {
    const tag = tagMatch[0];
    const attributePattern = new RegExp(`\\b${attributeName}=(["'])(.*?)\\1`, 'i');
    const attributeMatch = attributePattern.exec(tag);
    if (attributeMatch?.[2]) {
      values.push(attributeMatch[2]);
    }
  }

  return values;
}

function createFixtureScriptContext() {
  const context: {
    URL: typeof URL;
    document: { currentScript: { src: string } };
    __fixtureHydrated: boolean;
    __fixtureDynamicChunkLoaded: boolean;
    globalThis?: unknown;
  } = {
    URL,
    document: {
      currentScript: {
        src: '',
      },
    },
    __fixtureHydrated: false,
    __fixtureDynamicChunkLoaded: false,
  };

  context.globalThis = context;
  return context;
}

async function executeInjectedFetchRewrite(html: string, input: string) {
  const script = /<script id="__docker-host-embed-runtime">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.equal(typeof script, 'string');

  const fetchCalls: string[] = [];
  const window = {
    location: {
      href: 'https://host.example.test/api/apps/com.example.reports/embed/',
      origin: 'https://host.example.test',
    },
    fetch: async (fetchInput: RequestInfo | URL) => {
      fetchCalls.push(fetchInput instanceof Request ? fetchInput.url : String(fetchInput));
      return new Response('ok');
    },
    XMLHttpRequest: undefined,
  };

  runInNewContext(script!, {
    window,
    URL,
    Request,
    Response,
  });
  await window.fetch(input);
  return fetchCalls;
}

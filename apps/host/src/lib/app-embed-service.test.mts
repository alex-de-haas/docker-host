import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HostAppEmbedError,
  appEmbedErrorResponse,
  buildAppEmbedUrl,
  buildEmbedUrl,
  normalizeEmbedModulePath,
  rewriteEmbeddedContent,
} from './app-embed-service.ts';

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

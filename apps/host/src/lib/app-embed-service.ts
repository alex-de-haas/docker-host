import { NextResponse } from 'next/server.js';
import { canAccessModule } from './auth-policy.ts';
import { SESSION_COOKIE_NAME } from './auth-service.ts';
import { readAuthStateSnapshot } from './auth-store.ts';
import { listHostApps } from './app-registry-service.ts';
import { getModuleNetworkAlias } from './gateway-service.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import { validateModuleUiMetadata } from './module-metadata.ts';
import { readModuleDevTargetStateSnapshot } from './module-dev-store.ts';
import {
  readModuleMetadata,
  readModulesStoreSnapshot,
} from './module-store.ts';
import {
  MODULE_IDENTITY_TOKEN_HEADER,
  createModuleIdentityToken,
} from './module-identity.mjs';
import { TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS } from './trusted-proxy.mjs';
import type { ListHostAppsOptions } from './app-registry-service.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostPrincipal, ModuleExposurePolicy } from '../types/auth.ts';
import type { HostAppAccessMode, HostAppEntry } from '../types/apps.ts';
import type { ModuleIdentityMode } from '../types/gateway.ts';
import type { ModuleDevTargetRecord } from '../types/module-dev.ts';
import type {
  InstalledModuleRecord,
  ModuleRuntimePortMetadata,
} from '../types/modules.ts';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const REWRITABLE_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'application/xhtml+xml',
];
const MAX_EMBED_PATH_LENGTH = 2048;

export interface HostAppEmbedTarget {
  app: HostAppEntry;
  installedModule?: InstalledModuleRecord;
  port?: ModuleRuntimePortMetadata;
  config: HostRuntimeConfig;
  modulePath: string;
  targetOrigin: string;
  targetPathPrefix?: string;
  upstreamUrl: string;
  requestHost: string;
  requestProtocol: string;
  identityInput: {
    exposure: {
      id: string;
      moduleId: string;
      hostname: string;
      portKey: string;
      exposurePolicy: ModuleExposurePolicy;
      identityMode: ModuleIdentityMode;
    };
    access: ReturnType<typeof canAccessModule>;
    principal: HostPrincipal;
  };
}

export class HostAppEmbedError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'HostAppEmbedError';
    this.code = code;
    this.status = status;
  }
}

export async function resolveHostAppEmbedTarget(
  request: Request,
  principal: HostPrincipal,
  moduleId: string,
  options: ListHostAppsOptions & { config?: HostRuntimeConfig } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = normalizeEmbedModulePath(new URL(request.url).searchParams.get('path'));
  const apps = await listHostApps(principal, {
    ...options,
    config,
  });
  const app = apps.find(candidate =>
    candidate.source === 'installed' &&
    candidate.moduleId === moduleId
  );

  if (!app) {
    throw new HostAppEmbedError(
      'app_not_found',
      `Module app "${moduleId}" is not registered for the current Host principal.`,
      404
    );
  }

  if (app.status !== 'available') {
    throw new HostAppEmbedError(
      'app_unavailable',
      `Module app "${moduleId}" is not available.`,
      503
    );
  }

  const store = await readModulesStoreSnapshot(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);
  if (!installedModule) {
    throw new HostAppEmbedError('module_not_found', `Module "${moduleId}" is not installed.`, 404);
  }

  const metadata = await readModuleMetadata(installedModule, config);
  const ui = metadata?.ui
    ? validateModuleUiMetadata(metadata.ui, '$.ui', metadata.runtime?.ports ?? [], [], moduleId)
    : null;
  if (!metadata || !ui) {
    throw new HostAppEmbedError('metadata_invalid', `Module "${moduleId}" does not have valid UI metadata.`, 503);
  }

  const port = metadata.runtime?.ports?.find(candidate => candidate.key === ui.entrypoint.portKey);
  if (!port) {
    throw new HostAppEmbedError('ui_port_missing', `Module "${moduleId}" UI port is missing.`, 503);
  }

  const networkAlias = getModuleNetworkAlias(moduleId);
  const targetOrigin = `http://${networkAlias}:${port.containerPort}`;
  const upstreamUrl = new URL(modulePath, targetOrigin).toString();
  const requestHost = getRequestHost(request);
  const requestProtocol = getRequestProtocol(request);
  const exposurePolicy = getExposurePolicy(app.accessMode);

  return {
    app,
    installedModule,
    port,
    config,
    modulePath,
    targetOrigin,
    upstreamUrl,
    requestHost,
    requestProtocol,
    identityInput: {
      exposure: {
        id: `shell_${moduleId}`,
        moduleId,
        hostname: requestHost,
        portKey: ui.entrypoint.portKey,
        exposurePolicy,
        identityMode: 'required',
      },
      access: canAccessModule({
        principal,
        moduleId,
        exposurePolicy,
        assignments: app.accessMode === 'assignedUsersOnly' && principal.role !== 'host.admin'
          ? [principal.id]
          : [],
      }),
      principal,
    },
  };
}

export async function resolveHostDeveloperAppEmbedTarget(
  request: Request,
  principal: HostPrincipal,
  targetId: string,
  options: ListHostAppsOptions & { config?: HostRuntimeConfig } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = normalizeEmbedModulePath(new URL(request.url).searchParams.get('path'));
  const apps = await listHostApps(principal, {
    ...options,
    config,
  });
  const app = apps.find(candidate =>
    candidate.source === 'developer' &&
    candidate.developerTargetId === targetId
  );

  if (!app) {
    throw new HostAppEmbedError(
      'app_not_found',
      `Developer module app "${targetId}" is not registered for the current Host principal.`,
      404
    );
  }

  if (app.status !== 'available') {
    throw new HostAppEmbedError(
      'app_unavailable',
      `Developer module app "${targetId}" is not available.`,
      503
    );
  }

  const developerTarget = await readEnabledDeveloperTarget(targetId, config);
  if (!developerTarget?.shellApp) {
    throw new HostAppEmbedError(
      'developer_target_not_found',
      `Developer module app "${targetId}" is not available.`,
      404
    );
  }

  const requestHost = getRequestHost(request);
  const requestProtocol = getRequestProtocol(request);
  const authState = await readAuthStateSnapshot(config);
  const access = canAccessModule({
    principal,
    moduleId: developerTarget.moduleId,
    exposurePolicy: developerTarget.exposurePolicy,
    assignments: authState.moduleAssignments,
  });

  return {
    app,
    config,
    modulePath,
    targetOrigin: new URL(developerTarget.targetBaseUrl).origin,
    targetPathPrefix: developerTarget.targetPathPrefix,
    upstreamUrl: buildDeveloperUpstreamUrl(developerTarget, modulePath),
    requestHost,
    requestProtocol,
    identityInput: {
      exposure: {
        id: developerTarget.id,
        moduleId: developerTarget.moduleId,
        hostname: requestHost,
        portKey: developerTarget.portKey,
        exposurePolicy: developerTarget.exposurePolicy,
        identityMode: developerTarget.identityMode,
      },
      access,
      principal,
    },
  };
}

export async function proxyHostAppEmbedRequest(
  request: Request,
  target: HostAppEmbedTarget
) {
  const identityToken = await createModuleIdentityToken(target.identityInput, target.config);
  const headers = buildEmbedRequestHeaders(request, target, identityToken);
  const method = request.method.toUpperCase();
  const response = await fetch(target.upstreamUrl, {
    method,
    headers,
    redirect: 'manual',
    body: method === 'GET' || method === 'HEAD'
      ? undefined
      : await request.arrayBuffer(),
  });

  return await buildEmbedResponse(request, response, target);
}

export function normalizeEmbedModulePath(value: string | null) {
  const path = value || '/';
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.length > MAX_EMBED_PATH_LENGTH
  ) {
    throw new HostAppEmbedError(
      'invalid_embed_path',
      'Embedded module UI path must be a same-origin absolute path.',
      400
    );
  }

  return path;
}

export function rewriteEmbeddedContent(
  content: string,
  target: Pick<HostAppEmbedTarget, 'app'>
) {
  const toEmbedPath = (modulePath: string) => buildAppEmbedUrl(target.app, modulePath);

  return rewriteHtmlFragment(content, toEmbedPath);
}

function rewriteHtmlFragment(
  content: string,
  toEmbedPath: (modulePath: string) => string
) {
  let result = '';
  let offset = 0;

  while (offset < content.length) {
    const tagStart = content.indexOf('<', offset);
    if (tagStart === -1) {
      result += content.slice(offset);
      break;
    }

    result += content.slice(offset, tagStart);

    if (content.startsWith('<!--', tagStart)) {
      const commentEnd = content.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) {
        result += content.slice(tagStart);
        break;
      }

      result += content.slice(tagStart, commentEnd + 3);
      offset = commentEnd + 3;
      continue;
    }

    const tagEnd = findHtmlTagEnd(content, tagStart);
    if (tagEnd === -1) {
      result += content.slice(tagStart);
      break;
    }

    const tag = content.slice(tagStart, tagEnd + 1);
    const tagName = getHtmlTagName(tag);
    result += rewriteHtmlTagAttributes(tag, toEmbedPath);
    offset = tagEnd + 1;

    if (!tagName || isClosingHtmlTag(tag) || isSelfClosingHtmlTag(tag)) {
      continue;
    }

    if (tagName === 'script') {
      const rawText = readRawTextElement(content, offset, tagName);
      if (rawText) {
        result += rawText.body + rawText.closingTag;
        offset = rawText.nextOffset;
      }
      continue;
    }

    if (tagName === 'style') {
      const rawText = readRawTextElement(content, offset, tagName);
      if (rawText) {
        result += rewriteCssUrls(rawText.body, toEmbedPath) + rawText.closingTag;
        offset = rawText.nextOffset;
      }
    }
  }

  return result;
}

function findHtmlTagEnd(content: string, tagStart: number) {
  let quote: '"' | "'" | null = null;
  for (let index = tagStart + 1; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '>') {
      return index;
    }
  }

  return -1;
}

function getHtmlTagName(tag: string) {
  return /^<\s*\/?\s*([a-z][\w:-]*)/i.exec(tag)?.[1]?.toLowerCase() ?? null;
}

function isClosingHtmlTag(tag: string) {
  return /^<\s*\//.test(tag);
}

function isSelfClosingHtmlTag(tag: string) {
  return /\/\s*>$/.test(tag);
}

function readRawTextElement(content: string, bodyStart: number, tagName: string) {
  const lowerContent = content.toLowerCase();
  const closingStart = lowerContent.indexOf(`</${tagName}`, bodyStart);
  if (closingStart === -1) {
    return null;
  }

  const closingEnd = findHtmlTagEnd(content, closingStart);
  if (closingEnd === -1) {
    return null;
  }

  return {
    body: content.slice(bodyStart, closingStart),
    closingTag: content.slice(closingStart, closingEnd + 1),
    nextOffset: closingEnd + 1,
  };
}

function rewriteHtmlTagAttributes(
  tag: string,
  toEmbedPath: (modulePath: string) => string
) {
  const tagNameMatch = /^<\s*\/?\s*[a-z][\w:-]*/i.exec(tag);
  if (!tagNameMatch) {
    return tag;
  }

  let result = tag.slice(0, tagNameMatch[0].length);
  let offset = tagNameMatch[0].length;

  while (offset < tag.length) {
    const char = tag[offset];
    if (!char || char === '>' || char === '/') {
      result += tag.slice(offset);
      break;
    }

    if (/\s/.test(char)) {
      result += char;
      offset += 1;
      continue;
    }

    const nameStart = offset;
    while (offset < tag.length && !/[\s=/>]/.test(tag[offset] ?? '')) {
      offset += 1;
    }

    const name = tag.slice(nameStart, offset);
    result += name;

    while (offset < tag.length && /\s/.test(tag[offset] ?? '')) {
      result += tag[offset];
      offset += 1;
    }

    if (tag[offset] !== '=') {
      continue;
    }

    result += '=';
    offset += 1;

    while (offset < tag.length && /\s/.test(tag[offset] ?? '')) {
      result += tag[offset];
      offset += 1;
    }

    const quote = tag[offset];
    if (quote === '"' || quote === "'") {
      const valueStart = offset + 1;
      const valueEnd = tag.indexOf(quote, valueStart);
      if (valueEnd === -1) {
        result += tag.slice(offset);
        break;
      }

      const value = tag.slice(valueStart, valueEnd);
      result += `${quote}${rewriteHtmlAttributeValue(name, value, toEmbedPath)}${quote}`;
      offset = valueEnd + 1;
      continue;
    }

    const valueStart = offset;
    while (offset < tag.length && !/[\s>]/.test(tag[offset] ?? '')) {
      offset += 1;
    }

    const value = tag.slice(valueStart, offset);
    result += rewriteHtmlAttributeValue(name, value, toEmbedPath);
  }

  return result;
}

function rewriteHtmlAttributeValue(
  name: string,
  value: string,
  toEmbedPath: (modulePath: string) => string
) {
  switch (name.toLowerCase()) {
    case 'href':
    case 'src':
    case 'action':
      return rewriteRootRelativeUrl(value, toEmbedPath);
    case 'srcset':
      return rewriteSrcSet(value, toEmbedPath);
    case 'style':
      return rewriteCssUrls(value, toEmbedPath);
    default:
      return value;
  }
}

function rewriteRootRelativeUrl(
  value: string,
  toEmbedPath: (modulePath: string) => string
) {
  return value.startsWith('/') && !value.startsWith('//')
    ? toEmbedPath(value)
    : value;
}

function rewriteCssUrls(
  value: string,
  toEmbedPath: (modulePath: string) => string
) {
  return value.replace(/url\((["']?)\/(?!\/)([^)"']+)\1\)/g, (_match, quote: string, path: string) => (
    `url(${quote}${toEmbedPath(`/${path}`)}${quote})`
  ));
}

export function buildEmbedUrl(moduleId: string, modulePath: string) {
  return `/api/apps/${encodeURIComponent(moduleId)}/embed?path=${encodeURIComponent(modulePath)}`;
}

export function buildDeveloperEmbedUrl(targetId: string, modulePath: string) {
  return `/api/apps/dev/${encodeURIComponent(targetId)}/embed?path=${encodeURIComponent(modulePath)}`;
}

export function buildAppEmbedUrl(app: Pick<HostAppEntry, 'source' | 'moduleId' | 'developerTargetId'>, modulePath: string) {
  return app.source === 'developer' && app.developerTargetId
    ? buildDeveloperEmbedUrl(app.developerTargetId, modulePath)
    : buildEmbedUrl(app.moduleId, modulePath);
}

export function appEmbedErrorResponse(error: unknown) {
  if (error instanceof HostAppEmbedError) {
    return embedErrorHtmlResponse(error.status, error.message);
  }

  console.error('Host app embed failed:', error);
  return embedErrorHtmlResponse(
    502,
    error instanceof Error ? error.message : 'Unknown app embed error'
  );
}

function buildEmbedRequestHeaders(
  request: Request,
  target: HostAppEmbedTarget,
  identityToken: string | null
) {
  const headers = new Headers();
  const trustedProxyAssertionHeaders = new Set(
    TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS.map(header => header.toLowerCase())
  );

  request.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === 'authorization' ||
      lowerName === 'host' ||
      lowerName === 'content-length' ||
      lowerName === 'accept-encoding'
    ) {
      return;
    }

    if (lowerName.startsWith('x-docker-host-') || trustedProxyAssertionHeaders.has(lowerName)) {
      return;
    }

    if (lowerName === 'cookie') {
      const cookie = stripCookieValue(value, SESSION_COOKIE_NAME);
      if (cookie) {
        headers.set(name, cookie);
      }
      return;
    }

    headers.set(name, value);
  });

  headers.set('x-forwarded-host', target.requestHost);
  headers.set('x-forwarded-proto', target.requestProtocol);
  headers.set('x-forwarded-for', appendForwardedFor(request));

  if (identityToken) {
    headers.set(MODULE_IDENTITY_TOKEN_HEADER, identityToken);
  }

  return headers;
}

async function buildEmbedResponse(
  request: Request,
  response: Response,
  target: HostAppEmbedTarget
) {
  const frameBlockReason = getFrameBlockReason(response.headers);
  if (frameBlockReason) {
    return new NextResponse(renderFrameBlockedHtml(target, frameBlockReason), {
      status: 409,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const headers = buildEmbedResponseHeaders(request, response.headers, target);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (shouldRewriteContent(contentType)) {
    const body = rewriteEmbeddedContent(await response.text(), target);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new NextResponse(request.method.toUpperCase() === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildEmbedResponseHeaders(
  request: Request,
  responseHeaders: Headers,
  target: HostAppEmbedTarget
) {
  const headers = new Headers();
  responseHeaders.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === 'content-length' ||
      lowerName === 'content-encoding'
    ) {
      return;
    }

    if (lowerName === 'location') {
      headers.set(name, rewriteLocationHeader(value, request, target));
      return;
    }

    if (lowerName === 'set-cookie') {
      headers.set(name, rewriteSetCookieHeader(value, target.app));
      return;
    }

    headers.set(name, value);
  });

  headers.set('cache-control', 'no-store');
  return headers;
}

function shouldRewriteContent(contentType: string) {
  return REWRITABLE_CONTENT_TYPES.some(candidate => contentType.includes(candidate));
}

function rewriteLocationHeader(
  location: string,
  request: Request,
  target: HostAppEmbedTarget
) {
  try {
    const parsed = new URL(location, target.targetOrigin);
    const targetOrigin = new URL(target.targetOrigin);
    if (
      parsed.origin === targetOrigin.origin ||
      !/^[a-z][a-z\d+.-]*:/i.test(location)
    ) {
      return new URL(
        buildAppEmbedUrl(target.app, getModulePathFromUpstreamUrl(parsed, target.targetPathPrefix)),
        request.url
      ).toString();
    }
  } catch {
    return location;
  }

  return location;
}

function rewriteSetCookieHeader(value: string, app: Pick<HostAppEntry, 'source' | 'moduleId' | 'developerTargetId'>) {
  const embedPath = app.source === 'developer' && app.developerTargetId
    ? `/api/apps/dev/${encodeURIComponent(app.developerTargetId)}/embed`
    : `/api/apps/${encodeURIComponent(app.moduleId)}/embed`;
  return value
    .replace(/;\s*domain=[^;]*/ig, '')
    .replace(/;\s*path=[^;]*/ig, '')
    .concat(`; Path=${embedPath}`);
}

function getFrameBlockReason(headers: Headers) {
  const xFrameOptions = headers.get('x-frame-options')?.toLowerCase().trim();
  if (xFrameOptions === 'deny') {
    return 'The module response includes X-Frame-Options: DENY.';
  }

  const csp = headers.get('content-security-policy')?.toLowerCase() ?? '';
  if (/\bframe-ancestors\s+[^;]*('none'|none)/.test(csp)) {
    return 'The module response blocks framing through its Content-Security-Policy.';
  }

  return null;
}

function renderFrameBlockedHtml(target: HostAppEmbedTarget, reason: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(target.app.displayName)} embed blocked</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, Helvetica, sans-serif; color: #18181b; background: #fafafa; }
    main { max-width: 520px; padding: 32px; text-align: center; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0; color: #52525b; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Module UI cannot be embedded</h1>
    <p>${escapeHtml(reason)} Update the module UI contract so it can open through the Host shell.</p>
  </main>
</body>
</html>`;
}

function embedErrorHtmlResponse(status: number, message: string) {
  return new NextResponse(renderEmbedErrorHtml(message), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function renderEmbedErrorHtml(message: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Module UI unavailable</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, Helvetica, sans-serif; color: #18181b; background: #fafafa; }
    main { max-width: 560px; padding: 32px; text-align: center; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0; color: #52525b; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Module UI unavailable</h1>
    <p>${escapeHtml(message)} Open this module through the Host shell after the module UI target is reachable and supports embedding.</p>
  </main>
</body>
</html>`;
}

function rewriteSrcSet(
  value: string,
  toEmbedPath: (modulePath: string) => string
) {
  return value.split(',').map(candidate => {
    const trimmed = candidate.trim();
    const [url, ...rest] = trimmed.split(/\s+/);
    if (!url?.startsWith('/') || url.startsWith('//')) {
      return candidate;
    }

    return [toEmbedPath(url), ...rest].join(' ');
  }).join(', ');
}

function stripCookieValue(value: string, cookieName: string) {
  const cookies = value
    .split(';')
    .map(part => part.trim())
    .filter(part => part && part.split('=')[0] !== cookieName);

  return cookies.length > 0 ? cookies.join('; ') : null;
}

function appendForwardedFor(request: Request) {
  const current = request.headers.get('x-forwarded-for');
  const remoteAddress = request.headers.get('x-real-ip') ?? '';
  return current ? `${current}, ${remoteAddress}` : remoteAddress;
}

function getRequestHost(request: Request) {
  return request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host') ||
    new URL(request.url).host;
}

function getRequestProtocol(request: Request) {
  return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(request.url).protocol.replace(/:$/, '');
}

function getExposurePolicy(accessMode: HostAppAccessMode): ModuleExposurePolicy {
  return accessMode === 'assignedUsersOnly' ? 'assignedUsersOnly' : 'loginRequired';
}

async function readEnabledDeveloperTarget(
  targetId: string,
  config: HostRuntimeConfig
) {
  if (!config.moduleDevModeEnabled) {
    return null;
  }

  const state = await readModuleDevTargetStateSnapshot(config);
  return state.targets.find(target => target.id === targetId && target.enabled) ?? null;
}

function buildDeveloperUpstreamUrl(target: ModuleDevTargetRecord, modulePath: string) {
  const base = new URL(target.targetBaseUrl);
  const pathPrefix = target.targetPathPrefix || '';
  const normalizedModulePath = modulePath.startsWith('/') ? modulePath : `/${modulePath}`;
  return new URL(`${pathPrefix}${normalizedModulePath}`, base.origin).toString();
}

function getModulePathFromUpstreamUrl(url: URL, targetPathPrefix: string | undefined) {
  const upstreamPath = `${url.pathname}${url.search}${url.hash}`;
  if (!targetPathPrefix) {
    return upstreamPath;
  }

  if (url.pathname === targetPathPrefix) {
    return `/${url.search}${url.hash}`;
  }

  if (url.pathname.startsWith(`${targetPathPrefix}/`)) {
    return `${url.pathname.slice(targetPathPrefix.length)}${url.search}${url.hash}`;
  }

  return upstreamPath;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

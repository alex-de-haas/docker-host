import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { canAccessModule } from './auth-policy.ts';
import { ACCOUNT_SET_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth-service.ts';
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
  ModuleMetadata,
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
const CLIENT_CONTROLLED_PROXY_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);
const REWRITABLE_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'application/xhtml+xml',
];
const STATIC_EMBED_ASSET_PATH_PREFIXES = [
  '/_next/static/',
];
const MAX_EMBED_PATH_LENGTH = 2048;
const EMBED_ACCESS_TOKEN_PARAM = 'embedToken';
const EMBED_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;
const EMBED_ACCESS_TOKEN_SECRET_FILE = 'embed-access-secret';
const EMBED_RUNTIME_SCRIPT_ID = '__docker-host-embed-runtime';
const SANDBOXED_EMBED_ORIGIN = 'null';
const SANDBOXED_EMBED_ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const SANDBOXED_EMBED_DEFAULT_ALLOWED_HEADERS = [
  'content-type',
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-url',
].join(', ');
const STATIC_ASSET_PRINCIPAL: HostPrincipal = {
  id: 'embed_static_asset',
  role: 'host.user',
};

let embedAccessTokenSecretMutex: Promise<void> = Promise.resolve();

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
  options: ListHostAppsOptions & { config?: HostRuntimeConfig; modulePath?: string } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = options.modulePath
    ? normalizeEmbedModulePath(options.modulePath)
    : getInstalledEmbedModulePathFromRequest(request, moduleId);
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
    ? validateModuleUiMetadata(metadata.ui, '$.ui', metadata.endpoints ?? [], [], moduleId)
    : null;
  if (!metadata || !ui) {
    throw new HostAppEmbedError('metadata_invalid', `Module "${moduleId}" does not have valid UI metadata.`, 503);
  }

  const target = resolveUiEndpointTarget(metadata, ui.entrypoint.portKey);
  if (!target) {
    throw new HostAppEmbedError('ui_port_missing', `Module "${moduleId}" UI endpoint is missing.`, 503);
  }

  const networkAlias = installedModule.containers.find(container => container.key === target.container.key)?.networkAlias ??
    getModuleNetworkAlias(moduleId, target.container.key);
  const targetOrigin = `http://${networkAlias}:${target.port.containerPort}`;
  const upstreamUrl = new URL(modulePath, targetOrigin).toString();
  const requestHost = getRequestHost(request);
  const requestProtocol = getRequestProtocol(request);
  const exposurePolicy = getExposurePolicy(app.accessMode);

  return {
    app,
    installedModule,
    port: target.port,
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

function resolveUiEndpointTarget(metadata: ModuleMetadata, endpointKey: string) {
  const endpoint = metadata.endpoints?.find(candidate => candidate.key === endpointKey);
  const container = metadata.containers.find(candidate => candidate.key === endpoint?.container);
  const port = container?.runtime?.ports?.find(candidate => candidate.key === endpoint?.port);

  return endpoint && container && port ? { endpoint, container, port } : null;
}

export async function resolveHostDeveloperAppEmbedTarget(
  request: Request,
  principal: HostPrincipal,
  targetId: string,
  options: ListHostAppsOptions & { config?: HostRuntimeConfig; modulePath?: string } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = options.modulePath
    ? normalizeEmbedModulePath(options.modulePath)
    : getDeveloperEmbedModulePathFromRequest(request, targetId);
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

export async function resolveHostAppStaticAssetEmbedTarget(
  request: Request,
  moduleId: string,
  options: { config?: HostRuntimeConfig } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = normalizeStaticEmbedAssetPath(request);
  const store = await readModulesStoreSnapshot(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);
  if (!installedModule) {
    throw new HostAppEmbedError('module_not_found', `Module "${moduleId}" is not installed.`, 404);
  }

  const metadata = await readModuleMetadata(installedModule, config);
  const ui = metadata?.ui
    ? validateModuleUiMetadata(metadata.ui, '$.ui', metadata.endpoints ?? [], [], moduleId)
    : null;
  if (!metadata || !ui) {
    throw new HostAppEmbedError('metadata_invalid', `Module "${moduleId}" does not have valid UI metadata.`, 503);
  }

  const target = resolveUiEndpointTarget(metadata, ui.entrypoint.portKey);
  if (!target) {
    throw new HostAppEmbedError('ui_port_missing', `Module "${moduleId}" UI endpoint is missing.`, 503);
  }

  const networkAlias = installedModule.containers.find(container => container.key === target.container.key)?.networkAlias ??
    getModuleNetworkAlias(moduleId, target.container.key);
  const targetOrigin = `http://${networkAlias}:${target.port.containerPort}`;

  return {
    app: {
      id: moduleId,
      source: 'installed',
      moduleId,
      displayName: metadata.name || moduleId,
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(ui.icon ? { icon: ui.icon } : {}),
      version: metadata.version || 'unknown',
      status: 'available',
      statusReason: 'available',
      accessMode: 'allAuthenticated',
      entryPath: `/apps/${encodeURIComponent(moduleId)}`,
      embeddedUrl: buildEmbedUrl(moduleId, ui.entrypoint.path),
      navigation: [],
    },
    installedModule,
    port: target.port,
    config,
    modulePath,
    targetOrigin,
    upstreamUrl: new URL(modulePath, targetOrigin).toString(),
    requestHost: getRequestHost(request),
    requestProtocol: getRequestProtocol(request),
    identityInput: createStaticAssetIdentityInput({
      id: `shell_${moduleId}`,
      moduleId,
      hostname: getRequestHost(request),
      portKey: ui.entrypoint.portKey,
      exposurePolicy: 'loginRequired',
    }),
  };
}

export async function resolveHostDeveloperAppStaticAssetEmbedTarget(
  request: Request,
  targetId: string,
  options: { config?: HostRuntimeConfig } = {}
): Promise<HostAppEmbedTarget> {
  const config = options.config ?? getHostRuntimeConfig();
  const modulePath = normalizeStaticEmbedAssetPath(request);
  const developerTarget = await readEnabledDeveloperTarget(targetId, config);
  if (!developerTarget?.shellApp) {
    throw new HostAppEmbedError(
      'developer_target_not_found',
      `Developer module app "${targetId}" is not available.`,
      404
    );
  }

  return {
    app: {
      id: `dev:${developerTarget.id}`,
      source: 'developer',
      moduleId: developerTarget.moduleId,
      developerTargetId: developerTarget.id,
      displayName: developerTarget.shellApp.displayName || developerTarget.moduleName || developerTarget.moduleId,
      ...(developerTarget.shellApp.description || developerTarget.moduleDescription
        ? { description: developerTarget.shellApp.description || developerTarget.moduleDescription }
        : {}),
      ...(developerTarget.shellApp.icon ? { icon: developerTarget.shellApp.icon } : {}),
      version: developerTarget.moduleVersion || 'unknown',
      status: 'available',
      statusReason: 'available',
      accessMode: developerTarget.exposurePolicy === 'assignedUsersOnly' ? 'assignedUsersOnly' : 'allAuthenticated',
      entryPath: `/apps/dev/${encodeURIComponent(developerTarget.id)}`,
      embeddedUrl: buildDeveloperEmbedUrl(developerTarget.id, developerTarget.shellApp.entrypointPath),
      navigation: [],
    },
    config,
    modulePath,
    targetOrigin: new URL(developerTarget.targetBaseUrl).origin,
    targetPathPrefix: developerTarget.targetPathPrefix,
    upstreamUrl: buildDeveloperUpstreamUrl(developerTarget, modulePath),
    requestHost: getRequestHost(request),
    requestProtocol: getRequestProtocol(request),
    identityInput: createStaticAssetIdentityInput({
      id: developerTarget.id,
      moduleId: developerTarget.moduleId,
      hostname: getRequestHost(request),
      portKey: developerTarget.portKey,
      exposurePolicy: developerTarget.exposurePolicy,
    }),
  };
}

export async function authenticateHostAppEmbedTokenRequest(
  request: Request,
  expected: { source: 'installed'; moduleId: string } | { source: 'developer'; targetId: string },
  options: { config?: HostRuntimeConfig } = {}
): Promise<HostPrincipal | null> {
  const config = options.config ?? getHostRuntimeConfig();
  const token = new URL(request.url).searchParams.get(EMBED_ACCESS_TOKEN_PARAM);
  if (!token) {
    return null;
  }

  const payload = await verifyEmbedAccessToken(token, config);
  if (!payload || payload.source !== expected.source) {
    return null;
  }

  if (expected.source === 'installed') {
    return payload.moduleId === expected.moduleId ? payload.principal : null;
  }

  return payload.developerTargetId === expected.targetId ? payload.principal : null;
}

export function getInstalledEmbedModulePathFromRequest(request: Request, moduleId: string) {
  return getEmbedModulePathFromRequest(
    request,
    `/api/apps/${encodeURIComponent(moduleId)}/embed`
  );
}

export function getDeveloperEmbedModulePathFromRequest(request: Request, targetId: string) {
  return getEmbedModulePathFromRequest(
    request,
    `/api/apps/dev/${encodeURIComponent(targetId)}/embed`
  );
}

export function getEmbedModulePathFromRequest(request: Request, embedBasePath: string) {
  const url = new URL(request.url);
  const normalizedBasePath = embedBasePath.replace(/\/+$/, '');
  const pathname = url.pathname;
  const legacyPath = url.searchParams.get('path');
  if (
    legacyPath !== null &&
    (pathname === normalizedBasePath || pathname === `${normalizedBasePath}/`)
  ) {
    return normalizeEmbedModulePath(legacyPath);
  }

  const embeddedPathname = pathname === normalizedBasePath || pathname === `${normalizedBasePath}/`
    ? '/'
    : pathname.startsWith(`${normalizedBasePath}/`)
      ? pathname.slice(normalizedBasePath.length)
      : '/';
  const modulePath = appendModuleSearch(embeddedPathname, url.searchParams);
  return normalizeEmbedModulePath(modulePath);
}

export function getRootRelativeModulePathFromRequest(request: Request) {
  const url = new URL(request.url);
  return normalizeEmbedModulePath(appendModuleSearch(url.pathname || '/', url.searchParams));
}

export function parseHostAppEmbedReferer(request: Request) {
  const referer = request.headers.get('referer');
  if (!referer) {
    return null;
  }

  try {
    const requestUrl = new URL(request.url);
    const refererUrl = new URL(referer, requestUrl);
    if (refererUrl.origin !== requestUrl.origin) {
      return null;
    }

    const developerMatch = /^\/api\/apps\/dev\/([^/]+)\/embed(?:\/|$)/.exec(refererUrl.pathname);
    if (developerMatch?.[1]) {
      return {
        source: 'developer' as const,
        targetId: decodeURIComponent(developerMatch[1]),
      };
    }

    const installedMatch = /^\/api\/apps\/([^/]+)\/embed(?:\/|$)/.exec(refererUrl.pathname);
    if (installedMatch?.[1] && installedMatch[1] !== 'dev') {
      return {
        source: 'installed' as const,
        moduleId: decodeURIComponent(installedMatch[1]),
      };
    }
  } catch {
    return null;
  }

  return null;
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

export function hostAppEmbedCorsPreflightResponse(request: Request, allowed: boolean) {
  const headers = new Headers({
    'cache-control': 'no-store',
  });
  if (allowed) {
    applySandboxedEmbedCorsHeaders(request, headers);
  }

  return new NextResponse(null, {
    status: 204,
    headers,
  });
}

export function withHostAppEmbedCorsHeaders<T extends Response>(request: Request, response: T): T {
  applySandboxedEmbedCorsHeaders(request, response.headers);
  return response;
}

function applySandboxedEmbedCorsHeaders(request: Request, headers: Headers) {
  if (request.headers.get('origin') !== SANDBOXED_EMBED_ORIGIN) {
    return;
  }

  headers.set('access-control-allow-origin', SANDBOXED_EMBED_ORIGIN);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-methods', SANDBOXED_EMBED_ALLOWED_METHODS);
  headers.set(
    'access-control-allow-headers',
    request.headers.get('access-control-request-headers') ||
      SANDBOXED_EMBED_DEFAULT_ALLOWED_HEADERS
  );
  headers.set('access-control-max-age', '600');
  appendVaryHeader(headers, 'Origin');
  appendVaryHeader(headers, 'Access-Control-Request-Method');
  appendVaryHeader(headers, 'Access-Control-Request-Headers');
}

export function normalizeEmbedModulePath(value: string | null) {
  const path = value || '/';
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new HostAppEmbedError(
      'invalid_embed_path',
      'Embedded module UI path must be a same-origin absolute path.',
      400
    );
  }

  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    decodedPath.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(decodedPath) ||
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

export function isHostAppEmbedStaticAssetRequest(request: Request) {
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    return false;
  }

  try {
    const modulePath = getEmbedModulePathFromRequest(request, getEmbedBasePathFromRequest(request));
    return STATIC_EMBED_ASSET_PATH_PREFIXES.some(prefix => modulePath.startsWith(prefix));
  } catch {
    return false;
  }
}

export function rewriteEmbeddedContent(
  content: string,
  target: Pick<HostAppEmbedTarget, 'app'>,
  embedAccessToken: string | null = null
) {
  const toEmbedPath = (modulePath: string) => buildAppEmbedUrl(target.app, modulePath, embedAccessToken);
  const rewritten = rewriteHtmlFragment(content, toEmbedPath);
  return injectEmbedRuntimeScript(rewritten, target.app, embedAccessToken);
}

function rewriteEmbeddedCssContent(
  content: string,
  target: Pick<HostAppEmbedTarget, 'app'>,
  embedAccessToken: string | null = null
) {
  const toEmbedPath = (modulePath: string) => buildAppEmbedUrl(target.app, modulePath, embedAccessToken);
  return rewriteCssUrls(content, toEmbedPath);
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

export function buildEmbedUrl(moduleId: string, modulePath: string, embedAccessToken: string | null = null) {
  return buildPathShapedEmbedUrl(
    `/api/apps/${encodeURIComponent(moduleId)}/embed`,
    modulePath,
    embedAccessToken
  );
}

export function buildDeveloperEmbedUrl(targetId: string, modulePath: string, embedAccessToken: string | null = null) {
  return buildPathShapedEmbedUrl(
    `/api/apps/dev/${encodeURIComponent(targetId)}/embed`,
    modulePath,
    embedAccessToken
  );
}

export function buildAppEmbedUrl(
  app: Pick<HostAppEntry, 'source' | 'moduleId' | 'developerTargetId'>,
  modulePath: string,
  embedAccessToken: string | null = null
) {
  return app.source === 'developer' && app.developerTargetId
    ? buildDeveloperEmbedUrl(app.developerTargetId, modulePath, embedAccessToken)
    : buildEmbedUrl(app.moduleId, modulePath, embedAccessToken);
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
      CLIENT_CONTROLLED_PROXY_HEADERS.has(lowerName) ||
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
      const cookie = stripHostAuthCookies(value);
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

  const embedAccessToken = target.identityInput.access.allowed
    ? await createEmbedAccessToken(target)
    : null;
  const headers = buildEmbedResponseHeaders(request, response.headers, target, embedAccessToken);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (shouldRewriteContent(contentType)) {
    const body = contentType.includes('text/css')
      ? rewriteEmbeddedCssContent(await response.text(), target, embedAccessToken)
      : rewriteEmbeddedContent(await response.text(), target, embedAccessToken);
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
  target: HostAppEmbedTarget,
  embedAccessToken: string | null
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
      headers.set(name, rewriteLocationHeader(value, request, target, embedAccessToken));
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
  target: HostAppEmbedTarget,
  embedAccessToken: string | null
) {
  try {
    const parsed = new URL(location, target.targetOrigin);
    const targetOrigin = new URL(target.targetOrigin);
    if (
      parsed.origin === targetOrigin.origin ||
      !/^[a-z][a-z\d+.-]*:/i.test(location)
    ) {
      return new URL(
        buildAppEmbedUrl(target.app, getModulePathFromUpstreamUrl(parsed, target.targetPathPrefix), embedAccessToken),
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

function stripHostAuthCookies(value: string) {
  const withoutSession = stripCookieValue(value, SESSION_COOKIE_NAME);
  return withoutSession ? stripCookieValue(withoutSession, ACCOUNT_SET_COOKIE_NAME) : null;
}

function appendForwardedFor(request: Request) {
  return request.headers.get('x-docker-host-remote-address')?.split(',')[0]?.trim() ?? '';
}

function appendVaryHeader(headers: Headers, value: string) {
  const current = headers.get('vary');
  if (!current) {
    headers.set('vary', value);
    return;
  }

  const existing = current.split(',').map(part => part.trim().toLowerCase());
  if (!existing.includes(value.toLowerCase())) {
    headers.set('vary', `${current}, ${value}`);
  }
}

function getRequestHost(request: Request) {
  return request.headers.get('host') ||
    new URL(request.url).host;
}

function getRequestProtocol(request: Request) {
  return new URL(request.url).protocol.replace(/:$/, '');
}

function getExposurePolicy(accessMode: HostAppAccessMode): ModuleExposurePolicy {
  return accessMode === 'assignedUsersOnly' ? 'assignedUsersOnly' : 'loginRequired';
}

function normalizeStaticEmbedAssetPath(request: Request) {
  if (!isHostAppEmbedStaticAssetRequest(request)) {
    throw new HostAppEmbedError(
      'invalid_embed_static_asset_path',
      'Embedded module static asset path must target a supported static asset.',
      400
    );
  }

  return getEmbedModulePathFromRequest(request, getEmbedBasePathFromRequest(request));
}

function createStaticAssetIdentityInput({
  id,
  moduleId,
  hostname,
  portKey,
  exposurePolicy,
}: {
  id: string;
  moduleId: string;
  hostname: string;
  portKey: string;
  exposurePolicy: ModuleExposurePolicy;
}): HostAppEmbedTarget['identityInput'] {
  return {
    exposure: {
      id,
      moduleId,
      hostname,
      portKey,
      exposurePolicy,
      identityMode: 'none',
    },
    access: {
      allowed: false,
      policy: exposurePolicy,
      reason: 'loginRequired',
    },
    principal: STATIC_ASSET_PRINCIPAL,
  };
}

interface EmbedAccessTokenPayload {
  v: 1;
  exp: number;
  source: HostAppEntry['source'];
  moduleId: string;
  developerTargetId?: string;
  principal: HostPrincipal;
}

async function createEmbedAccessToken(target: HostAppEmbedTarget) {
  const payload: EmbedAccessTokenPayload = {
    v: 1,
    exp: Date.now() + EMBED_ACCESS_TOKEN_TTL_MS,
    source: target.app.source,
    moduleId: target.app.moduleId,
    ...(target.app.developerTargetId ? { developerTargetId: target.app.developerTargetId } : {}),
    principal: sanitizeEmbedAccessTokenPrincipal(target.identityInput.principal),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signature = createHmac('sha256', await getEmbedAccessTokenSecret(target.config))
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

async function verifyEmbedAccessToken(
  token: string,
  config: HostRuntimeConfig
): Promise<EmbedAccessTokenPayload | null> {
  const [encodedPayload, signature, ...extra] = token.split('.');
  if (!encodedPayload || !signature || extra.length > 0) {
    return null;
  }

  const expectedSignature = createHmac('sha256', await getEmbedAccessTokenSecret(config))
    .update(encodedPayload)
    .digest('base64url');
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8')) as unknown;
  } catch {
    return null;
  }

  if (!isEmbedAccessTokenPayload(payload) || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

async function getEmbedAccessTokenSecret(config: HostRuntimeConfig) {
  const secretPath = path.join(config.authRootContainer, EMBED_ACCESS_TOKEN_SECRET_FILE);
  try {
    const existing = (await fs.readFile(secretPath, 'utf-8')).trim();
    if (existing) {
      return existing;
    }
  } catch (error) {
    if (!isNodeFileError(error, 'ENOENT')) {
      throw error;
    }
  }

  const previous = embedAccessTokenSecretMutex;
  let release: () => void = () => undefined;
  embedAccessTokenSecretMutex = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;

  try {
    try {
      const existing = (await fs.readFile(secretPath, 'utf-8')).trim();
      if (existing) {
        return existing;
      }
    } catch (error) {
      if (!isNodeFileError(error, 'ENOENT')) {
        throw error;
      }
    }

    await fs.mkdir(config.authRootContainer, { recursive: true });
    const secret = randomBytes(32).toString('base64url');
    const temporaryPath = `${secretPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporaryPath, `${secret}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, secretPath);
    await fs.chmod(secretPath, 0o600);
    return secret;
  } finally {
    release();
  }
}

function sanitizeEmbedAccessTokenPrincipal(principal: HostPrincipal): HostPrincipal {
  return {
    id: principal.id,
    role: principal.role,
    ...(principal.email ? { email: principal.email } : {}),
    ...(principal.displayName ? { displayName: principal.displayName } : {}),
  };
}

function isEmbedAccessTokenPayload(value: unknown): value is EmbedAccessTokenPayload {
  if (!isObject(value) ||
    value.v !== 1 ||
    typeof value.exp !== 'number' ||
    (value.source !== 'installed' && value.source !== 'developer') ||
    typeof value.moduleId !== 'string' ||
    !isHostPrincipal(value.principal)) {
    return false;
  }

  return value.source === 'installed' ||
    typeof value.developerTargetId === 'string';
}

function isHostPrincipal(value: unknown): value is HostPrincipal {
  return isObject(value) &&
    typeof value.id === 'string' &&
    (value.role === 'host.admin' || value.role === 'host.user') &&
    (value.email === undefined || typeof value.email === 'string') &&
    (value.displayName === undefined || typeof value.displayName === 'string');
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function buildPathShapedEmbedUrl(
  embedBasePath: string,
  modulePath: string,
  embedAccessToken: string | null
) {
  const parsed = new URL(normalizeEmbedModulePath(modulePath), 'http://docker-host-embed.local');
  const searchParams = new URLSearchParams(parsed.search);
  if (embedAccessToken) {
    searchParams.set(EMBED_ACCESS_TOKEN_PARAM, embedAccessToken);
  }

  const search = searchParams.toString();
  return `${embedBasePath}${parsed.pathname}${search ? `?${search}` : ''}${parsed.hash}`;
}

function appendModuleSearch(pathname: string, searchParams: URLSearchParams) {
  const forwardedSearchParams = new URLSearchParams(searchParams);
  forwardedSearchParams.delete(EMBED_ACCESS_TOKEN_PARAM);
  const search = forwardedSearchParams.toString();
  return `${pathname || '/'}${search ? `?${search}` : ''}`;
}

function getEmbedBasePathFromRequest(request: Request) {
  const pathname = new URL(request.url).pathname;
  const developerMatch = /^(\/api\/apps\/dev\/[^/]+\/embed)(?:\/|$)/.exec(pathname);
  if (developerMatch?.[1]) {
    return developerMatch[1];
  }

  const installedMatch = /^(\/api\/apps\/[^/]+\/embed)(?:\/|$)/.exec(pathname);
  if (installedMatch?.[1]) {
    return installedMatch[1];
  }

  throw new HostAppEmbedError(
    'invalid_embed_path',
    'Embedded module UI path must use a reserved Host embed route.',
    400
  );
}

function injectEmbedRuntimeScript(
  content: string,
  app: Pick<HostAppEntry, 'source' | 'moduleId' | 'developerTargetId'>,
  embedAccessToken: string | null
) {
  if (!/<html[\s>]/i.test(content) || content.includes(`id="${EMBED_RUNTIME_SCRIPT_ID}"`)) {
    return content;
  }

  const script = renderEmbedRuntimeScript(app, embedAccessToken);
  const headStart = /<head\b[^>]*>/i.exec(content);
  if (headStart?.index !== undefined) {
    const insertAt = headStart.index + headStart[0].length;
    return `${content.slice(0, insertAt)}${script}${content.slice(insertAt)}`;
  }

  return `${script}${content}`;
}

function renderEmbedRuntimeScript(
  app: Pick<HostAppEntry, 'source' | 'moduleId' | 'developerTargetId'>,
  embedAccessToken: string | null
) {
  const embedBasePath = app.source === 'developer' && app.developerTargetId
    ? `/api/apps/dev/${encodeURIComponent(app.developerTargetId)}/embed`
    : `/api/apps/${encodeURIComponent(app.moduleId)}/embed`;
  const token = embedAccessToken ?? '';

  return `<script id="${EMBED_RUNTIME_SCRIPT_ID}">(() => {
  const embedBasePath = ${JSON.stringify(embedBasePath)};
  const embedToken = ${JSON.stringify(token)};
  const tokenParam = ${JSON.stringify(EMBED_ACCESS_TOKEN_PARAM)};
  const shouldRewrite = value => {
    try {
      const url = new URL(value, window.location.href);
      return url.origin === window.location.origin &&
        url.pathname.startsWith('/') &&
        !url.pathname.startsWith(embedBasePath + '/') &&
        url.pathname !== embedBasePath;
    } catch {
      return false;
    }
  };
  const toEmbedUrl = value => {
    if (!shouldRewrite(value)) {
      return value;
    }
    const url = new URL(value, window.location.href);
    const next = new URL(embedBasePath + url.pathname, window.location.origin);
    url.searchParams.forEach((paramValue, paramName) => next.searchParams.append(paramName, paramValue));
    if (embedToken) {
      next.searchParams.set(tokenParam, embedToken);
    }
    next.hash = url.hash;
    return next.pathname + next.search + next.hash;
  };
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = (input, init) => {
      if (input instanceof Request) {
        const rewritten = toEmbedUrl(input.url);
        return nativeFetch.call(window, rewritten === input.url ? input : new Request(rewritten, input), init);
      }
      return nativeFetch.call(window, typeof input === 'string' || input instanceof URL ? toEmbedUrl(String(input)) : input, init);
    };
  }
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  if (NativeXMLHttpRequest?.prototype?.open) {
    const nativeOpen = NativeXMLHttpRequest.prototype.open;
    NativeXMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return nativeOpen.call(this, method, typeof url === 'string' || url instanceof URL ? toEmbedUrl(String(url)) : url, ...rest);
    };
  }
})();</script>`;
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

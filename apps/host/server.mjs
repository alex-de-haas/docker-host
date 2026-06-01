import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import {
  MODULE_IDENTITY_TOKEN_HEADER,
  createModuleIdentityToken,
  getDefaultModuleIdentityMode,
} from './src/lib/module-identity.mjs';
import {
  TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS,
  authenticateTrustedProxyRequest,
} from './src/lib/trusted-proxy.mjs';

const SESSION_COOKIE_NAME = 'docker_host_session';
const ACCOUNT_SET_COOKIE_NAME = 'docker_host_accounts';
const INTERNAL_REMOTE_ADDRESS_HEADER = 'x-docker-host-remote-address';
const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.docker-host');
const DATA_ROOT_MARKER_FILE = '.docker-host-root.json';
const DEFAULT_MODULE_EXPOSURE_POLICY = 'loginRequired';
const CONTROL_CONTRACT_VERSION = '0.1';
const CONTROL_SECRET_HEADER = 'X-Docker-Host-Control-Secret';
const CONTROL_CONTRACT_HEADER = 'X-Docker-Host-Control-Contract-Version';
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

const appDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || '0.0.0.0';
const dev = process.argv.includes('--dev')
  ? true
  : process.argv.includes('--production')
    ? false
    : process.env.NODE_ENV !== 'production';
process.env.HOST_RUNTIME_MODE = dev ? 'development' : 'production';

let handleNextRequest;
const controlInstanceId = randomUUID();
const controlSecret = `dhctl_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;

const server = createServer(async (req, res) => {
  try {
    stampInternalRequestHeaders(req);

    if (isControlRequestPath(req.url)) {
      await handleNextRequest(req, res);
      return;
    }

    const gatewayTarget = await resolveGatewayRequest(req);
    if (gatewayTarget) {
      await proxyHttpRequest(req, res, gatewayTarget);
      return;
    }

    if (await shouldRejectUnknownGatewayHost(req)) {
      sendPlain(res, 404, 'Gateway hostname is not configured.');
      return;
    }

    await handleNextRequest(req, res);
  } catch (error) {
    console.error('Gateway request failed:', error);
    if (!res.headersSent) {
      sendPlain(res, getGatewayErrorStatus(error), getGatewayErrorMessage(error));
    } else {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
});

const app = next({
  dev,
  dir: appDir,
  hostname,
  port,
  httpServer: server,
});
handleNextRequest = app.getRequestHandler();

server.prependListener('upgrade', async (req, socket, head) => {
  try {
    const gatewayTarget = await resolveGatewayRequest(req);
    if (!gatewayTarget) {
      return;
    }

    if (!gatewayTarget.access.allowed) {
      await appendGatewayAuditEvent(req, gatewayTarget);
      sendUpgradeDenied(socket, gatewayTarget.access.reason === 'loginRequired' ? 401 : 403);
      return;
    }

    await proxyWebSocketUpgrade(req, socket, head, gatewayTarget);
  } catch (error) {
    console.error('Gateway upgrade failed:', error);
    sendUpgradeDenied(socket, getGatewayErrorStatus(error, 502));
  }
});

if (isMainModule()) {
  await app.prepare();

  server.listen(port, hostname, () => {
    void writeControlDiscoveryFile().catch(error => {
      console.error('Unable to write Docker Host control discovery file:', error);
    });
    console.log(
      `> Docker Host listening at http://${hostname}:${port} as ${dev ? 'development' : 'production'}`
    );
  });
}

export class GatewayHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.code = code;
  }
}

export async function resolveGatewayRequest(req) {
  const hostnameValue = parseHostname(req.headers.host);
  if (!hostnameValue) {
    return null;
  }

  const config = getRuntimeConfig();
  await verifyDataRootMarker(config);
  const devTarget = await resolveModuleDevTarget(hostnameValue, config);
  if (devTarget) {
    const authState = await readAuthState(config);
    const trustedProxy = await authenticateTrustedProxyRequest(req, config);
    const principal = trustedProxy.principal ||
      (trustedProxy.modeActive ? null : authenticateSession(req, authState));
    const access = canAccessModule({
      principal,
      moduleId: devTarget.moduleId,
      exposurePolicy: devTarget.exposurePolicy,
      assignments: authState.moduleAssignments || [],
    });
    const targetUrl = parseDevTargetUrl(devTarget.targetBaseUrl);

    return {
      exposure: {
        id: devTarget.id,
        moduleId: devTarget.moduleId,
        hostname: hostnameValue,
        endpointKey: devTarget.portKey,
        exposurePolicy: devTarget.exposurePolicy || DEFAULT_MODULE_EXPOSURE_POLICY,
        identityMode: getExposureIdentityMode(devTarget, devTarget.exposurePolicy || DEFAULT_MODULE_EXPOSURE_POLICY),
      },
      access,
      principal,
      networkAlias: targetUrl.hostname,
      containerPort: targetUrl.port,
      proxyHostname: targetUrl.hostname,
      proxyPort: targetUrl.port,
      targetPathPrefix: targetUrl.pathPrefix,
      targetOrigin: targetUrl.origin,
      requestHost: req.headers.host,
      requestProtocol: getRequestProtocol(req),
      trustedProxyAssertionHeaders: trustedProxy.assertionHeaders,
      developerMode: true,
    };
  }

  const gateway = await readJsonIfExists(config.gatewayExposuresPath, {
    schemaVersion: '0.2',
    exposures: [],
  });
  const exposure = Array.isArray(gateway.exposures)
    ? gateway.exposures.find(candidate =>
        candidate &&
        candidate.enabled !== false &&
        typeof candidate.hostname === 'string' &&
        candidate.hostname.toLowerCase() === hostnameValue
      )
    : null;

  if (!exposure) {
    return null;
  }

  const [modulesStore, authState] = await Promise.all([
    readModulesStore(config),
    readAuthState(config),
  ]);
  const installedModule = modulesStore.modules.find(module => module.id === exposure.moduleId);
  if (!installedModule) {
    throw new GatewayHttpError(
      404,
      'gateway_module_not_found',
      `Module "${exposure.moduleId}" is not installed.`
    );
  }
  if (installedModule.operationStatus && installedModule.operationStatus !== 'installed') {
    throw new GatewayHttpError(
      503,
      'gateway_module_unavailable',
      `Module "${exposure.moduleId}" is not ready for gateway traffic.`
    );
  }

  const metadata = await readModuleMetadata(installedModule, config);
  const endpointKey = exposure.endpointKey || exposure.portKey;
  const endpointTarget = resolveModuleEndpointTarget(metadata, endpointKey);
  if (!endpointTarget) {
    throw new Error(`Module "${exposure.moduleId}" does not define endpoint "${endpointKey}".`);
  }

  const trustedProxy = await authenticateTrustedProxyRequest(req, config);
  const principal = trustedProxy.principal ||
    (trustedProxy.modeActive ? null : authenticateSession(req, authState));
  const policy = exposure.exposurePolicy || DEFAULT_MODULE_EXPOSURE_POLICY;
  const access = canAccessModule({
    principal,
    moduleId: exposure.moduleId,
    exposurePolicy: policy,
    assignments: authState.moduleAssignments || [],
  });
  const installedContainer = Array.isArray(installedModule.containers)
    ? installedModule.containers.find(container => container.key === endpointTarget.containerKey)
    : null;
  const networkAlias = installedContainer?.networkAlias ||
    getModuleNetworkAlias(exposure.moduleId, endpointTarget.containerKey);

  return {
    exposure: {
      ...exposure,
      endpointKey,
      exposurePolicy: policy,
      identityMode: getExposureIdentityMode(exposure, policy),
      hostname: hostnameValue,
    },
    access,
    principal,
    networkAlias,
    containerPort: endpointTarget.port.containerPort,
    targetOrigin: `http://${networkAlias}:${endpointTarget.port.containerPort}`,
    requestHost: req.headers.host,
    requestProtocol: getRequestProtocol(req),
    trustedProxyAssertionHeaders: trustedProxy.assertionHeaders,
  };
}

export async function proxyHttpRequest(req, res, target) {
  if (!target.access.allowed) {
    await sendDenied(req, res, target);
    return;
  }

  if (req.method === 'GET' && acceptsHtml(req)) {
    await appendGatewayAuditEvent(req, target, true);
  }

  const identityToken = await createModuleIdentityToken(target, getRuntimeConfig());
  const headers = buildProxyRequestHeaders(req, target, false, identityToken);
  const proxyTarget = getProxyTarget(target);
  const proxyReq = httpRequest({
    protocol: 'http:',
    hostname: proxyTarget.hostname,
    port: proxyTarget.port,
    method: req.method,
    path: buildProxyPath(req.url || '/', proxyTarget.pathPrefix),
    headers,
  }, proxyRes => {
    const responseHeaders = buildProxyResponseHeaders(proxyRes.headers, target);
    res.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', error => {
    console.error('Module proxy request failed:', error);
    if (!res.headersSent) {
      sendPlain(res, 502, 'Module gateway target is unavailable.');
    } else {
      res.destroy(error);
    }
  });

  req.pipe(proxyReq);
}

export async function proxyWebSocketUpgrade(req, socket, head, target) {
  const identityToken = await createModuleIdentityToken(target, getRuntimeConfig());
  const proxyTarget = getProxyTarget(target);
  const upstream = net.connect(proxyTarget.port, proxyTarget.hostname);

  upstream.on('connect', () => {
    const lines = [`${req.method} ${buildProxyPath(req.url || '/', proxyTarget.pathPrefix)} HTTP/${req.httpVersion}`];
    lines.push(...buildProxyUpgradeHeaderLines(req, target, identityToken));

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', error => {
    console.error('Module gateway websocket failed:', error);
    sendUpgradeDenied(socket, 502);
  });
  socket.on('error', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

async function sendDenied(req, res, target) {
  await appendGatewayAuditEvent(req, target);

  if (target.access.reason === 'loginRequired') {
    if (req.method === 'GET' && acceptsHtml(req)) {
      res.writeHead(302, {
        Location: `${getHostPublicOrigin(req)}/login`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    sendJson(res, 401, {
      error: {
        code: 'gateway_login_required',
        message: 'Authentication is required before opening this module.',
      },
    });
    return;
  }

  sendJson(res, 403, {
    error: {
      code: 'gateway_forbidden',
      message: 'This Host user is not allowed to open the requested module.',
    },
  });
}

export function buildProxyRequestHeaders(req, target, upgrade, identityToken = null) {
  const headers = {};
  const trustedProxyAssertionHeaders = new Set(
    (target.trustedProxyAssertionHeaders || TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS)
      .map(header => String(header).toLowerCase())
  );

  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      CLIENT_CONTROLLED_PROXY_HEADERS.has(lowerName) ||
      lowerName === 'authorization' ||
      lowerName === 'host'
    ) {
      continue;
    }

    if (lowerName.startsWith('x-docker-host-') || trustedProxyAssertionHeaders.has(lowerName)) {
      continue;
    }

    if (lowerName === 'cookie') {
      const cookie = stripHostAuthCookies(value);
      if (cookie) {
        headers[name] = cookie;
      }
      continue;
    }

    headers[name] = value;
  }

  headers.host = target.requestHost;
  headers['x-forwarded-host'] = target.requestHost;
  headers['x-forwarded-proto'] = getRequestProtocol(req);
  headers['x-forwarded-for'] = appendForwardedFor(req);

  if (identityToken) {
    headers[MODULE_IDENTITY_TOKEN_HEADER] = identityToken;
  }

  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
  }

  return headers;
}

export function buildProxyUpgradeHeaderLines(req, target, identityToken = null) {
  const lines = [];
  const trustedProxyAssertionHeaders = new Set(
    (target.trustedProxyAssertionHeaders || TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS)
      .map(header => String(header).toLowerCase())
  );

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    if (!name || value === undefined) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === 'authorization' ||
      lowerName === 'host' ||
      CLIENT_CONTROLLED_PROXY_HEADERS.has(lowerName)
    ) {
      continue;
    }

    if (lowerName.startsWith('x-docker-host-') || trustedProxyAssertionHeaders.has(lowerName)) {
      continue;
    }

    if (lowerName === 'cookie') {
      const cookie = stripHostAuthCookies(value);
      if (cookie) {
        lines.push(formatHeaderLine(name, cookie));
      }
      continue;
    }

    lines.push(formatHeaderLine(name, value));
  }

  lines.push(formatHeaderLine('Host', target.requestHost));
  lines.push(formatHeaderLine('X-Forwarded-Host', target.requestHost));
  lines.push(formatHeaderLine('X-Forwarded-Proto', getRequestProtocol(req)));
  lines.push(formatHeaderLine('X-Forwarded-For', appendForwardedFor(req)));

  if (identityToken) {
    lines.push(formatHeaderLine(MODULE_IDENTITY_TOKEN_HEADER, identityToken));
  }

  lines.push(formatHeaderLine('Connection', 'Upgrade'));
  lines.push(formatHeaderLine('Upgrade', req.headers.upgrade || 'websocket'));
  return lines;
}

export function buildProxyResponseHeaders(responseHeaders, target) {
  const headers = {};
  for (const [name, value] of Object.entries(responseHeaders)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) {
      continue;
    }

    if (lowerName === 'location' && typeof value === 'string') {
      headers[name] = rewriteLocationHeader(value, target);
      continue;
    }

    if (lowerName === 'set-cookie') {
      headers[name] = stripCookieDomain(value);
      continue;
    }

    headers[name] = value;
  }

  return headers;
}

function rewriteLocationHeader(location, target) {
  if (!/^[a-z][a-z\d+.-]*:/i.test(location)) {
    return location;
  }

  try {
    const parsed = new URL(location, target.targetOrigin);
    const targetOrigin = new URL(target.targetOrigin);
    if (parsed.hostname === targetOrigin.hostname &&
      String(parsed.port || '80') === String(targetOrigin.port || '80')) {
      return `${target.requestProtocol}://${target.requestHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return location;
  }

  return location;
}

async function shouldRejectUnknownGatewayHost(req) {
  const config = getRuntimeConfig();
  if (!config.gatewayBaseDomain) {
    return false;
  }

  const hostnameValue = parseHostname(req.headers.host);
  if (!hostnameValue ||
    hostnameValue === config.gatewayBaseDomain ||
    hostnameValue === `host.${config.gatewayBaseDomain}` ||
    hostnameValue === parseHostnameFromOrigin(config.hostPublicOrigin)) {
    return false;
  }

  return hostnameValue.endsWith(`.${config.gatewayBaseDomain}`);
}

function authenticateSession(req, authState) {
  const token = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token || !Array.isArray(authState.sessions) || !Array.isArray(authState.users)) {
    return null;
  }

  const now = Date.now();
  const tokenHash = hashToken(token);
  const session = authState.sessions.find(candidate =>
    candidate &&
    !candidate.revokedAt &&
    candidate.tokenHash === tokenHash &&
    Date.parse(candidate.idleExpiresAt) > now &&
    Date.parse(candidate.absoluteExpiresAt) > now
  );
  const user = session
    ? authState.users.find(candidate => candidate.id === session.userId && !candidate.disabled)
    : null;

  if (!session || !user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    sessionId: session.id,
  };
}

function canAccessModule({ principal, moduleId, exposurePolicy, assignments }) {
  if (exposurePolicy === 'public') {
    return { allowed: true, policy: exposurePolicy, reason: 'public' };
  }

  if (!principal) {
    return { allowed: false, policy: exposurePolicy, reason: 'loginRequired' };
  }

  if (principal.role === 'host.admin') {
    return { allowed: true, policy: exposurePolicy, reason: 'hostAdmin' };
  }

  if (exposurePolicy === 'loginRequired') {
    return { allowed: true, policy: exposurePolicy, reason: 'authenticated' };
  }

  const assigned = assignments.some(assignment =>
    assignment &&
    assignment.moduleId === moduleId &&
    assignment.userId === principal.id
  );

  return assigned
    ? { allowed: true, policy: exposurePolicy, reason: 'assigned' }
    : { allowed: false, policy: exposurePolicy, reason: 'assignmentRequired' };
}

async function readModulesStore(config) {
  const store = await readJsonIfExists(config.modulesStorePath, {
    schemaVersion: '0.2',
    hostSettings: {},
    modules: [],
  });

  if (Array.isArray(store)) {
    return {
      schemaVersion: '0.2',
      hostSettings: {},
      modules: store.map(normalizeInstalledModuleRecord).filter(Boolean),
    };
  }

  return {
    schemaVersion: '0.2',
    hostSettings: isObject(store.hostSettings) ? store.hostSettings : {},
    modules: Array.isArray(store.modules)
      ? store.modules.map(normalizeInstalledModuleRecord).filter(Boolean)
      : [],
  };
}

async function readAuthState(config) {
  return await readJsonIfExists(config.authStatePath, {
    users: [],
    sessions: [],
    moduleAssignments: [],
  });
}

async function readModuleMetadata(module, config) {
  const metadataPath = module.metadataPath
    ? path.isAbsolute(module.metadataPath)
      ? module.metadataPath
      : path.join(config.dataRootContainer, module.metadataPath)
    : path.join(config.modulesRootContainer, module.id, 'metadata.json');

  return await readJsonIfExists(metadataPath, null);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

function getRuntimeConfig() {
  const configuredDataRootHost = process.env.HOST_DATA_ROOT_HOST?.trim();
  const configuredDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER?.trim();
  const dataRootContainer = configuredDataRootContainer || configuredDataRootHost || DEFAULT_DATA_ROOT;
  const dataRootHost = configuredDataRootHost || dataRootContainer;
  const modulesRootContainer = path.join(dataRootContainer, 'modules');
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');

  return {
    dataRootHost,
    dataRootContainer,
    dataRootMarkerPath: path.join(dataRootContainer, DATA_ROOT_MARKER_FILE),
    dataRootExpectedMarker: process.env.HOST_DATA_ROOT_MARKER?.trim() || null,
    modulesRootContainer,
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    moduleDevModeEnabled: isEnabledRuntimeFlag(process.env.HOST_MODULE_DEV_MODE),
    moduleDevTargetsPath: path.join(dataRootContainer, 'dev', 'module-targets.json'),
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    gatewayBaseDomain: normalizeDomain(process.env.HOST_GATEWAY_BASE_DOMAIN),
    hostPublicOrigin: process.env.HOST_PUBLIC_ORIGIN?.trim() || null,
    hostInternalOrigin: process.env.HOST_INTERNAL_ORIGIN?.trim() || 'http://docker-host:3000',
  };
}

async function verifyDataRootMarker(config) {
  const expectedMarker = config.dataRootExpectedMarker;
  if (!expectedMarker) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(config.dataRootMarkerPath, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new GatewayHttpError(
        503,
        'data_root_unavailable',
        `Host data root marker is missing at ${config.dataRootMarkerPath}. The configured data root may not be mounted.`
      );
    }
    if (error instanceof SyntaxError) {
      throw new GatewayHttpError(
        503,
        'data_root_unavailable',
        `Host data root marker at ${config.dataRootMarkerPath} is not valid JSON.`
      );
    }
    throw error;
  }

  const actualMarker = isObject(parsed) && typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (actualMarker !== expectedMarker) {
    throw new GatewayHttpError(
      503,
      'data_root_unavailable',
      `Host data root marker at ${config.dataRootMarkerPath} does not match the running container configuration.`
    );
  }
}

function getModuleNetworkAlias(moduleId, containerKey = 'main') {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}-${containerKey}`;
}

function resolveModuleEndpointTarget(metadata, endpointKey) {
  if (!isObject(metadata) || !Array.isArray(metadata.endpoints) || !Array.isArray(metadata.containers)) {
    return null;
  }

  const endpoint = metadata.endpoints.find(candidate =>
    candidate &&
    candidate.key === endpointKey &&
    typeof candidate.container === 'string' &&
    typeof candidate.port === 'string'
  );
  if (!endpoint) {
    return null;
  }

  const container = metadata.containers.find(candidate => candidate?.key === endpoint.container);
  const port = container?.runtime?.ports?.find(candidate => candidate?.key === endpoint.port);
  if (!port || typeof port.containerPort !== 'number') {
    return null;
  }

  return {
    containerKey: endpoint.container,
    endpoint,
    port,
  };
}

async function resolveModuleDevTarget(hostnameValue, config) {
  const state = await readJsonIfExists(config.moduleDevTargetsPath, {
    schemaVersion: '0.1',
    targets: [],
  });

  return Array.isArray(state.targets)
    ? state.targets.find(candidate =>
        candidate &&
        candidate.enabled !== false &&
        typeof candidate.hostname === 'string' &&
        candidate.hostname.toLowerCase() === hostnameValue &&
        typeof candidate.targetBaseUrl === 'string' &&
        typeof candidate.moduleId === 'string' &&
        typeof candidate.portKey === 'string'
      ) || null
    : null;
}

function parseDevTargetUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:') {
    throw new Error('Module developer gateway targets must use http.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port || 80);
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');

  return {
    hostname,
    port,
    origin: parsed.origin,
    pathPrefix: pathPrefix === '/' ? '' : pathPrefix,
  };
}

function getProxyTarget(target) {
  return {
    hostname: target.proxyHostname || target.networkAlias,
    port: target.proxyPort || target.containerPort,
    pathPrefix: target.targetPathPrefix || '',
  };
}

function buildProxyPath(requestPath, pathPrefix) {
  if (!pathPrefix) {
    return requestPath || '/';
  }

  const normalizedRequestPath = requestPath && requestPath.startsWith('/')
    ? requestPath
    : `/${requestPath || ''}`;
  return `${pathPrefix}${normalizedRequestPath}`;
}

function stripCookieValue(value, cookieName) {
  const cookieHeader = Array.isArray(value) ? value.join('; ') : value;
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(part => part && part.split('=')[0] !== cookieName);

  return cookies.length > 0 ? cookies.join('; ') : null;
}

function stripHostAuthCookies(value) {
  const withoutSession = stripCookieValue(value, SESSION_COOKIE_NAME);
  return withoutSession ? stripCookieValue(withoutSession, ACCOUNT_SET_COOKIE_NAME) : null;
}

function stripCookieDomain(value) {
  const rewrite = cookie => cookie.replace(/;\s*domain=[^;]*/ig, '');
  return Array.isArray(value) ? value.map(rewrite) : typeof value === 'string' ? rewrite(value) : value;
}

function formatHeaderLine(name, value) {
  const normalizedValue = Array.isArray(value) ? value.join(', ') : String(value);
  return `${name}: ${normalizedValue.replace(/[\r\n]+/g, ' ')}`;
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) {
    return null;
  }

  for (const rawCookie of String(cookieHeader).split(';')) {
    const separator = rawCookie.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const cookieName = rawCookie.slice(0, separator).trim();
    if (cookieName === name) {
      return decodeURIComponent(rawCookie.slice(separator + 1).trim());
    }
  }

  return null;
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function appendForwardedFor(req) {
  return req.socket.remoteAddress || '';
}

function stampInternalRequestHeaders(req) {
  req.headers[INTERNAL_REMOTE_ADDRESS_HEADER] = req.socket.remoteAddress || '';
}

function getRequestProtocol(req) {
  const configuredProtocol = parseProtocolFromOrigin(getRuntimeConfig().hostPublicOrigin);
  if (configuredProtocol) {
    return configuredProtocol;
  }

  return req.socket.encrypted ? 'https' : 'http';
}

function parseProtocolFromOrigin(origin) {
  if (!origin) {
    return null;
  }

  try {
    const protocol = new URL(origin).protocol.replace(/:$/, '');
    return protocol === 'http' || protocol === 'https' ? protocol : null;
  } catch {
    return null;
  }
}

function getHostPublicOrigin(req) {
  const config = getRuntimeConfig();
  if (config.hostPublicOrigin) {
    return config.hostPublicOrigin.replace(/\/+$/, '');
  }

  if (config.gatewayBaseDomain) {
    return `${getRequestProtocol(req)}://host.${config.gatewayBaseDomain}`;
  }

  return `${getRequestProtocol(req)}://${req.headers.host}`;
}

function parseHostname(hostHeader) {
  if (!hostHeader || Array.isArray(hostHeader)) {
    return null;
  }

  const value = hostHeader.trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : null;
  }

  return value.split(':')[0].replace(/\.$/, '');
}

function parseHostnameFromOrigin(origin) {
  if (!origin) {
    return null;
  }

  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeDomain(value) {
  const normalized = value?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return normalized || null;
}

function isEnabledRuntimeFlag(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'enabled' ||
    normalized === 'on' ||
    normalized === 'yes';
}

function getExposureIdentityMode(exposure, exposurePolicy) {
  const identityMode = exposure.identityMode;
  return identityMode === 'none' || identityMode === 'optional' || identityMode === 'required'
    ? identityMode
    : getDefaultModuleIdentityMode(exposurePolicy);
}

function acceptsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function getGatewayErrorStatus(error, fallback = 500) {
  return error instanceof GatewayHttpError ? error.status : fallback;
}

function getGatewayErrorMessage(error) {
  return error instanceof Error ? error.message : 'Gateway request failed.';
}

function sendPlain(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${body}\n`);
}

function sendUpgradeDenied(socket, status) {
  const reason = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : status === 503
          ? 'Service Unavailable'
          : 'Bad Gateway';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function appendGatewayAuditEvent(req, target, allowed = false) {
  const config = getRuntimeConfig();
  const event = {
    id: `evt_${randomUUID()}`,
    type: allowed ? 'gateway.module.opened' : 'gateway.access.denied',
    createdAt: new Date().toISOString(),
    actorUserId: target.principal?.id,
    success: allowed,
    target: {
      type: 'module',
      id: target.exposure.moduleId,
    },
    request: {
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    },
    details: {
      moduleId: target.exposure.moduleId,
      hostname: target.exposure.hostname,
      endpointKey: target.exposure.endpointKey,
      exposurePolicy: target.exposure.exposurePolicy,
      reason: target.access.reason,
      path: req.url || '/',
      upgrade: req.headers.upgrade || undefined,
    },
  };

  try {
    await fs.mkdir(path.dirname(config.authAuditPath), { recursive: true });
    await fs.appendFile(config.authAuditPath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (error) {
    console.error('Unable to append gateway audit event:', error);
  }
}

function normalizeInstalledModuleRecord(value) {
  if (!isInstalledModuleRecord(value)) {
    return null;
  }

  const {
    containerName: legacyContainerName,
    networkAlias: legacyNetworkAlias,
    image: legacyImage,
    containers,
    ...record
  } = value;

  return {
    ...record,
    containers: Array.isArray(containers)
      ? containers
      : [
          {
            key: 'main',
            containerName: typeof legacyContainerName === 'string' && legacyContainerName
              ? legacyContainerName
              : getLegacyModuleDockerName(value.id),
            networkAlias: typeof legacyNetworkAlias === 'string' && legacyNetworkAlias
              ? legacyNetworkAlias
              : getLegacyModuleDockerName(value.id),
            image: normalizeLegacyImage(legacyImage),
          },
        ],
  };
}

function isInstalledModuleRecord(value) {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.metadataUrl === 'string';
}

function normalizeLegacyImage(image) {
  const source = isObject(image) ? image : {};
  const repository = typeof source.repository === 'string' && source.repository
    ? source.repository
    : 'unknown';
  const tag = typeof source.tag === 'string' && source.tag ? source.tag : 'latest';
  const reference = typeof source.reference === 'string' && source.reference
    ? source.reference
    : `${repository}:${tag}`;
  const pullPolicy = typeof source.pullPolicy === 'string' && source.pullPolicy
    ? source.pullPolicy
    : undefined;

  return {
    repository,
    tag,
    reference,
    ...(pullPolicy ? { pullPolicy } : {}),
  };
}

function getLegacyModuleDockerName(moduleId) {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}`;
}

function isControlRequestPath(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url, 'http://docker-host.local');
    return parsed.pathname === '/control/v1' || parsed.pathname.startsWith('/control/v1/');
  } catch {
    return false;
  }
}

async function writeControlDiscoveryFile() {
  const config = getRuntimeConfig();
  await verifyDataRootMarker(config);
  const runRoot = path.join(config.dataRootContainer, 'run');
  const discoveryPath = path.join(runRoot, 'control.json');
  const temporaryPath = `${discoveryPath}.${process.pid}.${randomUUID()}.tmp`;
  const endpoint = getControlEndpoint();
  const discovery = {
    schemaVersion: '0.1',
    controlContractVersion: CONTROL_CONTRACT_VERSION,
    instanceId: controlInstanceId,
    transport: 'http-loopback',
    endpoint,
    headers: {
      cliVersion: 'X-Docker-Host-Cli-Version',
      controlContractVersion: CONTROL_CONTRACT_HEADER,
      controlSecret: CONTROL_SECRET_HEADER,
    },
    secret: controlSecret,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(discovery, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, discoveryPath);
  await fs.chmod(discoveryPath, 0o600);
}

function getControlEndpoint() {
  const publicPort = process.env.HOST_CONTROL_PUBLIC_PORT || process.env.PORT || String(port);
  const origin = process.env.HOST_CONTROL_ORIGIN?.trim() ||
    `http://127.0.0.1:${publicPort.trim()}`;

  return {
    url: `${origin.replace(/\/+$/, '')}/control/v1`,
    host: '127.0.0.1',
    port: Number.parseInt(publicPort, 10),
    basePath: '/control/v1',
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

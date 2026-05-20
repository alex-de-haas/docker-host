import { NextResponse } from 'next/server';
import { canUseHostApi } from './auth-policy.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import {
  authenticateCliToken,
  authenticateSessionToken,
  getAuthStatus,
  hasRecentSessionReauthentication,
  isAuthServiceError,
  revokeSession,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
} from './auth-service.ts';
import { authenticateTrustedProxyRequest } from './trusted-proxy.mjs';
import { appendAuthAuditEvent } from './auth-store.ts';
import type { AuthRequestMeta } from './auth-service.ts';
import type { HostApiAction, HostPrincipal } from '../types/auth.ts';

export interface AuthenticatedRequest {
  principal: HostPrincipal;
  source: 'session' | 'cli-token' | 'trusted-proxy';
}

export async function requireHostPrincipal(
  request: Request,
  action: HostApiAction
): Promise<AuthenticatedRequest | NextResponse> {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    return authError('setup_required', 'Docker Host setup must be completed first.', 403, {
      action,
      nextStep: 'Open /setup and complete the first administrator setup.',
    });
  }

  const auth = await authenticateRequest(request);
  if (!auth.principal) {
    await appendDeniedHostApiAudit(action, 'unauthorized', null, request);
    return authError('unauthorized', 'Authentication is required.', 401, {
      action,
      nextStep: 'Sign in to Docker Host.',
    });
  }

  if (auth.source !== 'cli-token' && isMutatingMethod(request.method) && !passesSameOriginCheck(request)) {
    await appendDeniedHostApiAudit(action, 'csrf_rejected', auth.principal, request);
    return authError('csrf_rejected', 'State-changing requests must come from the same origin.', 403, {
      action,
      nextStep: 'Retry the action from the Docker Host Web UI.',
    });
  }

  return {
    principal: auth.principal,
    source: auth.source,
  };
}

export async function requireHostAdmin(
  request: Request,
  action: HostApiAction
): Promise<AuthenticatedRequest | NextResponse> {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    return authError('setup_required', 'Docker Host setup must be completed first.', 403, {
      action,
      nextStep: 'Open /setup and complete the first administrator setup.',
    });
  }

  const auth = await authenticateRequest(request);
  if (!auth.principal) {
    await appendDeniedHostApiAudit(action, 'unauthorized', null, request);
    return authError('unauthorized', 'Authentication is required.', 401, {
      action,
      nextStep: 'Sign in to Docker Host.',
    });
  }

  if (!canUseHostApi(auth.principal, action)) {
    await appendDeniedHostApiAudit(action, 'forbidden', auth.principal, request);
    return authError('forbidden', 'A Host administrator account is required.', 403, {
      action,
      requiredRole: 'host.admin',
      nextStep: 'Switch to a Host administrator account.',
    });
  }

  if (auth.source !== 'cli-token' && isMutatingMethod(request.method) && !passesSameOriginCheck(request)) {
    await appendDeniedHostApiAudit(action, 'csrf_rejected', auth.principal, request);
    return authError('csrf_rejected', 'State-changing requests must come from the same origin.', 403, {
      action,
      nextStep: 'Retry the action from the Docker Host Web UI.',
    });
  }

  return {
    principal: auth.principal,
    source: auth.source,
  };
}

export async function requireRecentReauthentication(
  auth: AuthenticatedRequest,
  action: HostApiAction
): Promise<true | NextResponse> {
  if (auth.source !== 'session') {
    return true;
  }

  const sessionId = 'sessionId' in auth.principal
    ? String(auth.principal.sessionId)
    : '';
  if (sessionId && await hasRecentSessionReauthentication(sessionId)) {
    return true;
  }

  return authError('reauth_required', 'Recent administrator reauthentication is required.', 403, {
    action,
    requiredRole: 'host.admin',
    nextStep: 'Reauthenticate from Security settings, then retry this action.',
  });
}

export async function authenticateRequest(request: Request): Promise<{
  principal: HostPrincipal | null;
  source: 'session' | 'cli-token' | 'trusted-proxy';
}> {
  const meta = getRequestMeta(request);
  const bearerToken = getBearerToken(request);
  const cliPrincipal = await authenticateCliToken(bearerToken, meta);
  if (cliPrincipal) {
    return {
      principal: cliPrincipal,
      source: 'cli-token',
    };
  }

  const trustedProxy = await authenticateTrustedProxyRequest(request, getHostRuntimeConfig());
  if (trustedProxy.principal) {
    return {
      principal: trustedProxy.principal,
      source: 'trusted-proxy',
    };
  }

  if (trustedProxy.modeActive) {
    return {
      principal: null,
      source: 'trusted-proxy',
    };
  }

  const sessionToken = getCookieValue(request, SESSION_COOKIE_NAME);
  const sessionPrincipal = await authenticateSessionToken(sessionToken, meta);
  return {
    principal: sessionPrincipal,
    source: 'session',
  };
}

export async function revokeRequestSession(request: Request) {
  const sessionToken = getCookieValue(request, SESSION_COOKIE_NAME);
  return await revokeSession(sessionToken, getRequestMeta(request));
}

export function createSessionCookieResponse<TBody>(
  request: Request,
  body: TBody,
  sessionToken: string,
  status = 200
) {
  const response = NextResponse.json(body, { status });
  const domain = getSessionCookieDomain(request);
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    maxAge: Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000),
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
    ...(domain ? { domain } : {}),
  });
  return response;
}

export function createSessionRedirectResponse(
  request: Request,
  location: string,
  sessionToken: string,
  status = 302
) {
  const response = NextResponse.redirect(new URL(location, request.url), status);
  const domain = getSessionCookieDomain(request);
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    maxAge: Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000),
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(request),
    ...(domain ? { domain } : {}),
  });
  return response;
}

export function createClearSessionCookieResponse<TBody>(body: TBody, status = 200, request?: Request) {
  const response = NextResponse.json(body, { status });
  const domain = request ? getSessionCookieDomain(request) : null;
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    ...(domain ? { domain } : {}),
  });
  return response;
}

export function assertSecureEnoughForCookies(request: Request) {
  if (!isLoopbackRequest(request) && !isSecureRequest(request)) {
    throw new AuthHttpError(
      'https_required',
      'Non-loopback Host authentication requires HTTPS before cookies can be issued.',
      400
    );
  }
}

export function authExceptionResponse(error: unknown) {
  if (error instanceof AuthHttpError) {
    return authError(error.code, error.message, error.status);
  }

  if (isAuthServiceError(error)) {
    const status = error.code === 'invalid_credentials' ? 401 : 400;
    return authError(error.code, error.message, status);
  }

  console.error('Authentication route failed:', error);
  return authError('auth_failed', error instanceof Error ? error.message : 'Unknown authentication error', 500);
}

export function authError(
  code: string,
  message: string,
  status: number,
  metadata: {
    requiredRole?: string;
    action?: HostApiAction;
    nextStep?: string;
  } = {}
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...metadata,
      },
    },
    { status }
  );
}

export function getRequestMeta(request: Request): AuthRequestMeta {
  return {
    origin: request.headers.get('origin') ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  };
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim() || null;
}

async function appendDeniedHostApiAudit(
  action: HostApiAction,
  reason: string,
  principal: HostPrincipal | null,
  request: Request
) {
  await appendAuthAuditEvent({
    type: 'auth.host_api.denied',
    actorUserId: principal?.id,
    target: {
      type: 'host.api',
      id: action,
    },
    success: false,
    request: getRequestMeta(request),
    details: {
      action,
      reason,
    },
  });
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  for (const rawCookie of cookieHeader.split(';')) {
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

function isMutatingMethod(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function passesSameOriginCheck(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    return origin === getRequestOrigin(request);
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) {
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }

  return false;
}

function isSecureRequest(request: Request) {
  return request.headers.get('x-forwarded-proto') === 'https' ||
    new URL(request.url).protocol === 'https:';
}

export function isLoopbackRequest(request: Request) {
  return [
    new URL(request.url).hostname,
    parseHeaderHostname(request.headers.get('host')),
  ].some(hostname => hostname ? isLoopbackHostname(hostname) : false);
}

export function getRequestOrigin(request: Request) {
  const configuredOrigin = getConfiguredPublicOrigin();
  if (configuredOrigin) {
    return configuredOrigin;
  }

  const url = new URL(request.url);
  const host = parseHeaderHost(request.headers.get('host')) ||
    url.host;
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    url.protocol.replace(/:$/, '');

  return `${protocol}://${host}`;
}

function getConfiguredPublicOrigin() {
  const origin = getHostRuntimeConfig().hostPublicOrigin;
  if (!origin) {
    return null;
  }

  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, '') || null;
  }
}

function parseHeaderHost(value: string | null) {
  return value?.split(',')[0]?.trim() || null;
}

function parseHeaderHostname(value: string | null) {
  const host = parseHeaderHost(value);
  if (!host) {
    return null;
  }

  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }

  return host.split(':')[0] || null;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost');
}

function getSessionCookieDomain(request: Request) {
  const baseDomain = getHostRuntimeConfig().gatewayBaseDomain;
  if (!baseDomain) {
    return null;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  const normalizedBaseDomain = baseDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (hostname === normalizedBaseDomain || hostname.endsWith(`.${normalizedBaseDomain}`)) {
    return normalizedBaseDomain;
  }

  return null;
}

class AuthHttpError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AuthHttpError';
    this.code = code;
    this.status = status;
  }
}

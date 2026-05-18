import { NextResponse } from 'next/server';
import { canUseHostApi } from './auth-policy.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import {
  authenticateCliToken,
  authenticateSessionToken,
  getAuthStatus,
  isAuthServiceError,
  revokeSession,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
} from './auth-service.ts';
import type { AuthRequestMeta } from './auth-service.ts';
import type { HostApiAction, HostPrincipal } from '../types/auth.ts';

export interface AuthenticatedRequest {
  principal: HostPrincipal;
  source: 'session' | 'cli-token';
}

export async function requireHostAdmin(
  request: Request,
  action: HostApiAction
): Promise<AuthenticatedRequest | NextResponse> {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    return authError('setup_required', 'Docker Host setup must be completed first.', 403);
  }

  const auth = await authenticateRequest(request);
  if (!auth.principal) {
    return authError('unauthorized', 'Authentication is required.', 401);
  }

  if (!canUseHostApi(auth.principal, action)) {
    return authError('forbidden', 'A Host administrator account is required.', 403);
  }

  if (auth.source === 'session' && isMutatingMethod(request.method) && !passesSameOriginCheck(request)) {
    return authError('csrf_rejected', 'State-changing requests must come from the same origin.', 403);
  }

  return {
    principal: auth.principal,
    source: auth.source,
  };
}

export async function authenticateRequest(request: Request): Promise<{
  principal: HostPrincipal | null;
  source: 'session' | 'cli-token';
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

export function authError(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
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

function isLoopbackRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost');
}

function getRequestOrigin(request: Request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
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
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

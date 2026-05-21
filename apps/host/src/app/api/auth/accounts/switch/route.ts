import { NextResponse } from 'next/server';
import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  createSessionCookieResponse,
  getRequestAccountSetToken,
  getRequestMeta,
  requireHostPrincipal,
} from '@/lib/auth-http';
import { switchBrowserAccount } from '@/lib/auth-service';
import { getDefaultHostShellPath } from '@/lib/auth-policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    assertSecureEnoughForCookies(request);
    const body = await readJson(request);
    const result = await switchBrowserAccount({
      accountSetToken: getRequestAccountSetToken(request),
      userId: readString(body, 'userId'),
      actorUserId: auth.principal.id,
    }, getRequestMeta(request));

    return createSessionCookieResponse(request, {
      authenticated: true,
      user: result.user,
      redirectTo: getDefaultHostShellPath(result.user),
    }, result.sessionToken);
  } catch (error) {
    return authExceptionResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string) {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

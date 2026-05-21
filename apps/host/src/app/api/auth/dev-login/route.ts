import { NextResponse } from 'next/server';
import {
  assertSecureEnoughForCookies,
  authError,
  authExceptionResponse,
  createSessionRedirectResponse,
  getRequestOrigin,
  getRequestMeta,
  isLoopbackRequest,
} from '@/lib/auth-http';
import {
  createDevSession,
  isDevAuthAutoLoginEnabled,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!isDevAuthAutoLoginEnabled()) {
    return NextResponse.json({
      error: {
        code: 'not_found',
        message: 'Not found.',
      },
    }, { status: 404 });
  }

  if (!isLoopbackRequest(request)) {
    return authError(
      'dev_auth_loopback_required',
      'Development auto-login is only available from loopback hosts.',
      403
    );
  }

  try {
    assertSecureEnoughForCookies(request);
    const result = await createDevSession(getRequestMeta(request));
    return createSessionRedirectResponse(request, getRedirectTo(request), result.sessionToken);
  } catch (error) {
    return authExceptionResponse(error);
  }
}

function getRedirectTo(request: Request) {
  const value = new URL(request.url).searchParams.get('redirectTo') || '/';
  const path = value.startsWith('/') && !value.startsWith('//') ? value : '/';
  return `${getRequestOrigin(request)}${path}`;
}

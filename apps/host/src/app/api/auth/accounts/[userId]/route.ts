import { NextResponse } from 'next/server';
import {
  clearAccountSetCookie,
  clearSessionCookie,
  authExceptionResponse,
  getRequestAccountSetToken,
  getRequestMeta,
  getRequestSessionToken,
  requireHostPrincipal,
} from '@/lib/auth-http';
import { removeBrowserAccount } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { userId } = await params;
  let result: Awaited<ReturnType<typeof removeBrowserAccount>>;
  try {
    result = await removeBrowserAccount({
      accountSetToken: getRequestAccountSetToken(request),
      userId,
      activeSessionToken: auth.principal.id === userId ? getRequestSessionToken(request) : null,
    }, getRequestMeta(request));
  } catch (error) {
    return authExceptionResponse(error);
  }

  const response = NextResponse.json({
    removed: result.removed,
    authenticated: !result.activeSessionRevoked,
    accountSetRevoked: result.accountSetRevoked,
  }, { status: result.removed ? 200 : 404 });

  if (result.activeSessionRevoked) {
    clearSessionCookie(response, request);
  }
  if (result.accountSetRevoked) {
    clearAccountSetCookie(response, request);
  }

  return response;
}

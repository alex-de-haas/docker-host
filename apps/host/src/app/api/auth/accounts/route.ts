import { NextResponse } from 'next/server';
import {
  clearAccountSetCookie,
  clearSessionCookie,
  getRequestAccountSetToken,
  getRequestMeta,
  getRequestSessionToken,
  requireHostPrincipal,
} from '@/lib/auth-http';
import { clearBrowserAccountSet, listBrowserAccounts } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const summary = await listBrowserAccounts(
    getRequestAccountSetToken(request),
    auth.principal
  );

  return NextResponse.json(summary);
}

export async function DELETE(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const result = await clearBrowserAccountSet({
    accountSetToken: getRequestAccountSetToken(request),
    activeSessionToken: getRequestSessionToken(request),
    actorUserId: auth.principal.id,
  }, getRequestMeta(request));

  const response = NextResponse.json({
    cleared: true,
    authenticated: false,
    ...result,
  });
  clearSessionCookie(response, request);
  clearAccountSetCookie(response, request);
  return response;
}

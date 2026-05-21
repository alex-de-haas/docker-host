import { NextResponse } from 'next/server';
import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  clearAccountSetCookie,
  clearSessionCookie,
  getRequestAccountSetToken,
  getRequestMeta,
  getRequestSessionToken,
  requireHostPrincipal,
  setAccountSetCookie,
} from '@/lib/auth-http';
import {
  addUserToBrowserAccountSet,
  clearBrowserAccountSet,
  isDevAuthBrowserAccountSeedEnabled,
  listBrowserAccounts,
  prepareDevBrowserAccountUsers,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const initialAccountSetToken = getRequestAccountSetToken(request);
  let accountSetToken = initialAccountSetToken;

  if (isDevAuthBrowserAccountSeedEnabled()) {
    try {
      assertSecureEnoughForCookies(request);
      const devUsers = await prepareDevBrowserAccountUsers();
      for (const user of devUsers) {
        const accountSet = await addUserToBrowserAccountSet({
          accountSetToken,
          userId: user.id,
        }, getRequestMeta(request));
        accountSetToken = accountSet.accountSetToken;
      }
    } catch (error) {
      return authExceptionResponse(error);
    }
  }

  const summary = await listBrowserAccounts(
    accountSetToken,
    auth.principal
  );

  const response = NextResponse.json(summary);
  if (accountSetToken && accountSetToken !== initialAccountSetToken) {
    setAccountSetCookie(response, request, accountSetToken);
  }
  return response;
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

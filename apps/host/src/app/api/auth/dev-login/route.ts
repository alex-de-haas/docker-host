import { NextResponse } from 'next/server';
import {
  assertSecureEnoughForCookies,
  authError,
  authExceptionResponse,
  createSessionAndAccountSetRedirectResponse,
  getRequestAccountSetToken,
  getRequestOrigin,
  getRequestMeta,
  isLoopbackRequest,
} from '@/lib/auth-http';
import {
  addUserToBrowserAccountSet,
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
    const accountSet = await addDevBrowserAccountsToAccountSet(
      getRequestAccountSetToken(request),
      result.browserAccountUsers,
      request
    );
    return createSessionAndAccountSetRedirectResponse(
      request,
      getRedirectTo(request),
      result.sessionToken,
      accountSet.accountSetToken
    );
  } catch (error) {
    return authExceptionResponse(error);
  }
}

async function addDevBrowserAccountsToAccountSet(
  initialAccountSetToken: string | null,
  users: Array<{ id: string }>,
  request: Request
) {
  let accountSetToken = initialAccountSetToken;
  let accountSet: Awaited<ReturnType<typeof addUserToBrowserAccountSet>> | null = null;

  for (const user of users) {
    accountSet = await addUserToBrowserAccountSet({
      accountSetToken,
      userId: user.id,
    }, getRequestMeta(request));
    accountSetToken = accountSet.accountSetToken;
  }

  if (!accountSet) {
    throw new Error('Development account set could not be prepared.');
  }

  return accountSet;
}

function getRedirectTo(request: Request) {
  const value = new URL(request.url).searchParams.get('redirectTo') || '/';
  const path = value.startsWith('/') && !value.startsWith('//') ? value : '/';
  return `${getRequestOrigin(request)}${path}`;
}

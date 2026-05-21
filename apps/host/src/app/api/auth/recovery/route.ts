import {
  authExceptionResponse,
  assertSecureEnoughForCookies,
  createSessionAndAccountSetCookieResponse,
  getRequestAccountSetToken,
  getRequestMeta,
} from '@/lib/auth-http';
import { addUserToBrowserAccountSet, recoverHostAdmin } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSecureEnoughForCookies(request);
    const input = await request.json() as {
      recoveryToken?: string;
      email?: string;
      password?: string;
      displayName?: string;
    };

    const result = await recoverHostAdmin({
      recoveryToken: input.recoveryToken || '',
      email: input.email || '',
      password: input.password || '',
      displayName: input.displayName,
    }, getRequestMeta(request));
    const accountSet = await addUserToBrowserAccountSet({
      accountSetToken: getRequestAccountSetToken(request),
      userId: result.user.id,
    }, getRequestMeta(request));

    return createSessionAndAccountSetCookieResponse(request, {
      authenticated: true,
      recovered: true,
      user: result.user,
    }, result.sessionToken, accountSet.accountSetToken, 201);
  } catch (error) {
    return authExceptionResponse(error);
  }
}

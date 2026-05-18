import {
  authExceptionResponse,
  assertSecureEnoughForCookies,
  createSessionCookieResponse,
  getRequestMeta,
} from '@/lib/auth-http';
import { recoverHostAdmin } from '@/lib/auth-service';

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

    return createSessionCookieResponse(request, {
      authenticated: true,
      recovered: true,
      user: result.user,
    }, result.sessionToken, 201);
  } catch (error) {
    return authExceptionResponse(error);
  }
}

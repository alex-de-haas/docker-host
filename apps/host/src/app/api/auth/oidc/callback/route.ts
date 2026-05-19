import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  createSessionRedirectResponse,
  getRequestMeta,
} from '@/lib/auth-http';
import { AuthServiceError } from '@/lib/auth-service';
import { completeOidcLogin } from '@/lib/oidc-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    assertSecureEnoughForCookies(request);
    const url = new URL(request.url);
    const error = url.searchParams.get('error');
    if (error) {
      throw new AuthServiceError('oidc_provider_error', url.searchParams.get('error_description') || error);
    }

    const result = await completeOidcLogin({
      state: url.searchParams.get('state') || '',
      code: url.searchParams.get('code') || '',
      requestOrigin: url.origin,
    }, getRequestMeta(request));

    return createSessionRedirectResponse(request, result.redirectTo, result.sessionToken);
  } catch (caught) {
    return authExceptionResponse(caught);
  }
}

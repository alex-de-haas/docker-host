import { NextResponse } from 'next/server';
import { authExceptionResponse, getRequestMeta } from '@/lib/auth-http';
import { startOidcLogin } from '@/lib/oidc-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const result = await startOidcLogin({
      requestOrigin: url.origin,
      redirectTo: url.searchParams.get('redirectTo'),
    }, getRequestMeta(request));

    return NextResponse.redirect(result.authorizationUrl);
  } catch (error) {
    return authExceptionResponse(error);
  }
}

import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin, requireRecentReauthentication } from '@/lib/auth-http';
import { revokeSessionById } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const reauth = await requireRecentReauthentication(auth, 'host.auth.configure');
  if (reauth instanceof NextResponse) {
    return reauth;
  }

  const { sessionId } = await params;
  const revoked = await revokeSessionById(sessionId, auth.principal.id, getRequestMeta(request));
  if (!revoked) {
    return NextResponse.json({
      error: {
        code: 'session_not_found',
        message: 'Session was not found, already revoked, or expired.',
      },
    }, { status: 404 });
  }

  return NextResponse.json({
    revoked: true,
    sessionId,
  });
}

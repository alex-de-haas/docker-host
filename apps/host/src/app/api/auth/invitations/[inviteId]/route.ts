import { NextResponse } from 'next/server';
import {
  getRequestMeta,
  requireHostAdmin,
  requireRecentReauthentication,
} from '@/lib/auth-http';
import {
  isAuthServiceError,
  revokeUserInvitation,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> }
) {
  const auth = await requireHostAdmin(request, 'host.users.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const reauth = await requireRecentReauthentication(auth, 'host.users.manage');
  if (reauth instanceof NextResponse) {
    return reauth;
  }

  try {
    const { inviteId } = await params;
    const revoked = await revokeUserInvitation(inviteId, auth.principal.id, getRequestMeta(request));
    return NextResponse.json({ revoked });
  } catch (error) {
    if (isAuthServiceError(error)) {
      return NextResponse.json({
        error: {
          code: error.code,
          message: error.message,
        },
      }, { status: 400 });
    }

    console.error('Error revoking user invitation:', error);
    return NextResponse.json({
      error: {
        code: 'invitation_revoke_failed',
        message: error instanceof Error ? error.message : 'Unknown invitation revoke error',
      },
    }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
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
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { inviteId } = await params;
    const revoked = await revokeUserInvitation(inviteId, LOCAL_CONTROL_ACTOR_ID, getRequestMeta(request));
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

    console.error('Error revoking control user invitation:', error);
    return NextResponse.json({
      error: {
        code: 'invitation_revoke_failed',
        message: error instanceof Error ? error.message : 'Unknown invitation revoke error',
      },
    }, { status: 500 });
  }
}

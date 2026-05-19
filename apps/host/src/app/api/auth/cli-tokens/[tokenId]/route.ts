import { NextResponse } from 'next/server';
import { requireHostAdmin, requireRecentReauthentication } from '@/lib/auth-http';
import {
  isAuthServiceError,
  revokeCliToken,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ tokenId: string }> }
) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const reauth = await requireRecentReauthentication(auth, 'host.auth.configure');
  if (reauth instanceof NextResponse) {
    return reauth;
  }

  try {
    const { tokenId } = await params;
    const revoked = await revokeCliToken(tokenId, auth.principal.id);
    if (!revoked) {
      return NextResponse.json({
        error: {
          code: 'cli_token_not_found',
          message: 'CLI token was not found or is already revoked.',
        },
      }, { status: 404 });
    }

    return NextResponse.json({
      revoked: true,
      tokenId,
    });
  } catch (error) {
    return cliTokenErrorResponse(error);
  }
}

function cliTokenErrorResponse(error: unknown) {
  if (isAuthServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: 400 });
  }

  console.error('Error revoking CLI token:', error);
  return NextResponse.json({
    error: {
      code: 'cli_token_failed',
      message: error instanceof Error ? error.message : 'Unknown CLI token error',
    },
  }, { status: 500 });
}

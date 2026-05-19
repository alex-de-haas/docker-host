import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isModuleDirectoryServiceError,
  revokeModuleServiceTokenForModule,
} from '@/lib/module-directory-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ moduleId: string; tokenId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.directory.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { moduleId, tokenId } = await params;
    await revokeModuleServiceTokenForModule(moduleId, tokenId, auth.principal.id);
    return NextResponse.json({
      revoked: true,
      tokenId,
    });
  } catch (error) {
    console.error('Error revoking module service token:', error);
    return moduleDirectoryErrorResponse(error);
  }
}

function moduleDirectoryErrorResponse(error: unknown) {
  if (isModuleDirectoryServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.status });
  }

  return NextResponse.json({
    error: {
      code: 'module_service_token_failed',
      message: error instanceof Error ? error.message : 'Unknown module service token error',
    },
  }, { status: 500 });
}

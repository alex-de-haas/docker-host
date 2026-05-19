import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin } from '@/lib/auth-http';
import { applyModuleInstallRequest } from '@/lib/module-install-apply';
import { appendModuleOperationAudit } from '@/lib/module-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.install');
  if (auth instanceof NextResponse) {
    return auth;
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    body = null;
  }

  try {
    const result = await applyModuleInstallRequest(body);
    await appendModuleOperationAudit({
      operation: 'install',
      moduleId: result.body.error === null ? result.body.module.id : undefined,
      actorUserId: auth.principal.id,
      success: result.body.error === null,
      httpStatus: result.status,
      request: getRequestMeta(request),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    await appendModuleOperationAudit({
      operation: 'install',
      actorUserId: auth.principal.id,
      success: false,
      httpStatus: 500,
      request: getRequestMeta(request),
    });
    console.error('Error applying install request:', error);
    return NextResponse.json(
      {
        error: {
          code: 'install_apply_failed',
          message: error instanceof Error ? error.message : 'Unknown install apply error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin } from '@/lib/auth-http';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { applyModuleConfigurationRequest } from '@/lib/module-configuration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.update');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await params;
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    body = null;
  }

  try {
    const result = await applyModuleConfigurationRequest(moduleId, body);
    await appendModuleOperationAudit({
      operation: 'configure',
      moduleId,
      actorUserId: auth.principal.id,
      success: result.body.error === null,
      httpStatus: result.status,
      request: getRequestMeta(request),
      details: {
        recreatedContainers: result.body.error === null ? result.body.recreatedContainers : undefined,
      },
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    await appendModuleOperationAudit({
      operation: 'configure',
      moduleId,
      actorUserId: auth.principal.id,
      success: false,
      httpStatus: 500,
      request: getRequestMeta(request),
    });
    console.error('Error applying module configuration:', error);
    return NextResponse.json(
      {
        error: {
          code: 'module_configuration_apply_failed',
          message: error instanceof Error ? error.message : 'Unknown module configuration apply error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

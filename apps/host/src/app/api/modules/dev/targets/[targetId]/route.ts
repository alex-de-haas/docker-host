import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  deleteModuleDevTarget,
  isModuleDevServiceError,
  upsertModuleDevTarget,
} from '@/lib/module-dev-service';
import type { ModuleDevTargetInput } from '@/types/module-dev';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.development.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { targetId } = await params;
    const input = await request.json() as ModuleDevTargetInput;
    const target = await upsertModuleDevTarget({
      ...input,
      id: targetId,
    }, auth.principal.id);
    return NextResponse.json({ target });
  } catch (error) {
    console.error('Error updating module developer target:', error);
    return moduleDevErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.development.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { targetId } = await params;
    const target = await deleteModuleDevTarget(targetId, auth.principal.id);
    if (!target) {
      return NextResponse.json({
        error: {
          code: 'module_dev_target_not_found',
          message: `Module developer target "${targetId}" was not found.`,
        },
      }, { status: 404 });
    }

    return NextResponse.json({ target });
  } catch (error) {
    console.error('Error deleting module developer target:', error);
    return moduleDevErrorResponse(error);
  }
}

function moduleDevErrorResponse(error: unknown) {
  if (isModuleDevServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
        validationErrors: error.validationErrors,
      },
    }, { status: error.status });
  }

  return NextResponse.json({
    error: {
      code: 'module_dev_failed',
      message: error instanceof Error ? error.message : 'Unknown module developer mode error',
    },
  }, { status: 500 });
}

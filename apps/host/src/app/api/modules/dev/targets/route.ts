import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isModuleDevServiceError,
  listModuleDevTargets,
  upsertModuleDevTarget,
} from '@/lib/module-dev-service';
import type { ModuleDevTargetInput } from '@/types/module-dev';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.development.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    return NextResponse.json(await listModuleDevTargets());
  } catch (error) {
    console.error('Error listing module developer targets:', error);
    return moduleDevErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.development.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const input = await request.json() as ModuleDevTargetInput;
    const target = await upsertModuleDevTarget(input, auth.principal.id);
    return NextResponse.json({ target }, { status: 201 });
  } catch (error) {
    console.error('Error saving module developer target:', error);
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

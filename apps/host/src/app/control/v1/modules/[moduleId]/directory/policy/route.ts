import { NextResponse } from 'next/server';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import {
  isModuleDirectoryServiceError,
  setModuleDirectoryPolicy,
} from '@/lib/module-directory-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { moduleId } = await params;
    const input = await request.json() as { includeEmail?: unknown };
    if (typeof input.includeEmail !== 'boolean') {
      return NextResponse.json({
        error: {
          code: 'invalid_module_directory_policy',
          message: 'includeEmail must be a boolean.',
        },
      }, { status: 400 });
    }

    const policy = await setModuleDirectoryPolicy(
      moduleId,
      { includeEmail: input.includeEmail },
      LOCAL_CONTROL_ACTOR_ID
    );
    return NextResponse.json({ policy });
  } catch (error) {
    console.error('Error updating control module directory policy:', error);
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
      code: 'module_directory_policy_failed',
      message: error instanceof Error ? error.message : 'Unknown module directory policy error',
    },
  }, { status: 500 });
}

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  createModuleServiceToken,
  isModuleDirectoryServiceError,
  setModuleDirectoryPolicy,
} from '@/lib/module-directory-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.directory.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { moduleId } = await params;
    const input = await readOptionalJson(request);
    const label = typeof input.label === 'string' ? input.label : undefined;
    if (typeof input.includeEmail === 'boolean') {
      await setModuleDirectoryPolicy(moduleId, { includeEmail: input.includeEmail }, auth.principal.id);
    }

    const serviceToken = await createModuleServiceToken({
      moduleId,
      label,
    }, auth.principal.id);

    return NextResponse.json({
      serviceToken: {
        tokenId: serviceToken.tokenId,
        moduleId: serviceToken.moduleId,
        label: serviceToken.label,
        createdAt: serviceToken.createdAt,
      },
      token: serviceToken.token,
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating module service token:', error);
    return moduleDirectoryErrorResponse(error);
  }
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return isObject(body) ? body : {};
  } catch {
    return {};
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

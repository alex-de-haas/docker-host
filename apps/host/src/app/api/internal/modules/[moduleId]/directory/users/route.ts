import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import {
  authenticateModuleServiceToken,
  getModuleDirectoryUsers,
  isModuleDirectoryServiceError,
} from '@/lib/module-directory-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  try {
    const { moduleId } = await params;
    const principal = await authenticateModuleServiceToken(
      getBearerToken(request),
      getRequestMeta(request)
    );
    const directory = await getModuleDirectoryUsers(moduleId, principal);
    return NextResponse.json(directory, {
      headers: {
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (error) {
    console.error('Error reading module directory:', error);
    return moduleDirectoryErrorResponse(error);
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim() || null;
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
      code: 'module_directory_failed',
      message: error instanceof Error ? error.message : 'Unknown module directory error',
    },
  }, { status: 500 });
}

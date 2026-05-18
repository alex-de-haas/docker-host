import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { applyModuleUpdateRequest } from '@/lib/module-update-apply';

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
    const result = await applyModuleUpdateRequest(moduleId, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Error applying update request:', error);
    return NextResponse.json(
      {
        error: {
          code: 'update_apply_failed',
          message: error instanceof Error ? error.message : 'Unknown update apply error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { applyModuleInstallRequest } from '@/lib/module-install-apply';

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
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
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

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { createModuleUpdatePlan } from '@/lib/module-update-plan';

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

  try {
    const result = await createModuleUpdatePlan(moduleId);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Error creating update plan:', error);
    return NextResponse.json(
      {
        error: {
          code: 'update_plan_failed',
          message: error instanceof Error ? error.message : 'Unknown update plan error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

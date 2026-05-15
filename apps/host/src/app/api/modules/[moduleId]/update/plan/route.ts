import { NextResponse } from 'next/server';
import { createModuleUpdatePlan } from '@/lib/module-update-plan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
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

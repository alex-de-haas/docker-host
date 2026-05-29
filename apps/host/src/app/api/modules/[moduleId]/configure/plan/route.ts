import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { createModuleConfigurationPlan } from '@/lib/module-configuration';

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
    const result = await createModuleConfigurationPlan(moduleId);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Error creating module configuration plan:', error);
    return NextResponse.json(
      {
        error: {
          code: 'module_configuration_plan_failed',
          message: error instanceof Error ? error.message : 'Unknown module configuration plan error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

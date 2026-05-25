import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import { createModuleUpdatePlan } from '@/lib/module-update-plan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { moduleId } = await params;
  const result = await createModuleUpdatePlan(moduleId);
  return NextResponse.json(result.body, { status: result.status });
}

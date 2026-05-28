import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  buildInstallPlanRequestValidationError,
  extractInstallPlanMetadataUrl,
} from '@/lib/module-install-plan';
import { createInstallOrUpdatePlan } from '@/lib/module-install-or-update-plan';

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
    const result = buildInstallPlanRequestValidationError();
    return NextResponse.json(result.body, { status: result.status });
  }

  const metadataUrl = extractInstallPlanMetadataUrl(body);
  if (!metadataUrl) {
    const result = buildInstallPlanRequestValidationError();
    return NextResponse.json(result.body, { status: result.status });
  }

  try {
    const result = await createInstallOrUpdatePlan(metadataUrl);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error('Error creating install plan:', error);
    return NextResponse.json(
      {
        error: {
          code: 'install_plan_failed',
          message: error instanceof Error ? error.message : 'Unknown install plan error',
          validationErrors: [],
          conflicts: [],
        },
      },
      { status: 500 }
    );
  }
}

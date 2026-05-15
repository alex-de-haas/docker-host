import { NextResponse } from 'next/server';
import {
  buildInstallPlanRequestValidationError,
  createInstallPlan,
  extractInstallPlanMetadataUrl,
} from '@/lib/module-install-plan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
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
    const result = await createInstallPlan(metadataUrl);
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

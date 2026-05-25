import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import {
  buildInstallPlanRequestValidationError,
  createInstallPlan,
  extractInstallPlanMetadataUrl,
} from '@/lib/module-install-plan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
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

  const result = await createInstallPlan(metadataUrl);
  return NextResponse.json(result.body, { status: result.status });
}

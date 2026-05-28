import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import {
  buildInstallPlanRequestValidationError,
  extractInstallPlanMetadataUrl,
} from '@/lib/module-install-plan';
import { createInstallOrUpdatePlan } from '@/lib/module-install-or-update-plan';

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

  const result = await createInstallOrUpdatePlan(metadataUrl);
  return NextResponse.json(result.body, { status: result.status });
}

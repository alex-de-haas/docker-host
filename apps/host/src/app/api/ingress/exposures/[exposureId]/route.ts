import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  getExternalIngressReadiness,
  isExternalIngressServiceError,
  unlinkExternalIngressIntent,
  upsertExternalIngressIntent,
} from '@/lib/external-ingress-service';
import type { ExternalIngressIntentInput } from '@/types/ingress';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ exposureId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { exposureId } = await params;
    return NextResponse.json({ exposure: await getExternalIngressReadiness(exposureId) });
  } catch (error) {
    console.error('Error reading external ingress readiness:', error);
    return ingressErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ exposureId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { exposureId } = await params;
    const input = await request.json() as Omit<ExternalIngressIntentInput, 'gatewayExposureId'>;
    const exposure = await upsertExternalIngressIntent({
      ...input,
      gatewayExposureId: exposureId,
    }, auth.principal.id);
    return NextResponse.json({ exposure });
  } catch (error) {
    console.error('Error updating external ingress readiness:', error);
    return ingressErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ exposureId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { exposureId } = await params;
    const record = await unlinkExternalIngressIntent(exposureId, auth.principal.id);
    return NextResponse.json({ record });
  } catch (error) {
    console.error('Error unlinking external ingress readiness:', error);
    return ingressErrorResponse(error);
  }
}

function ingressErrorResponse(error: unknown) {
  if (isExternalIngressServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.status });
  }

  return NextResponse.json({
    error: {
      code: 'external_ingress_failed',
      message: error instanceof Error ? error.message : 'Unknown external ingress error',
    },
  }, { status: 500 });
}

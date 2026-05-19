import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isExternalIngressServiceError,
  refreshExternalIngressReadiness,
} from '@/lib/external-ingress-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ exposureId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { exposureId } = await params;
    const exposure = await refreshExternalIngressReadiness(exposureId, auth.principal.id);
    return NextResponse.json({ exposure });
  } catch (error) {
    console.error('Error refreshing external ingress readiness:', error);
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

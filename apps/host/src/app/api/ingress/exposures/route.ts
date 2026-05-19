import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin } from '@/lib/auth-http';
import {
  isExternalIngressServiceError,
  listExternalIngressReadiness,
  upsertExternalIngressIntent,
} from '@/lib/external-ingress-service';
import type { ExternalIngressIntentInput } from '@/types/ingress';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    return NextResponse.json({ exposures: await listExternalIngressReadiness() });
  } catch (error) {
    console.error('Error listing external ingress readiness:', error);
    return ingressErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const input = await request.json() as ExternalIngressIntentInput;
    const exposure = await upsertExternalIngressIntent(input, auth.principal.id);
    return NextResponse.json({ exposure }, { status: 201 });
  } catch (error) {
    console.error('Error saving external ingress readiness:', error, getRequestMeta(request));
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

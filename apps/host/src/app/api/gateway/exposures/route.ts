import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isGatewayServiceError,
  listGatewayExposures,
  upsertGatewayExposure,
} from '@/lib/gateway-service';
import type { GatewayExposureInput } from '@/types/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    return NextResponse.json({ exposures: await listGatewayExposures() });
  } catch (error) {
    console.error('Error listing gateway exposures:', error);
    return gatewayErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const input = await request.json() as GatewayExposureInput;
    const exposure = await upsertGatewayExposure(input, auth.principal.id);
    return NextResponse.json({ exposure }, { status: 201 });
  } catch (error) {
    console.error('Error saving gateway exposure:', error);
    return gatewayErrorResponse(error);
  }
}

function gatewayErrorResponse(error: unknown) {
  if (isGatewayServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.status });
  }

  return NextResponse.json({
    error: {
      code: 'gateway_exposure_failed',
      message: error instanceof Error ? error.message : 'Unknown gateway exposure error',
    },
  }, { status: 500 });
}

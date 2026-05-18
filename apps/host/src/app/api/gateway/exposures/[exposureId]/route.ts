import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  deleteGatewayExposure,
  isGatewayServiceError,
  upsertGatewayExposure,
} from '@/lib/gateway-service';
import type { GatewayExposureInput } from '@/types/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    const input = await request.json() as GatewayExposureInput;
    const exposure = await upsertGatewayExposure({
      ...input,
      id: exposureId,
    }, auth.principal.id);
    return NextResponse.json({ exposure });
  } catch (error) {
    console.error('Error updating gateway exposure:', error);
    return gatewayErrorResponse(error);
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
    const exposure = await deleteGatewayExposure(exposureId, auth.principal.id);
    if (!exposure) {
      return NextResponse.json({
        error: {
          code: 'exposure_not_found',
          message: `Gateway exposure "${exposureId}" was not found.`,
        },
      }, { status: 404 });
    }

    return NextResponse.json({ exposure });
  } catch (error) {
    console.error('Error deleting gateway exposure:', error);
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

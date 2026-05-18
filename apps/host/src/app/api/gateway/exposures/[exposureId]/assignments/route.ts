import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isGatewayServiceError,
  setGatewayExposureAssignments,
} from '@/lib/gateway-service';

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
    const input = await request.json() as { assignedUserIds?: unknown };
    if (!Array.isArray(input.assignedUserIds) ||
      input.assignedUserIds.some(userId => typeof userId !== 'string')) {
      return NextResponse.json({
        error: {
          code: 'invalid_assignments',
          message: 'assignedUserIds must be an array of Host user ids.',
        },
      }, { status: 400 });
    }

    const assignments = await setGatewayExposureAssignments(
      exposureId,
      input.assignedUserIds,
      auth.principal.id
    );
    return NextResponse.json({ assignments });
  } catch (error) {
    console.error('Error updating gateway exposure assignments:', error);
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
      code: 'gateway_assignments_failed',
      message: error instanceof Error ? error.message : 'Unknown gateway assignment error',
    },
  }, { status: 500 });
}

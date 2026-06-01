import { NextResponse } from 'next/server';
import {
  isHostDataRootUnavailableError,
  verifyHostDataRootMarker,
} from '@/lib/host-runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await verifyHostDataRootMarker();
  } catch (error) {
    if (isHostDataRootUnavailableError(error)) {
      return NextResponse.json({
        ok: false,
        service: 'docker-host',
        error: {
          code: 'data_root_unavailable',
          message: error.message,
        },
      }, { status: 503 });
    }
    throw error;
  }

  return NextResponse.json({
    ok: true,
    service: 'docker-host',
  });
}

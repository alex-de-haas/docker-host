import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { listGatewayExposureOptions } from '@/lib/gateway-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'modules.exposure.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    return NextResponse.json({ options: await listGatewayExposureOptions() });
  } catch (error) {
    console.error('Error listing gateway exposure options:', error);
    return NextResponse.json({
      error: {
        code: 'gateway_options_failed',
        message: error instanceof Error ? error.message : 'Unknown gateway options error',
      },
    }, { status: 500 });
  }
}

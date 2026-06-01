import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-http';
import { getAuthStatus } from '@/lib/auth-service';
import { isHostDataRootUnavailableError } from '@/lib/host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  let status: Awaited<ReturnType<typeof getAuthStatus>>;
  try {
    status = await getAuthStatus();
  } catch (error) {
    if (isHostDataRootUnavailableError(error)) {
      return NextResponse.json({
        setupRequired: false,
        authenticated: false,
        user: null,
        dataRootReady: false,
        error: {
          code: 'data_root_unavailable',
          message: error.message,
        },
      }, { status: 503 });
    }
    throw error;
  }

  const auth = status.setupRequired ? { principal: null } : await authenticateRequest(request);

  return NextResponse.json({
    setupRequired: status.setupRequired,
    authenticated: Boolean(auth.principal),
    user: auth.principal,
    dataRootReady: true,
  });
}

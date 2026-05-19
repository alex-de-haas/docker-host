import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-http';
import { getAuthStatus } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const status = await getAuthStatus();
  const auth = status.setupRequired
    ? { principal: null }
    : await authenticateRequest(request);

  return NextResponse.json({
    setupRequired: status.setupRequired,
    authenticated: Boolean(auth.principal),
    user: auth.principal,
  });
}

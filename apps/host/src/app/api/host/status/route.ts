import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { getHostStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const status = await getHostStatus();
  const httpStatus = status.host.ready && status.docker.connected ? 200 : 503;

  return NextResponse.json(status, { status: httpStatus });
}

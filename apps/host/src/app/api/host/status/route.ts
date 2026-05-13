import { NextResponse } from 'next/server';
import { getHostStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const status = await getHostStatus();
  const httpStatus = status.host.ready && status.docker.connected ? 200 : 503;

  return NextResponse.json(status, { status: httpStatus });
}

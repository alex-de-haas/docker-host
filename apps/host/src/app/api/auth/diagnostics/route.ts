import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { getAuthDiagnostics } from '@/lib/auth-diagnostics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  return NextResponse.json(await getAuthDiagnostics());
}

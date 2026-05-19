import { NextResponse } from 'next/server.js';
import { requireHostPrincipal } from '../../../lib/auth-http.ts';
import { listHostApps } from '../../../lib/app-registry-service.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const apps = await listHostApps(auth.principal);
    return NextResponse.json({ apps });
  } catch (error) {
    console.error('Error listing Host apps:', error);
    return NextResponse.json(
      {
        error: 'Failed to list Host apps',
        details: error instanceof Error ? error.message : 'Unknown app registry API error',
      },
      { status: 500 }
    );
  }
}

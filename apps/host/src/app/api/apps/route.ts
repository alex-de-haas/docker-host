import { NextResponse } from 'next/server';
import { getAppRegistryRequestOrigin, requireHostPrincipal } from '@/lib/auth-http';
import { listHostApps } from '@/lib/app-registry-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const apps = await listHostApps(auth.principal, {
      requestOrigin: getAppRegistryRequestOrigin(request),
      includeSystemApps: auth.principal.role === 'host.admin',
    });
    return NextResponse.json({ apps });
  } catch (error) {
    console.error('Error listing Host apps:', error);
    return NextResponse.json(
      {
        error: {
          code: 'host_apps_failed',
          message: error instanceof Error ? error.message : 'Unknown app registry API error',
        },
      },
      { status: 500 }
    );
  }
}

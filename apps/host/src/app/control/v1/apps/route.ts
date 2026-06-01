import { NextResponse } from 'next/server';
import { getObservedRequestOrigin } from '@/lib/auth-http';
import { listHostApps } from '@/lib/app-registry-service';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import type { HostPrincipal } from '@/types/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const principal: HostPrincipal = {
    id: LOCAL_CONTROL_ACTOR_ID,
    role: 'host.admin',
    displayName: 'Local CLI',
  };

  const apps = await listHostApps(principal, {
    requestOrigin: getObservedRequestOrigin(request),
    includeSystemApps: true,
  });
  return NextResponse.json({ apps });
}

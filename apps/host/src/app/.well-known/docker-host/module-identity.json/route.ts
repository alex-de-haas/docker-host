import { NextResponse } from 'next/server';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import { getModuleIdentityDiscovery } from '@/lib/module-identity.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json(getModuleIdentityDiscovery(getHostRuntimeConfig(), origin), {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

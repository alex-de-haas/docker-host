import { NextResponse } from 'next/server';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import { getModuleIdentityJwks } from '@/lib/module-identity.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getModuleIdentityJwks(getHostRuntimeConfig()), {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

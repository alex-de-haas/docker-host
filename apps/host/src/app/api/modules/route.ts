import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { listInstalledModules } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const modules = await listInstalledModules();
    return NextResponse.json({ modules });
  } catch (error) {
    console.error('Error listing installed modules:', error);
    return NextResponse.json(
      {
        error: 'Failed to list installed modules',
        details: error instanceof Error ? error.message : 'Unknown module API error',
      },
      { status: 500 }
    );
  }
}

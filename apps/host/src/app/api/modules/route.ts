import { NextResponse } from 'next/server';
import { listInstalledModules } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
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

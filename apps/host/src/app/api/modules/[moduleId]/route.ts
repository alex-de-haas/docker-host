import { NextResponse } from 'next/server';
import { getInstalledModuleDetail } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  try {
    const { moduleId } = await params;
    const installedModule = await getInstalledModuleDetail(moduleId);

    if (!installedModule) {
      return NextResponse.json({ error: `Module "${moduleId}" is not installed.` }, { status: 404 });
    }

    return NextResponse.json(installedModule);
  } catch (error) {
    console.error('Error fetching installed module:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch installed module',
        details: error instanceof Error ? error.message : 'Unknown module API error',
      },
      { status: 500 }
    );
  }
}

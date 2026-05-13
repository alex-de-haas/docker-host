import { NextResponse } from 'next/server';
import { normalizeModuleActionStatus, startInstalledModule } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const { moduleId } = await params;
  const result = await startInstalledModule(moduleId);
  return NextResponse.json(result, { status: normalizeModuleActionStatus(result) });
}

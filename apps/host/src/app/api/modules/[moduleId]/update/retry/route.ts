import { NextResponse } from 'next/server';
import { retryFailedModuleUpdate } from '@/lib/module-update-apply';
import { normalizeModuleActionStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const { moduleId } = await params;
  const result = await retryFailedModuleUpdate(moduleId);
  return NextResponse.json(result.body, { status: normalizeModuleActionStatus(result.body) });
}

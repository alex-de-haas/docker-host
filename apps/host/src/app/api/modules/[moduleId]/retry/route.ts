import { NextResponse } from 'next/server';
import { retryFailedModuleInstall } from '@/lib/module-recovery';
import { normalizeModuleActionStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const { moduleId } = await params;
  const result = await retryFailedModuleInstall(moduleId);
  return NextResponse.json(result.body, { status: normalizeModuleActionStatus(result.body) });
}

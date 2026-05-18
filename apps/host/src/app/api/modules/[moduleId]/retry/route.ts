import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { retryFailedModuleInstall } from '@/lib/module-recovery';
import { normalizeModuleActionStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.recovery');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await params;
  const result = await retryFailedModuleInstall(moduleId);
  return NextResponse.json(result.body, { status: normalizeModuleActionStatus(result.body) });
}

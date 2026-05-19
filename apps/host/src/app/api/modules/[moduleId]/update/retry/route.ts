import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { retryFailedModuleUpdate } from '@/lib/module-update-apply';
import { normalizeModuleActionStatus } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.update');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await params;
  const result = await retryFailedModuleUpdate(moduleId);
  return NextResponse.json(result.body, { status: normalizeModuleActionStatus(result.body) });
}

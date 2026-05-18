import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { normalizeModuleActionStatus, restartInstalledModule } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.lifecycle');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await params;
  const result = await restartInstalledModule(moduleId);
  return NextResponse.json(result, { status: normalizeModuleActionStatus(result) });
}

import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin } from '@/lib/auth-http';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { normalizeModuleActionStatus, startInstalledModule } from '@/lib/module-service';

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
  const result = await startInstalledModule(moduleId);
  const status = normalizeModuleActionStatus(result);
  await appendModuleOperationAudit({
    operation: 'start',
    moduleId,
    actorUserId: auth.principal.id,
    success: result.success,
    httpStatus: status,
    request: getRequestMeta(request),
  });
  return NextResponse.json(result, { status });
}

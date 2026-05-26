import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { normalizeModuleActionStatus, stopInstalledModule } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { moduleId } = await params;
  const result = await stopInstalledModule(moduleId);
  const status = normalizeModuleActionStatus(result);
  await appendModuleOperationAudit({
    operation: 'stop',
    moduleId,
    actorUserId: LOCAL_CONTROL_ACTOR_ID,
    success: result.success,
    httpStatus: status,
    request: getRequestMeta(request),
  });
  return NextResponse.json(result, { status });
}

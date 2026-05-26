import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { applyModuleInstallRequest } from '@/lib/module-install-apply';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const result = await applyModuleInstallRequest(body);
  await appendModuleOperationAudit({
    operation: 'install',
    moduleId: result.body.error === null ? result.body.module.id : undefined,
    actorUserId: LOCAL_CONTROL_ACTOR_ID,
    success: result.body.error === null,
    httpStatus: result.status,
    request: getRequestMeta(request),
  });
  return NextResponse.json(result.body, { status: result.status });
}

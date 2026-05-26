import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { applyModuleUpdateRequest } from '@/lib/module-update-apply';

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const result = await applyModuleUpdateRequest(moduleId, body);
  await appendModuleOperationAudit({
    operation: 'update',
    moduleId,
    actorUserId: LOCAL_CONTROL_ACTOR_ID,
    success: result.body.error === null,
    httpStatus: result.status,
    request: getRequestMeta(request),
  });
  return NextResponse.json(result.body, { status: result.status });
}

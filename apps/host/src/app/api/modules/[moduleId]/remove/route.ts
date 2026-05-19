import { NextResponse } from 'next/server';
import { getRequestMeta, requireHostAdmin } from '@/lib/auth-http';
import { appendModuleOperationAudit } from '@/lib/module-audit';
import { applyModuleRemoveRequest } from '@/lib/module-recovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostAdmin(request, 'modules.remove');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await params;
  const body = await readJson(request);
  const result = await applyModuleRemoveRequest(moduleId, body);
  await appendModuleOperationAudit({
    operation: 'remove',
    moduleId,
    actorUserId: auth.principal.id,
    success: result.body.success,
    httpStatus: result.status,
    request: getRequestMeta(request),
  });
  return NextResponse.json(result.body, { status: result.status });
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

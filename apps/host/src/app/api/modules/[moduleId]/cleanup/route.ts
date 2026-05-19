import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { applyModuleCleanupRequest } from '@/lib/module-recovery';

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
  const body = await readJson(request);
  const result = await applyModuleCleanupRequest(moduleId, body);
  return NextResponse.json(result.body, { status: result.status });
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

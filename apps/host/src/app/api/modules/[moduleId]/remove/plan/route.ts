import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { createModuleRemovePlan } from '@/lib/module-recovery';

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
  const result = await createModuleRemovePlan(moduleId, readDeleteModuleData(body));
  return NextResponse.json(result.body, { status: result.status });
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readDeleteModuleData(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }

  return (body as Record<string, unknown>).deleteModuleData === true;
}

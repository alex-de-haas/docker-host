import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import {
  isAuthServiceError,
  replaceHostUserModuleAssignments,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { userId } = await params;
    const body = await readJson(request);
    const assignments = await replaceHostUserModuleAssignments(
      userId,
      readStringArray(body, 'assignedModuleIds'),
      LOCAL_CONTROL_ACTOR_ID,
      getRequestMeta(request)
    );

    return NextResponse.json({ assignments });
  } catch (error) {
    if (isAuthServiceError(error)) {
      return NextResponse.json({
        error: {
          code: error.code,
          message: error.message,
        },
      }, { status: error.code === 'user_not_found' ? 404 : 400 });
    }

    console.error('Error updating control user module assignments:', error);
    return NextResponse.json({
      error: {
        code: 'user_assignments_failed',
        message: error instanceof Error ? error.message : 'Unknown user assignment error',
      },
    }, { status: 500 });
  }
}

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function readStringArray(value: unknown, key: string) {
  return isObject(value) && Array.isArray(value[key])
    ? value[key].filter((item): item is string => typeof item === 'string')
    : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { NextResponse } from 'next/server';
import { getRequestMeta } from '@/lib/auth-http';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import {
  isAuthServiceError,
  updateHostUser,
} from '@/lib/auth-service';
import type { HostRole } from '@/types/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(
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
    const user = await updateHostUser({
      userId,
      displayName: readNullableString(body, 'displayName'),
      role: readOptionalRole(body, 'role'),
    }, LOCAL_CONTROL_ACTOR_ID, getRequestMeta(request));

    return NextResponse.json({ user });
  } catch (error) {
    return userManagementErrorResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function readNullableString(value: unknown, key: string) {
  if (!isObject(value) || !(key in value)) {
    return undefined;
  }

  return value[key] === null || typeof value[key] === 'string' ? value[key] : undefined;
}

function readOptionalRole(value: unknown, key: string): HostRole | undefined {
  const role = isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
  if (role === 'host.admin' || role === 'host.user') {
    return role;
  }

  return undefined;
}

function userManagementErrorResponse(error: unknown) {
  if (isAuthServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: errorStatus(error.code) });
  }

  console.error('Error handling control user management:', error);
  return NextResponse.json({
    error: {
      code: 'user_management_failed',
      message: error instanceof Error ? error.message : 'Unknown user management error',
    },
  }, { status: 500 });
}

function errorStatus(code: string) {
  switch (code) {
    case 'user_not_found':
      return 404;
    case 'last_admin':
    case 'provider_managed_role':
      return 409;
    default:
      return 400;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

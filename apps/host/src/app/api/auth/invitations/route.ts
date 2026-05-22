import { NextResponse } from 'next/server';
import {
  getRequestMeta,
  getRequestOrigin,
  requireHostAdmin,
  requireRecentReauthentication,
} from '@/lib/auth-http';
import {
  createUserInvitation,
  isAuthServiceError,
  listUserInvitations,
} from '@/lib/auth-service';
import type { HostRole } from '@/types/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.users.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  return NextResponse.json({
    invitations: await listUserInvitations(),
  });
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'host.users.manage');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const reauth = await requireRecentReauthentication(auth, 'host.users.manage');
  if (reauth instanceof NextResponse) {
    return reauth;
  }

  try {
    const body = await readJson(request);
    const result = await createUserInvitation({
      email: readString(body, 'email'),
      displayName: readOptionalString(body, 'displayName'),
      role: readRole(body, 'role'),
      assignedModuleIds: readStringArray(body, 'assignedModuleIds'),
      ttlMs: readOptionalNumber(body, 'ttlMs'),
    }, auth.principal.id, getRequestMeta(request));

    return NextResponse.json({
      invitation: result.invitation,
      token: result.token,
      setupUrl: `${getRequestOrigin(request)}/setup/invite?setupToken=${encodeURIComponent(result.token)}`,
    }, { status: 201 });
  } catch (error) {
    return invitationErrorResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string) {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : '';
}

function readOptionalString(value: unknown, key: string) {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function readOptionalNumber(value: unknown, key: string) {
  return isObject(value) && typeof value[key] === 'number' ? value[key] : undefined;
}

function readStringArray(value: unknown, key: string) {
  return isObject(value) && Array.isArray(value[key])
    ? value[key].filter((item): item is string => typeof item === 'string')
    : [];
}

function readRole(value: unknown, key: string): HostRole {
  const role = readString(value, key);
  return role === 'host.admin' ? 'host.admin' : 'host.user';
}

function invitationErrorResponse(error: unknown) {
  if (isAuthServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.code === 'email_exists' || error.code === 'invitation_exists' ? 409 : 400 });
  }

  console.error('Error handling user invitation request:', error);
  return NextResponse.json({
    error: {
      code: 'invitation_failed',
      message: error instanceof Error ? error.message : 'Unknown invitation error',
    },
  }, { status: 500 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { NextResponse } from 'next/server';
import { authExceptionResponse, getRequestMeta } from '@/lib/auth-http';
import { requireTrustedControl } from '@/lib/control-auth';
import { acceptUserInvitation } from '@/lib/auth-service';
import { getDefaultHostShellPath } from '@/lib/auth-policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const body = await readJson(request);
    const result = await acceptUserInvitation({
      setupToken: readString(body, 'setupToken'),
      email: readOptionalString(body, 'email'),
      displayName: readOptionalString(body, 'displayName'),
      password: readString(body, 'password'),
    }, getRequestMeta(request));

    return NextResponse.json({
      user: result.user,
      redirectTo: getDefaultHostShellPath(result.user),
    }, { status: 201 });
  } catch (error) {
    return authExceptionResponse(error);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

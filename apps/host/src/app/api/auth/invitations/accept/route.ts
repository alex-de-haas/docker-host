import { NextResponse } from 'next/server';
import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  createSessionAndAccountSetCookieResponse,
  getRequestAccountSetToken,
  getRequestMeta,
} from '@/lib/auth-http';
import { getDefaultHostShellPath } from '@/lib/auth-policy';
import {
  acceptUserInvitation,
  addUserToBrowserAccountSet,
  previewUserInvitation,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const setupToken = new URL(request.url).searchParams.get('setupToken') || '';
    const invitation = await previewUserInvitation(setupToken);
    return NextResponse.json({ invitation });
  } catch (error) {
    return authExceptionResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSecureEnoughForCookies(request);
    const body = await readJson(request);
    const result = await acceptUserInvitation({
      setupToken: readString(body, 'setupToken'),
      email: readOptionalString(body, 'email'),
      displayName: readOptionalString(body, 'displayName'),
      password: readString(body, 'password'),
    }, getRequestMeta(request));
    const accountSet = await addUserToBrowserAccountSet({
      accountSetToken: getRequestAccountSetToken(request),
      userId: result.user.id,
    }, getRequestMeta(request));

    return createSessionAndAccountSetCookieResponse(request, {
      user: result.user,
      redirectTo: getDefaultHostShellPath(result.user),
    }, result.sessionToken, accountSet.accountSetToken, 201);
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

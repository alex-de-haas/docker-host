import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  createSessionCookieResponse,
  getRequestMeta,
} from '@/lib/auth-http';
import { bootstrapFirstAdmin } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSecureEnoughForCookies(request);
    const body = await readJson(request);
    const result = await bootstrapFirstAdmin({
      setupToken: readString(body, 'setupToken'),
      email: readString(body, 'email'),
      password: readString(body, 'password'),
      displayName: readOptionalString(body, 'displayName'),
    }, getRequestMeta(request));

    return createSessionCookieResponse(request, {
      user: result.user,
      setupComplete: true,
    }, result.sessionToken, 201);
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

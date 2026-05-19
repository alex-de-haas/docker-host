import {
  assertSecureEnoughForCookies,
  authExceptionResponse,
  createSessionCookieResponse,
  getRequestMeta,
} from '@/lib/auth-http';
import { authenticatePassword } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSecureEnoughForCookies(request);
    const body = await readJson(request);
    const result = await authenticatePassword({
      email: readString(body, 'email'),
      password: readString(body, 'password'),
    }, getRequestMeta(request));

    return createSessionCookieResponse(request, {
      user: result.user,
      authenticated: true,
    }, result.sessionToken);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

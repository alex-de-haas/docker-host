import { NextResponse } from 'next/server';
import { authenticateRequest, getRequestMeta } from '@/lib/auth-http';
import { isAuthServiceError, reauthenticateSession } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.principal) {
    return NextResponse.json({
      error: {
        code: 'unauthorized',
        message: 'Authentication is required.',
        nextStep: 'Sign in to Docker Host.',
      },
    }, { status: 401 });
  }

  if (auth.source !== 'session' || !('sessionId' in auth.principal)) {
    return NextResponse.json({
      error: {
        code: 'reauth_not_supported',
        message: 'This authentication source does not support browser reauthentication.',
        nextStep: 'Use a browser session.',
      },
    }, { status: 400 });
  }

  try {
    const input = await readOptionalJson(request);
    const session = await reauthenticateSession({
      sessionId: String(auth.principal.sessionId),
      userId: auth.principal.id,
      password: typeof input.password === 'string' ? input.password : undefined,
      recoveryToken: typeof input.recoveryToken === 'string' ? input.recoveryToken : undefined,
    }, getRequestMeta(request));

    return NextResponse.json({ session });
  } catch (error) {
    return reauthErrorResponse(error);
  }
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return isObject(body) ? body : {};
  } catch {
    return {};
  }
}

function reauthErrorResponse(error: unknown) {
  if (isAuthServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: 400 });
  }

  console.error('Error handling reauthentication request:', error);
  return NextResponse.json({
    error: {
      code: 'reauth_failed',
      message: error instanceof Error ? error.message : 'Unknown reauthentication error',
    },
  }, { status: 500 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  createCliTokenForAdmin,
  isAuthServiceError,
  listCliTokens,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const cliTokens = await listCliTokens();
  return NextResponse.json({ cliTokens });
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const input = await readOptionalJson(request);
    const userId = typeof input.userId === 'string' && input.userId.trim()
      ? input.userId.trim()
      : auth.principal.id;
    const label = typeof input.label === 'string' ? input.label : 'Docker Host CLI';
    const created = await createCliTokenForAdmin(userId, label);

    return NextResponse.json({
      cliToken: created.cliToken,
      token: created.token,
    }, { status: 201 });
  } catch (error) {
    return cliTokenErrorResponse(error);
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

function cliTokenErrorResponse(error: unknown) {
  if (isAuthServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: 400 });
  }

  console.error('Error handling CLI token request:', error);
  return NextResponse.json({
    error: {
      code: 'cli_token_failed',
      message: error instanceof Error ? error.message : 'Unknown CLI token error',
    },
  }, { status: 500 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

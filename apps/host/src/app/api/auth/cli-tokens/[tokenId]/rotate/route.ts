import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  isAuthServiceError,
  rotateCliToken,
} from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tokenId: string }> }
) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { tokenId } = await params;
    const input = await readOptionalJson(request);
    const label = typeof input.label === 'string' ? input.label : undefined;
    const rotated = await rotateCliToken(tokenId, auth.principal.id, label);

    return NextResponse.json({
      revokedTokenId: rotated.revokedTokenId,
      cliToken: rotated.cliToken,
      token: rotated.token,
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
    const status = error.code === 'cli_token_not_found' ? 404 : 400;
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status });
  }

  console.error('Error rotating CLI token:', error);
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

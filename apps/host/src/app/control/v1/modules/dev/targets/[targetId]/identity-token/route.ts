import { NextResponse } from 'next/server';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import {
  isModuleDevIdentityError,
  issueModuleDevIdentityToken,
} from '@/lib/module-dev-identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { targetId } = await params;
    const body = readIdentityRequest(await readJson(request));
    const identity = await issueModuleDevIdentityToken({
      targetId,
      userEmail: body.userEmail,
      userId: body.userId,
    }, LOCAL_CONTROL_ACTOR_ID);

    return NextResponse.json(identity, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (isModuleDevIdentityError(error)) {
      return NextResponse.json({
        error: {
          code: error.code,
          message: error.message,
        },
      }, { status: error.status });
    }

    console.error('Error issuing developer module identity token:', error);
    return NextResponse.json({
      error: {
        code: 'module_dev_identity_failed',
        message: error instanceof Error ? error.message : 'Unknown module developer identity error',
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

function readIdentityRequest(body: unknown) {
  if (!isObject(body)) {
    return {};
  }

  return {
    userEmail: readOptionalString(body, 'userEmail'),
    userId: readOptionalString(body, 'userId'),
  };
}

function readOptionalString(input: Record<string, unknown>, key: string) {
  return typeof input[key] === 'string' && input[key].trim()
    ? input[key].trim()
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

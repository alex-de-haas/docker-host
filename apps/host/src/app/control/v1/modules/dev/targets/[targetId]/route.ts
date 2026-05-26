import { NextResponse } from 'next/server';
import { LOCAL_CONTROL_ACTOR_ID, requireTrustedControl } from '@/lib/control-auth';
import {
  deleteModuleDevTarget,
  isModuleDevServiceError,
  upsertModuleDevTarget,
} from '@/lib/module-dev-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { targetId } = await params;
    const body = await readJson(request);
    const target = await upsertModuleDevTarget({
      ...readDevTargetInput(body),
      id: targetId,
    }, LOCAL_CONTROL_ACTOR_ID, undefined, true);
    return NextResponse.json({ target });
  } catch (error) {
    return devTargetErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  try {
    const { targetId } = await params;
    const target = await deleteModuleDevTarget(targetId, LOCAL_CONTROL_ACTOR_ID, undefined, true);
    return NextResponse.json({ target });
  } catch (error) {
    return devTargetErrorResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readDevTargetInput(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      metadataUrl: '',
      hostname: '',
      portKey: '',
      targetBaseUrl: '',
    };
  }

  const input = body as Record<string, unknown>;
  return {
    metadataUrl: readString(input, 'metadataUrl'),
    hostname: readString(input, 'hostname'),
    portKey: readString(input, 'portKey'),
    targetBaseUrl: readString(input, 'targetBaseUrl'),
    exposurePolicy: readOptionalString(input, 'exposurePolicy') as never,
    identityMode: readOptionalString(input, 'identityMode') as never,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
  };
}

function readString(input: Record<string, unknown>, key: string) {
  return typeof input[key] === 'string' ? input[key] : '';
}

function readOptionalString(input: Record<string, unknown>, key: string) {
  return typeof input[key] === 'string' ? input[key] : undefined;
}

function devTargetErrorResponse(error: unknown) {
  if (isModuleDevServiceError(error)) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
        validationErrors: error.validationErrors,
      },
    }, { status: error.status });
  }

  console.error('Error handling control module developer target:', error);
  return NextResponse.json({
    error: {
      code: 'module_dev_target_failed',
      message: error instanceof Error ? error.message : 'Unknown module developer mode error',
    },
  }, { status: 500 });
}

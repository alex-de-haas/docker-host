import { NextResponse } from 'next/server';
import {
  AppBackupError,
  restoreAppDataBackup,
} from '@/lib/app-backups';
import { requireTrustedControl } from '@/lib/control-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appId: string; backupId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { appId, backupId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!isObject(body) || body.confirmed !== true) {
    return NextResponse.json({
      error: {
        code: 'restore_confirmation_required',
        message: 'Restore requires confirmed=true.',
      },
    }, { status: 422 });
  }

  try {
    const result = await restoreAppDataBackup(appId, backupId, {
      stopBeforeRestore: body.stopBeforeRestore !== false,
      createPreRestoreBackup: body.createPreRestoreBackup !== false,
    });
    return NextResponse.json(result);
  } catch (error) {
    return restoreErrorResponse(error);
  }
}

function restoreErrorResponse(error: unknown) {
  if (error instanceof AppBackupError) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
      },
    }, { status: error.status });
  }

  return NextResponse.json({
    error: {
      code: 'app_restore_failed',
      message: error instanceof Error ? error.message : 'App restore operation failed.',
    },
  }, { status: 500 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

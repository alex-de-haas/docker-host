import { NextResponse } from 'next/server';
import {
  AppBackupError,
  createAppDataBackup,
  listAppDataBackups,
} from '@/lib/app-backups';
import { requireTrustedControl } from '@/lib/control-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { appId } = await params;
  try {
    const backups = await listAppDataBackups(appId);
    return NextResponse.json({ backups });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { appId } = await params;
  try {
    const backup = await createAppDataBackup(appId, 'manual');
    if (!backup) {
      return NextResponse.json({
        error: {
          code: 'app_data_not_found',
          message: `App "${appId}" does not have a data directory to back up.`,
        },
      }, { status: 404 });
    }

    return NextResponse.json({ backup }, { status: 201 });
  } catch (error) {
    return backupErrorResponse(error);
  }
}

function backupErrorResponse(error: unknown) {
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
      code: 'app_backup_failed',
      message: error instanceof Error ? error.message : 'App backup operation failed.',
    },
  }, { status: 500 });
}

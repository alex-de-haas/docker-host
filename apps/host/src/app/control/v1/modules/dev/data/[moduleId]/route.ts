import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import { getHostRuntimeConfig } from '@/lib/host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const { moduleId } = await params;
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(moduleId)) {
    return NextResponse.json({
      error: {
        code: 'module_id_invalid',
        message: 'Development module id is invalid.',
      },
    }, { status: 400 });
  }

  const config = getHostRuntimeConfig();
  const moduleDataPath = path.join(config.dataRootContainer, 'dev', 'modules', moduleId);
  await fs.rm(moduleDataPath, { recursive: true, force: true });
  return NextResponse.json({
    moduleId,
    removed: true,
    path: moduleDataPath,
  });
}

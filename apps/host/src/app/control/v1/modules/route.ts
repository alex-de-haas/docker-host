import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import { listInstalledModules } from '@/lib/module-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const modules = await listInstalledModules();
  return NextResponse.json({ modules });
}

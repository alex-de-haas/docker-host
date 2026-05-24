import { NextResponse } from 'next/server';
import { canAccessModule } from '@/lib/auth-policy';
import { getRequestOrigin, requireHostPrincipal } from '@/lib/auth-http';
import { readAuthStateSnapshot } from '@/lib/auth-store';
import { listHostApps } from '@/lib/app-registry-service';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import { createModuleIdentityToken } from '@/lib/module-identity.mjs';
import type { ModuleExposurePolicy } from '@/types/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { moduleId } = await context.params;
  const config = getHostRuntimeConfig();
  const requestOrigin = getRequestOrigin(request);
  const [apps, authState] = await Promise.all([
    listHostApps(auth.principal, { config, requestOrigin }),
    readAuthStateSnapshot(config),
  ]);
  const app = apps.find(candidate =>
    candidate.source === 'installed' &&
    candidate.moduleId === moduleId
  );

  if (!app) {
    return NextResponse.json({
      error: {
        code: 'app_not_found',
        message: 'Module app is not available to the current Host principal.',
      },
    }, { status: 404 });
  }

  if (app.status !== 'available' || !app.origin) {
    return NextResponse.json({
      error: {
        code: 'app_unavailable',
        message: 'Module app is not currently available.',
      },
    }, { status: 503 });
  }

  const exposurePolicy: ModuleExposurePolicy =
    app.accessMode === 'assignedUsersOnly' ? 'assignedUsersOnly' : 'loginRequired';
  const access = canAccessModule({
    principal: auth.principal,
    moduleId,
    exposurePolicy,
    assignments: authState.moduleAssignments,
  });
  const token = await createModuleIdentityToken({
    exposure: {
      id: `shell_${moduleId}`,
      moduleId,
      hostname: new URL(app.origin).host,
      endpointKey: 'ui',
      exposurePolicy,
      identityMode: 'required',
    },
    access,
    principal: auth.principal,
  }, config);

  if (!token) {
    return NextResponse.json({
      error: {
        code: 'identity_token_denied',
        message: 'Module identity token could not be issued for this principal.',
      },
    }, { status: 403 });
  }

  return NextResponse.json({
    token,
    tokenType: 'DockerHostModuleIdentity',
    moduleId,
    origin: app.origin,
    hostOrigin: requestOrigin,
    expiresInSeconds: 300,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

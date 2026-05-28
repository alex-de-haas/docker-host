import { NextResponse } from 'next/server';
import { canAccessModule } from '@/lib/auth-policy';
import { getRequestOrigin, requireHostPrincipal } from '@/lib/auth-http';
import { readAuthStateSnapshot } from '@/lib/auth-store';
import { listHostApps } from '@/lib/app-registry-service';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import { readModuleDevTargetStateSnapshot } from '@/lib/module-dev-store';
import {
  MODULE_IDENTITY_TOKEN_TTL_SECONDS,
  createModuleIdentityToken,
} from '@/lib/module-identity.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { targetId } = await context.params;
  const config = getHostRuntimeConfig();
  const requestOrigin = getRequestOrigin(request);
  const [apps, authState, devState] = await Promise.all([
    listHostApps(auth.principal, { config, requestOrigin }),
    readAuthStateSnapshot(config),
    readModuleDevTargetStateSnapshot(config),
  ]);
  const app = apps.find(candidate =>
    candidate.source === 'developer' &&
    candidate.developerTargetId === targetId
  );
  const target = devState.targets.find(candidate => candidate.id === targetId);

  if (!app || !target) {
    return NextResponse.json({
      error: {
        code: 'app_not_found',
        message: 'Developer module app is not available to the current Host principal.',
      },
    }, { status: 404 });
  }

  if (app.status !== 'available' || !app.origin) {
    return NextResponse.json({
      error: {
        code: 'app_unavailable',
        message: 'Developer module app is not currently available.',
      },
    }, { status: 503 });
  }

  const access = canAccessModule({
    principal: auth.principal,
    moduleId: target.moduleId,
    exposurePolicy: target.exposurePolicy,
    assignments: authState.moduleAssignments,
  });
  const token = await createModuleIdentityToken({
    exposure: {
      id: target.id,
      moduleId: target.moduleId,
      hostname: new URL(app.origin).host,
      endpointKey: target.portKey,
      exposurePolicy: target.exposurePolicy,
      identityMode: target.identityMode,
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
    moduleId: target.moduleId,
    origin: app.origin,
    hostOrigin: requestOrigin,
    expiresInSeconds: MODULE_IDENTITY_TOKEN_TTL_SECONDS,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

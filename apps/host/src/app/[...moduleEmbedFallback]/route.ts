import { NextResponse } from 'next/server';
import {
  authenticateHostAppEmbedTokenRequest,
  appEmbedErrorResponse,
  getRootRelativeModulePathFromRequest,
  parseHostAppEmbedReferer,
  proxyHostAppEmbedRequest,
  resolveHostAppEmbedTarget,
  resolveHostDeveloperAppEmbedTarget,
  withHostAppEmbedCorsHeaders,
} from '@/lib/app-embed-service';
import { requireHostPrincipal } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  return await handleRootRelativeEmbedRequest(request);
}

export async function HEAD(request: Request) {
  return await handleRootRelativeEmbedRequest(request);
}

async function handleRootRelativeEmbedRequest(request: Request) {
  if (!isRootRelativeRscRequest(request)) {
    return NextResponse.json({
      error: {
        code: 'not_found',
        message: 'The requested Host route does not exist.',
      },
    }, { status: 404 });
  }

  const embedReference = parseHostAppEmbedReferer(request);
  if (!embedReference) {
    return NextResponse.json({
      error: {
        code: 'embed_context_missing',
        message: 'Embedded module request context is missing.',
      },
    }, { status: 404 });
  }

  const modulePath = getRootRelativeModulePathFromRequest(request);
  const tokenPrincipal = await authenticateEmbedFallbackTokenPrincipal(request, embedReference);
  if (tokenPrincipal) {
    try {
      const target = embedReference.source === 'developer'
        ? await resolveHostDeveloperAppEmbedTarget(request, tokenPrincipal, embedReference.targetId, { modulePath })
        : await resolveHostAppEmbedTarget(request, tokenPrincipal, embedReference.moduleId, { modulePath });
      return withHostAppEmbedCorsHeaders(request, await proxyHostAppEmbedRequest(request, target));
    } catch (error) {
      return withHostAppEmbedCorsHeaders(request, appEmbedErrorResponse(error));
    }
  }

  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const target = embedReference.source === 'developer'
      ? await resolveHostDeveloperAppEmbedTarget(request, auth.principal, embedReference.targetId, { modulePath })
      : await resolveHostAppEmbedTarget(request, auth.principal, embedReference.moduleId, { modulePath });
    return await proxyHostAppEmbedRequest(request, target);
  } catch (error) {
    return appEmbedErrorResponse(error);
  }
}

function isRootRelativeRscRequest(request: Request) {
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    return false;
  }

  const url = new URL(request.url);
  return url.searchParams.has('_rsc') || request.headers.get('rsc') === '1';
}

function authenticateEmbedFallbackTokenPrincipal(
  request: Request,
  embedReference: NonNullable<ReturnType<typeof parseHostAppEmbedReferer>>
) {
  return embedReference.source === 'developer'
    ? authenticateHostAppEmbedTokenRequest(request, {
        source: 'developer',
        targetId: embedReference.targetId,
      })
    : authenticateHostAppEmbedTokenRequest(request, {
        source: 'installed',
        moduleId: embedReference.moduleId,
      });
}

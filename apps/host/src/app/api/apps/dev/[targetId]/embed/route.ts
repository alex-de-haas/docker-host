import { NextResponse } from 'next/server';
import {
  authenticateHostAppEmbedTokenRequest,
  appEmbedErrorResponse,
  hostAppEmbedCorsPreflightResponse,
  isHostAppEmbedStaticAssetRequest,
  proxyHostAppEmbedRequest,
  resolveHostDeveloperAppEmbedTarget,
  resolveHostDeveloperAppStaticAssetEmbedTarget,
  withHostAppEmbedCorsHeaders,
} from '@/lib/app-embed-service';
import { requireHostPrincipal } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function OPTIONS(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  const { targetId } = await context.params;
  const tokenPrincipal = await authenticateHostAppEmbedTokenRequest(request, {
    source: 'developer',
    targetId,
  });
  return hostAppEmbedCorsPreflightResponse(request, Boolean(tokenPrincipal));
}

export async function handleDeveloperEmbedRequest(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const { targetId } = await params;
  if (isHostAppEmbedStaticAssetRequest(request)) {
    try {
      const target = await resolveHostDeveloperAppStaticAssetEmbedTarget(request, targetId);
      return withHostAppEmbedCorsHeaders(request, await proxyHostAppEmbedRequest(request, target));
    } catch (error) {
      return withHostAppEmbedCorsHeaders(request, appEmbedErrorResponse(error));
    }
  }

  const tokenPrincipal = await authenticateHostAppEmbedTokenRequest(request, {
    source: 'developer',
    targetId,
  });
  if (tokenPrincipal) {
    try {
      const target = await resolveHostDeveloperAppEmbedTarget(request, tokenPrincipal, targetId);
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
    const target = await resolveHostDeveloperAppEmbedTarget(request, auth.principal, targetId);
    return await proxyHostAppEmbedRequest(request, target);
  } catch (error) {
    return appEmbedErrorResponse(error);
  }
}

async function handleEmbedRequest(
  request: Request,
  context: { params: Promise<{ targetId: string }> }
) {
  return await handleDeveloperEmbedRequest(request, context);
}

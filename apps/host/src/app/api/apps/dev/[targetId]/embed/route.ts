import { NextResponse } from 'next/server';
import {
  authenticateHostAppEmbedTokenRequest,
  appEmbedErrorResponse,
  isHostAppEmbedStaticAssetRequest,
  proxyHostAppEmbedRequest,
  resolveHostDeveloperAppEmbedTarget,
  resolveHostDeveloperAppStaticAssetEmbedTarget,
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

export async function handleDeveloperEmbedRequest(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const { targetId } = await params;
  if (isHostAppEmbedStaticAssetRequest(request)) {
    try {
      const target = await resolveHostDeveloperAppStaticAssetEmbedTarget(request, targetId);
      return await proxyHostAppEmbedRequest(request, target);
    } catch (error) {
      return appEmbedErrorResponse(error);
    }
  }

  const tokenPrincipal = await authenticateHostAppEmbedTokenRequest(request, {
    source: 'developer',
    targetId,
  });
  if (tokenPrincipal) {
    try {
      const target = await resolveHostDeveloperAppEmbedTarget(request, tokenPrincipal, targetId);
      return await proxyHostAppEmbedRequest(request, target);
    } catch (error) {
      return appEmbedErrorResponse(error);
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

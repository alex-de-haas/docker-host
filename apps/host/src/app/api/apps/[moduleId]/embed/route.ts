import { NextResponse } from 'next/server';
import {
  authenticateHostAppEmbedTokenRequest,
  appEmbedErrorResponse,
  isHostAppEmbedStaticAssetRequest,
  proxyHostAppEmbedRequest,
  resolveHostAppEmbedTarget,
  resolveHostAppStaticAssetEmbedTarget,
} from '@/lib/app-embed-service';
import { requireHostPrincipal } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ moduleId: string }> }
) {
  return await handleEmbedRequest(request, context);
}

async function handleEmbedRequest(
  request: Request,
  { params }: { params: Promise<{ moduleId: string }> }
) {
  const { moduleId } = await params;
  if (isHostAppEmbedStaticAssetRequest(request)) {
    try {
      const target = await resolveHostAppStaticAssetEmbedTarget(request, moduleId);
      return await proxyHostAppEmbedRequest(request, target);
    } catch (error) {
      return appEmbedErrorResponse(error);
    }
  }

  const tokenPrincipal = await authenticateHostAppEmbedTokenRequest(request, {
    source: 'installed',
    moduleId,
  });
  if (tokenPrincipal) {
    try {
      const target = await resolveHostAppEmbedTarget(request, tokenPrincipal, moduleId);
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
    const target = await resolveHostAppEmbedTarget(request, auth.principal, moduleId);
    return await proxyHostAppEmbedRequest(request, target);
  } catch (error) {
    return appEmbedErrorResponse(error);
  }
}

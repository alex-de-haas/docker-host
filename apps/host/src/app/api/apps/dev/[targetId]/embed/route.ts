import { NextResponse } from 'next/server.js';
import {
  appEmbedErrorResponse,
  proxyHostAppEmbedRequest,
  resolveHostDeveloperAppEmbedTarget,
} from '../../../../../../lib/app-embed-service.ts';
import { requireHostPrincipal } from '../../../../../../lib/auth-http.ts';

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

async function handleEmbedRequest(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const auth = await requireHostPrincipal(request, 'apps.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { targetId } = await params;
    const target = await resolveHostDeveloperAppEmbedTarget(request, auth.principal, targetId);
    return await proxyHostAppEmbedRequest(request, target);
  } catch (error) {
    return appEmbedErrorResponse(error);
  }
}

import { NextResponse } from 'next/server';
import { requireHostAdmin, requireRecentReauthentication } from '@/lib/auth-http';
import { listAuthAuditEvents, purgeAuthAuditEvents } from '@/lib/auth-audit';
import type { AuthAuditQuery } from '@/lib/auth-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const query = parseAuditQuery(new URL(request.url).searchParams);
  return NextResponse.json(await listAuthAuditEvents(query));
}

export async function DELETE(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const reauth = await requireRecentReauthentication(auth, 'host.auth.configure');
  if (reauth instanceof NextResponse) {
    return reauth;
  }

  const searchParams = new URL(request.url).searchParams;
  const result = await purgeAuthAuditEvents({
    retentionDays: parseOptionalInteger(searchParams.get('retentionDays')),
    actorUserId: auth.principal.id,
  });
  return NextResponse.json(result);
}

function parseAuditQuery(searchParams: URLSearchParams): AuthAuditQuery {
  return {
    cursor: parseOptionalInteger(searchParams.get('cursor')),
    limit: parseOptionalInteger(searchParams.get('limit')),
    type: normalizeOptionalString(searchParams.get('type')),
    actorUserId: normalizeOptionalString(searchParams.get('actorUserId')),
    success: parseOptionalBoolean(searchParams.get('success')),
    targetType: normalizeOptionalString(searchParams.get('targetType')),
    targetId: normalizeOptionalString(searchParams.get('targetId')),
    from: normalizeOptionalString(searchParams.get('from')),
    to: normalizeOptionalString(searchParams.get('to')),
  };
}

function parseOptionalInteger(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | null) {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

function normalizeOptionalString(value: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

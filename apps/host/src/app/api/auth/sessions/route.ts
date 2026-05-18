import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { listAuthSessions } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.auth.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  const searchParams = new URL(request.url).searchParams;
  const currentSessionId = auth.source === 'session' && 'sessionId' in auth.principal
    ? String(auth.principal.sessionId)
    : undefined;
  const sessions = await listAuthSessions({
    userId: normalizeOptionalString(searchParams.get('userId')),
    includeRevoked: searchParams.get('includeRevoked') === 'true',
    currentSessionId,
  });

  return NextResponse.json({ sessions });
}

function normalizeOptionalString(value: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

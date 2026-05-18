import { createClearSessionCookieResponse, revokeRequestSession } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  await revokeRequestSession(request);
  return createClearSessionCookieResponse({ authenticated: false });
}

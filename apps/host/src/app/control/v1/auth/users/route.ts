import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import {
  listHostUsers,
  listUserInvitations,
  USER_INVITE_DEFAULT_TTL_MS,
  USER_INVITE_MAX_TTL_MS,
  USER_INVITE_MIN_TTL_MS,
} from '@/lib/auth-service';
import { listAssignableModules } from '@/lib/user-access-options';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const control = await requireTrustedControl(request);
  if (control) {
    return control;
  }

  const [users, invitations, modules] = await Promise.all([
    listHostUsers(),
    listUserInvitations(),
    listAssignableModules(),
  ]);

  return NextResponse.json({
    users,
    invitations,
    modules,
    inviteTtlOptions: [
      { label: '15 minutes', ttlMs: USER_INVITE_MIN_TTL_MS },
      { label: '24 hours', ttlMs: USER_INVITE_DEFAULT_TTL_MS },
      { label: '7 days', ttlMs: USER_INVITE_MAX_TTL_MS },
    ],
  });
}

import { NextResponse } from 'next/server';
import { requireTrustedControl } from '@/lib/control-auth';
import {
  listHostUsers,
  listUserInvitations,
  USER_INVITE_DEFAULT_TTL_MS,
  USER_INVITE_MAX_TTL_MS,
  USER_INVITE_MIN_TTL_MS,
} from '@/lib/auth-service';
import { readModuleMetadata, readModulesStoreSnapshot } from '@/lib/module-store';

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

async function listAssignableModules() {
  const store = await readModulesStoreSnapshot();
  const modules = await Promise.all(
    store.modules.map(async module => {
      try {
        const metadata = await readModuleMetadata(module);
        return {
          id: module.id,
          name: metadata?.name || module.id,
          version: metadata?.version,
          operationStatus: module.operationStatus || 'installed',
        };
      } catch {
        return {
          id: module.id,
          name: module.id,
          operationStatus: module.operationStatus || 'installed',
        };
      }
    })
  );

  return modules.sort((left, right) => left.name.localeCompare(right.name));
}

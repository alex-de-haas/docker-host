import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { canUseHostApi } from './auth-policy.ts';
import {
  authenticateSessionToken,
  getAuthStatus,
  SESSION_COOKIE_NAME,
} from './auth-service.ts';
import type { HostPrincipal } from '../types/auth.ts';

export async function requireHostAdminPage(): Promise<HostPrincipal> {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    redirect('/setup');
  }

  const principal = await getCurrentPagePrincipal();
  if (!principal || !canUseHostApi(principal, 'host.read')) {
    redirect('/login');
  }

  return principal;
}

export async function redirectAuthenticatedPage() {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    redirect('/setup');
  }

  const principal = await getCurrentPagePrincipal();
  if (principal && canUseHostApi(principal, 'host.read')) {
    redirect('/');
  }
}

export async function redirectSetupCompletePage() {
  const status = await getAuthStatus();
  if (!status.setupRequired) {
    redirect('/login');
  }
}

async function getCurrentPagePrincipal() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return await authenticateSessionToken(sessionToken);
}

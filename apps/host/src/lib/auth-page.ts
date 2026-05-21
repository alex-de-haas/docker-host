import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { canUseHostApi, canUseHostShell, getDefaultHostShellPath } from './auth-policy.ts';
import {
  authenticateSessionToken,
  getAuthStatus,
  isDevAuthAutoLoginEnabled,
  SESSION_COOKIE_NAME,
} from './auth-service.ts';
import type { HostPrincipal } from '../types/auth.ts';

export async function requireHostAdminPage(): Promise<HostPrincipal> {
  const principal = await requireHostPrincipalPage();
  if (!canUseHostApi(principal, 'host.read')) {
    redirect('/login');
  }

  return principal;
}

export async function requireHostPrincipalPage(): Promise<HostPrincipal> {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    if (isDevAuthAutoLoginEnabled()) {
      redirectToDevLogin('/');
    }
    redirect('/setup');
  }

  const principal = await getCurrentPagePrincipal();
  if (!principal || !canUseHostShell(principal)) {
    if (isDevAuthAutoLoginEnabled()) {
      redirectToDevLogin('/');
    }
    redirect('/login');
  }

  return principal;
}

export async function redirectAuthenticatedPage() {
  const status = await getAuthStatus();
  if (status.setupRequired) {
    if (isDevAuthAutoLoginEnabled()) {
      redirectToDevLogin('/');
    }
    redirect('/setup');
  }

  const principal = await getCurrentPagePrincipal();
  if (principal && canUseHostShell(principal)) {
    redirect(getDefaultHostShellPath(principal));
  }
  if (isDevAuthAutoLoginEnabled()) {
    redirectToDevLogin('/');
  }
}

export async function redirectSetupCompletePage() {
  const status = await getAuthStatus();
  if (status.setupRequired && isDevAuthAutoLoginEnabled()) {
    redirectToDevLogin('/');
  }

  if (!status.setupRequired) {
    if (isDevAuthAutoLoginEnabled()) {
      redirectToDevLogin('/');
    }
    redirect('/login');
  }
}

async function getCurrentPagePrincipal() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return await authenticateSessionToken(sessionToken);
}

function redirectToDevLogin(redirectTo: string): never {
  redirect(`/api/auth/dev-login?redirectTo=${encodeURIComponent(redirectTo)}`);
}

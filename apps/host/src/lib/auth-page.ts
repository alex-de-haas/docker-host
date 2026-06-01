import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { canUseHostApi, canUseHostShell, getDefaultHostShellPath } from './auth-policy.ts';
import { isHostDataRootUnavailableError } from './host-runtime.ts';
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
  try {
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
  } catch (error) {
    if (isHostDataRootUnavailableError(error)) {
      redirect('/data-root-unavailable');
    }
    throw error;
  }
}

export async function redirectAuthenticatedPage() {
  try {
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
  } catch (error) {
    if (isHostDataRootUnavailableError(error)) {
      redirect('/data-root-unavailable');
    }
    throw error;
  }
}

export async function redirectSetupCompletePage() {
  try {
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
  } catch (error) {
    if (isHostDataRootUnavailableError(error)) {
      redirect('/data-root-unavailable');
    }
    throw error;
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

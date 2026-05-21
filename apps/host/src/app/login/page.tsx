import { redirectAuthenticatedPage } from '@/lib/auth-page';
import { getOidcLoginStatus } from '@/lib/oidc-service';
import { LoginClient } from './LoginClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const mode = readSearchParam(params, 'mode');
  const redirectTo = normalizeRedirectTo(readSearchParam(params, 'redirectTo'));
  if (mode !== 'add-account') {
    await redirectAuthenticatedPage();
  }

  const oidc = await getOidcLoginStatus();
  return <LoginClient oidcProvider={oidc.provider} mode={mode} redirectTo={redirectTo} />;
}

function readSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string
) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRedirectTo(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return undefined;
  }

  return value;
}

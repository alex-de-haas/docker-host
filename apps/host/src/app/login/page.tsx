import { redirectAuthenticatedPage } from '@/lib/auth-page';
import { getOidcLoginStatus } from '@/lib/oidc-service';
import { LoginClient } from './LoginClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function LoginPage() {
  await redirectAuthenticatedPage();
  const oidc = await getOidcLoginStatus();
  return <LoginClient oidcProvider={oidc.provider} />;
}

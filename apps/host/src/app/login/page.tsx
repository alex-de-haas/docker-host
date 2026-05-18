import { redirectAuthenticatedPage } from '@/lib/auth-page';
import { LoginClient } from './LoginClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function LoginPage() {
  await redirectAuthenticatedPage();
  return <LoginClient />;
}

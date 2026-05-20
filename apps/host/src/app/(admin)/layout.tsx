import { AdminPrincipalProvider } from '@/components/AdminShell';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { isDevelopmentRuntime } from '@/lib/auth-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await requireHostPrincipalPage();

  return (
    <AdminPrincipalProvider user={user} isDevelopmentRuntime={isDevelopmentRuntime()}>
      {children}
    </AdminPrincipalProvider>
  );
}

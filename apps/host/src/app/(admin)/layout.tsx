import { AdminPrincipalProvider } from '@/components/AdminShell';
import { requireHostAdminPage } from '@/lib/auth-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await requireHostAdminPage();

  return (
    <AdminPrincipalProvider user={user}>
      {children}
    </AdminPrincipalProvider>
  );
}

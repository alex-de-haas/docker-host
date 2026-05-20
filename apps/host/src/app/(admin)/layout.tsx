import { AdminPrincipalProvider } from '@/components/AdminShell';
import { requireHostPrincipalPage } from '@/lib/auth-page';

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

function isDevelopmentRuntime() {
  const hostRuntimeMode = process.env.HOST_RUNTIME_MODE?.trim().toLowerCase();
  if (hostRuntimeMode) {
    return hostRuntimeMode === 'development';
  }

  return process.env.NODE_ENV === 'development';
}

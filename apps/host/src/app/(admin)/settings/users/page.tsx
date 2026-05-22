import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { UserManagementClient } from './UserManagementClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function UserManagementPage() {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="User Management" />;
  }

  return <UserManagementClient />;
}

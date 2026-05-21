'use client';

import Link from 'next/link';
import { LayoutGrid, ShieldAlert } from 'lucide-react';
import { AdminShell } from '@/components/AdminShell';
import { Button } from '@/components/ui/button';

export function AccessDeniedClient({
  resourceName = 'Host management',
}: {
  resourceName?: string;
}) {
  return (
    <AdminShell
      title="Access denied"
      description={`${resourceName} requires a Host administrator account.`}
      contentClassName="flex min-h-full items-center justify-center"
    >
      <section className="w-full max-w-lg rounded-md border bg-background px-6 py-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="mt-4 space-y-2">
          <h2 className="text-lg font-semibold">Administrator access required</h2>
          <p className="text-sm text-muted-foreground">
            This area is limited to Host administrators. Your account can continue using assigned Apps.
          </p>
        </div>
        <div className="mt-6 flex justify-center">
          <Button asChild>
            <Link href="/apps">
              <LayoutGrid className="h-4 w-4" />
              Open Apps
            </Link>
          </Button>
        </div>
      </section>
    </AdminShell>
  );
}

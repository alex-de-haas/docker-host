import { AppsPortalClient } from './AppsPortalClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AppsPage() {
  return <AppsPortalClient />;
}

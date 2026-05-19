import { IngressClient } from './IngressClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function IngressPage() {
  return <IngressClient />;
}

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { checkContainerImageUpdates, formatDockerError } from '@/lib/docker';

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'host.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const updates = await checkContainerImageUpdates();
    return NextResponse.json({ updates });
  } catch (error) {
    console.error('Error checking container image updates:', error);
    return NextResponse.json(
      { error: 'Failed to check container image updates', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { checkContainerImageUpdates, formatDockerError } from '@/lib/docker';

export async function POST() {
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

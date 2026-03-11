import { NextResponse } from 'next/server';
import { formatDockerError, getContainer, getContainerLogs } from '@/lib/docker';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const logs = searchParams.get('logs');
    
    if (logs === 'true') {
      const tail = parseInt(searchParams.get('tail') || '100');
      const logsData = await getContainerLogs(id, tail);
      return NextResponse.json({ logs: logsData });
    }
    
    const container = await getContainer(id);
    return NextResponse.json(container);
  } catch (error) {
    console.error('Error fetching container:', error);
    return NextResponse.json(
      { error: 'Failed to fetch container', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

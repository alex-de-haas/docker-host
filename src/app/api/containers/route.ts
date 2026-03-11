import { NextResponse } from 'next/server';
import { getContainers, startContainer, stopContainer, restartContainer, removeContainer, createAndStartContainer } from '@/lib/docker';

export async function GET() {
  try {
    const containers = await getContainers(true);
    return NextResponse.json(containers);
  } catch (error) {
    console.error('Error fetching containers:', error);
    return NextResponse.json(
      { error: 'Failed to fetch containers', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const config = await request.json();
    const result = await createAndStartContainer(config);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error creating container:', error);
    return NextResponse.json(
      { error: 'Failed to create container', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const { id, action } = await request.json();
    
    let result;
    switch (action) {
      case 'start':
        result = await startContainer(id);
        break;
      case 'stop':
        result = await stopContainer(id);
        break;
      case 'restart':
        result = await restartContainer(id);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error performing action:', error);
    return NextResponse.json(
      { error: 'Failed to perform action', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const force = searchParams.get('force') === 'true';
    
    if (!id) {
      return NextResponse.json({ error: 'Container ID required' }, { status: 400 });
    }
    
    const result = await removeContainer(id, force);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error removing container:', error);
    return NextResponse.json(
      { error: 'Failed to remove container', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

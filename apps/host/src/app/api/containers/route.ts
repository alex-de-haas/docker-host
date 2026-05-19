import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import {
  formatDockerError,
  getContainers,
  startContainer,
  stopContainer,
  restartContainer,
  updateContainer,
  updateContainerEnvironment,
  removeContainer,
  createAndStartContainer,
} from '@/lib/docker';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const containers = await getContainers(true);
    return NextResponse.json(containers);
  } catch (error) {
    console.error('Error fetching containers:', error);
    return NextResponse.json(
      { error: 'Failed to fetch containers', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireHostAdmin(request, 'host.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const config = await request.json();
    const result = await createAndStartContainer(config);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error creating container:', error);
    return NextResponse.json(
      { error: 'Failed to create container', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireHostAdmin(request, 'host.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const { id, action, envVars } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Container ID required' }, { status: 400 });
    }
    
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
      case 'update':
        result = await updateContainer(id);
        break;
      case 'environment':
        result = await updateContainerEnvironment(id, envVars);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error performing action:', error);
    return NextResponse.json(
      { error: 'Failed to perform action', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await requireHostAdmin(request, 'host.configure');
  if (auth instanceof NextResponse) {
    return auth;
  }

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
      { error: 'Failed to remove container', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { requireHostAdmin } from '@/lib/auth-http';
import { formatDockerError, getImages, pullImage } from '@/lib/docker';

export async function GET(request: Request) {
  const auth = await requireHostAdmin(request, 'host.read');
  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const images = await getImages();
    return NextResponse.json(images);
  } catch (error) {
    console.error('Error fetching images:', error);
    return NextResponse.json(
      { error: 'Failed to fetch images', details: formatDockerError(error) },
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
    const { image, tag } = await request.json();
    const result = await pullImage(image, tag);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error pulling image:', error);
    return NextResponse.json(
      { error: 'Failed to pull image', details: formatDockerError(error) },
      { status: 500 }
    );
  }
}

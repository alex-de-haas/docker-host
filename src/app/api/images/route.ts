import { NextResponse } from 'next/server';
import { getImages, pullImage } from '@/lib/docker';

export async function GET() {
  try {
    const images = await getImages();
    return NextResponse.json(images);
  } catch (error) {
    console.error('Error fetching images:', error);
    return NextResponse.json(
      { error: 'Failed to fetch images', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { image, tag } = await request.json();
    const result = await pullImage(image, tag);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error pulling image:', error);
    return NextResponse.json(
      { error: 'Failed to pull image', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

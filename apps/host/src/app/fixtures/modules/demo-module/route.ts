import { NextResponse } from 'next/server';
import demoModuleMetadata from '../../../../../../../modules/demo-module/metadata.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOCAL_DEMO_IMAGE_REPOSITORY = 'docker-host-demo-module';
const LOCAL_DEMO_IMAGE_TAG = 'dev';

export async function GET() {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  const metadata = demoModuleMetadata as Record<string, unknown>;

  return NextResponse.json({
    ...metadata,
    image: {
      ...readRecord(metadata.image),
      repository: process.env.HOST_DEMO_MODULE_IMAGE_REPOSITORY?.trim() || LOCAL_DEMO_IMAGE_REPOSITORY,
      tag: process.env.HOST_DEMO_MODULE_IMAGE_TAG?.trim() || LOCAL_DEMO_IMAGE_TAG,
      pullPolicy: 'ifNotPresent',
    },
  });
}

function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isDevFixtureEnabled() {
  return process.env.NODE_ENV !== 'production' ||
    process.env.HOST_ENABLE_DEV_FIXTURES === 'true';
}

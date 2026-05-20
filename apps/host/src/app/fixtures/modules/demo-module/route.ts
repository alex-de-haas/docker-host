import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOCAL_DEMO_IMAGE_REPOSITORY = 'docker-host-demo-module';
const LOCAL_DEMO_IMAGE_TAG = 'dev';

export async function GET() {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  const metadata = await readCurrentDemoMetadata();
  if (!metadata) {
    return NextResponse.json(
      { error: 'Current demo module metadata could not be found.' },
      { status: 500 }
    );
  }

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

async function readCurrentDemoMetadata() {
  for (const candidatePath of getDemoMetadataPaths()) {
    try {
      return JSON.parse(await fs.readFile(candidatePath, 'utf-8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return null;
}

function getDemoMetadataPaths() {
  return [
    path.resolve(process.cwd(), 'modules/demo-module/metadata.json'),
    path.resolve(process.cwd(), '../../modules/demo-module/metadata.json'),
  ];
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

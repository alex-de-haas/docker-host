import { NextResponse } from 'next/server';
import demoAppManifest from '../../../../../../../apps/demo-app/manifest.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOCAL_DEMO_APP_IMAGE_REPOSITORY = 'hosty-demo-app';
const LOCAL_DEMO_APP_IMAGE_TAG = 'dev';

export async function GET() {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture manifest is disabled.' }, { status: 404 });
  }

  const manifest = cloneRecord(demoAppManifest);
  rewriteDockerRuntimeImages(manifest);

  return NextResponse.json(manifest);
}

function rewriteDockerRuntimeImages(manifest: Record<string, unknown>) {
  const repository = process.env.HOST_DEMO_APP_IMAGE_REPOSITORY?.trim() || LOCAL_DEMO_APP_IMAGE_REPOSITORY;
  const tag = process.env.HOST_DEMO_APP_IMAGE_TAG?.trim() || LOCAL_DEMO_APP_IMAGE_TAG;

  for (const service of readArray(manifest.services)) {
    const runtimes = readRecord(service.runtimes);
    for (const runtime of Object.values(runtimes)) {
      const runtimeRecord = readRecord(runtime);
      if (runtimeRecord.type !== 'docker') {
        continue;
      }

      runtimeRecord.image = {
        ...readRecord(runtimeRecord.image),
        repository,
        tag,
        pullPolicy: 'ifNotPresent',
      };
    }
  }
}

function cloneRecord(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readArray(value: unknown) {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
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

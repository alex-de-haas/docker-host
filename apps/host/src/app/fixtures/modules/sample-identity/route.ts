import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  return NextResponse.json({
    schemaVersion: '0.1',
    id: 'com.example.identity',
    name: 'Example Identity',
    description: 'Development identity service fixture.',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/alex-de-haas/demo-module',
      tag: 'latest',
      pullPolicy: 'ifNotPresent',
    },
    dependencies: [],
    settings: [
      {
        key: 'IDENTITY_ISSUER',
        type: 'url',
        required: true,
        default: 'https://identity.example.test',
        target: {
          type: 'env',
          name: 'IDENTITY_ISSUER',
        },
      },
    ],
    storage: {
      directories: [
        {
          key: 'data',
          label: 'Data',
          description: 'Identity state.',
          containerPath: '/app/data',
          purpose: 'data',
          required: true,
          writable: true,
          mount: {
            recommended: true,
            type: 'bind',
            modulePath: 'data',
          },
        },
      ],
      mountCollections: [],
    },
    runtime: {
      ports: [
        {
          key: 'http',
          containerPort: 3000,
          protocol: 'http',
          public: false,
        },
      ],
      resources: {
        cpus: 0.25,
        memory: '128m',
      },
    },
  });
}

function isDevFixtureEnabled() {
  return process.env.NODE_ENV !== 'production' ||
    process.env.HOST_ENABLE_DEV_FIXTURES === 'true';
}

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  return NextResponse.json({
    schemaVersion: '0.2',
    id: 'com.example.identity',
    name: 'Example Identity',
    description: 'Development identity service fixture.',
    version: '1.0.0',
    containers: [
      {
        key: 'app',
        image: {
          repository: 'ghcr.io/example/docker-host-identity',
          tag: '1.0.0',
          pullPolicy: 'ifNotPresent',
        },
        runtime: {
          ports: [
            {
              key: 'http',
              containerPort: 8080,
              protocol: 'http',
            },
          ],
          resources: {
            cpus: 0.25,
            memory: '128m',
          },
        },
      },
    ],
    endpoints: [
      {
        key: 'http',
        container: 'app',
        port: 'http',
        public: false,
      },
    ],
    dependencies: [],
    settings: [
      {
        key: 'IDENTITY_ISSUER',
        type: 'url',
        required: true,
        default: 'https://identity.example.test',
        targets: [
          {
            container: 'app',
            type: 'env',
            name: 'IDENTITY_ISSUER',
          },
        ],
      },
    ],
    storage: {
      directories: [
        {
          key: 'data',
          label: 'Data',
          description: 'Identity state.',
          purpose: 'data',
          required: true,
          targets: [
            {
              container: 'app',
              containerPath: '/app/data',
              writable: true,
            },
          ],
          mount: {
            recommended: true,
            type: 'bind',
            modulePath: 'data',
          },
        },
      ],
      mountCollections: [],
    },
  });
}

function isDevFixtureEnabled() {
  return process.env.NODE_ENV !== 'production' ||
    process.env.HOST_ENABLE_DEV_FIXTURES === 'true';
}

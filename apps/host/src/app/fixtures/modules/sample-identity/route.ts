import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    schemaVersion: '0.1',
    id: 'com.example.identity',
    name: 'Example Identity',
    description: 'Development identity service fixture.',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/example/docker-host-identity',
      tag: '1.0.0',
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
          containerPort: 8080,
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

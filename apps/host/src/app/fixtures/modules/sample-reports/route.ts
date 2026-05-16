import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return NextResponse.json({
    schemaVersion: '0.1',
    id: 'com.example.reports',
    name: 'Example Reports',
    description: 'Development reports module fixture.',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/example/docker-host-reports',
      tag: '1.0.0',
      pullPolicy: 'ifNotPresent',
    },
    dependencies: [
      {
        id: 'com.example.identity',
        version: '1',
        required: true,
        metadataUrl: new URL('/fixtures/modules/sample-identity', request.url).toString(),
        connection: {
          endpoint: 'http',
          baseUrlEnv: 'IDENTITY_BASE_URL',
        },
      },
    ],
    settings: [
      {
        key: 'REPORT_RETENTION_DAYS',
        type: 'number',
        required: true,
        default: 30,
        target: {
          type: 'env',
          name: 'REPORT_RETENTION_DAYS',
        },
      },
      {
        key: 'REPORTS_PUBLIC_URL',
        type: 'url',
        required: false,
        default: 'https://reports.example.test',
        target: {
          type: 'env',
          name: 'REPORTS_PUBLIC_URL',
        },
      },
      {
        key: 'EXTERNAL_API_TOKEN',
        type: 'secret',
        required: true,
        target: {
          type: 'env',
          name: 'EXTERNAL_API_TOKEN',
        },
      },
    ],
    storage: {
      directories: [
        {
          key: 'data',
          label: 'Data',
          description: 'Generated reports and local state.',
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
        {
          key: 'cache',
          label: 'Cache',
          containerPath: '/app/cache',
          purpose: 'cache',
          required: false,
          writable: true,
          mount: {
            recommended: true,
            type: 'bind',
            modulePath: 'cache',
          },
        },
      ],
      mountCollections: [
        {
          key: 'libraries',
          label: 'Report libraries',
          description: 'External folders scanned by the reports module.',
          purpose: 'data',
          required: true,
          minItems: 1,
          maxItems: 3,
          writable: true,
          containerPathPrefix: '/storage/libraries',
          itemContainerPathTemplate: '/storage/libraries/{key}',
          hostPathPolicy: {
            mode: 'adminSelected',
            allowExternal: true,
          },
        },
      ],
    },
    runtime: {
      ports: [
        {
          key: 'http',
          containerPort: 8080,
          protocol: 'http',
          public: true,
        },
      ],
      resources: {
        cpus: 0.5,
        memory: '256m',
      },
    },
  });
}

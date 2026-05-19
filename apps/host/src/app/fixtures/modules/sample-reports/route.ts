import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  return NextResponse.json({
    schemaVersion: '0.1',
    id: 'com.example.reports',
    name: 'Example Reports',
    description: 'Development reports module fixture.',
    version: '1.0.0',
    image: {
      repository: 'ghcr.io/alex-de-haas/demo-module',
      tag: 'latest',
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
        required: false,
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
          required: false,
          minItems: 0,
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
          containerPort: 3000,
          protocol: 'http',
          public: true,
        },
      ],
      resources: {
        cpus: 0.5,
        memory: '256m',
      },
    },
    ui: {
      category: 'Apps',
      icon: 'boxes',
      entrypoint: {
        portKey: 'http',
        path: '/',
      },
      navigation: [
        {
          label: 'Overview',
          path: '/',
        },
        {
          label: 'People',
          path: '/people',
        },
        {
          label: 'Settings',
          path: '/settings',
        },
      ],
    },
  });
}

function isDevFixtureEnabled() {
  return process.env.NODE_ENV !== 'production' ||
    process.env.HOST_ENABLE_DEV_FIXTURES === 'true';
}

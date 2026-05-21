import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  if (!isDevFixtureEnabled()) {
    return NextResponse.json({ error: 'Fixture metadata is disabled.' }, { status: 404 });
  }

  return NextResponse.json({
    schemaVersion: '0.2',
    id: 'com.example.reports',
    name: 'Example Reports',
    description: 'Development reports module fixture.',
    version: '1.0.0',
    containers: [
      {
        key: 'app',
        image: {
          repository: 'ghcr.io/example/docker-host-reports',
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
            cpus: 0.5,
            memory: '256m',
          },
        },
      },
    ],
    endpoints: [
      {
        key: 'http',
        container: 'app',
        port: 'http',
        public: true,
      },
    ],
    dependencies: [
      {
        id: 'com.example.identity',
        version: '1',
        required: true,
        metadataUrl: new URL('/fixtures/modules/sample-identity', request.url).toString(),
        connection: {
          endpoint: 'http',
          targets: [
            {
              container: 'app',
              type: 'env',
              name: 'IDENTITY_BASE_URL',
            },
          ],
        },
      },
    ],
    settings: [
      {
        key: 'REPORT_RETENTION_DAYS',
        type: 'number',
        required: true,
        default: 30,
        targets: [
          {
            container: 'app',
            type: 'env',
            name: 'REPORT_RETENTION_DAYS',
          },
        ],
      },
      {
        key: 'REPORTS_PUBLIC_URL',
        type: 'url',
        required: false,
        default: 'https://reports.example.test',
        targets: [
          {
            container: 'app',
            type: 'env',
            name: 'REPORTS_PUBLIC_URL',
          },
        ],
      },
      {
        key: 'EXTERNAL_API_TOKEN',
        type: 'secret',
        required: true,
        targets: [
          {
            container: 'app',
            type: 'env',
            name: 'EXTERNAL_API_TOKEN',
          },
        ],
      },
    ],
    storage: {
      directories: [
        {
          key: 'data',
          label: 'Data',
          description: 'Generated reports and local state.',
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
        {
          key: 'cache',
          label: 'Cache',
          purpose: 'cache',
          required: false,
          targets: [
            {
              container: 'app',
              containerPath: '/app/cache',
              writable: true,
            },
          ],
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
          targets: [
            {
              container: 'app',
              containerPathPrefix: '/storage/libraries',
              itemContainerPathTemplate: '/storage/libraries/{key}',
              writable: true,
            },
          ],
          hostPathPolicy: {
            mode: 'adminSelected',
            allowExternal: true,
          },
        },
      ],
    },
  });
}

function isDevFixtureEnabled() {
  return process.env.NODE_ENV !== 'production' ||
    process.env.HOST_ENABLE_DEV_FIXTURES === 'true';
}

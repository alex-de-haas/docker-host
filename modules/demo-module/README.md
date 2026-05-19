# Docker Host Demo Module

Demo Module is a small Next.js application used to validate Docker Host module operations:

- install and remove through `metadata.json`;
- start, stop, restart, and update lifecycle actions;
- setting injection through environment variables;
- module-owned storage mounts under `/app/data` and `/app/logs`;
- optional external mount collections under `/mnt/sources/{key}`;
- health-check and inspection endpoints for future Host features.

## Metadata

The module metadata lives at:

```text
modules/demo-module/metadata.json
```

For Docker Host testing, install the module from the raw metadata URL in this repository. The metadata uses the GitHub Container Registry image reference:

```text
ghcr.io/alex-de-haas/demo-module:latest
```

The CI image workflow publishes this image to GitHub Container Registry. Docker Host pulls it on install and update because the metadata uses `pullPolicy: always`.

## Build the module image

From the repository root:

```bash
npm run demo-module:docker:build
```

Then install the module in Docker Host:

```bash
docker-host modules install https://raw.githubusercontent.com/alex-de-haas/docker-host/main/modules/demo-module/metadata.json
```

## Local app development

Run the app without Docker:

```bash
npm run demo-module:dev
```

The development server listens on `http://localhost:3100`.

Useful endpoints:

- `/` - demo dashboard;
- `/api/health` - health and storage probe;
- `/api/config` - sanitized runtime config;
- `/api/people` - sample people payload.

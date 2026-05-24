# Demo Module

## Description

Demo Module is a repository-local Docker Host module under `modules/demo-module`. It is a small Next.js application that gives Docker Host a stable target for validating module operations during development.

The module is intentionally small but covers the module contracts Docker Host needs to validate: it exposes a dashboard, assigned Host user data from the scoped module directory, module-owned role assignments, sanitized runtime configuration, storage probes, Host gateway identity diagnostics, direct-origin shell identity bootstrap, module directory access, and a health endpoint. The metadata file exercises the current module schema with settings, module-owned storage directories, an optional external mount collection, a public HTTP runtime port, health-check metadata, resource hints, and shell UI metadata. The UI uses the same Tailwind v4, shadcn `new-york` component style, semantic theme tokens, and lucide icon library as the Host app so embedded module screens keep the Host visual language. The image is published to GitHub Container Registry as `ghcr.io/alex-de-haas/demo-module`.

```mermaid
flowchart LR
  A["modules/demo-module/metadata.json"] --> B["Docker Host install plan"]
  B --> C["ghcr.io/alex-de-haas/demo-module:latest"]
  C --> D["Next.js demo app"]
  D --> M["/"]
  D --> N["/people"]
  D --> R["/roles"]
  D --> O["/settings"]
  D --> E["/api/health"]
  D --> F["/api/config"]
  D --> G["/api/people"]
  D --> P["/api/roles"]
  D --> J["/api/auth/identity"]
  J --> K["Host JWKS discovery"]
  J --> L["Scoped module directory"]
  P --> Q["module-roles.json"]
  B --> H["/app/data and /app/logs mounts"]
  B --> I["optional /mnt/sources/{key} mounts"]
```

## Files

- `modules/demo-module/metadata.json` - Docker Host metadata used for install and update tests.
- `modules/demo-module/Dockerfile` - production image build for the demo module.
- `modules/demo-module/src/app/page.tsx` - demo dashboard.
- `modules/demo-module/src/app/people/page.tsx` - stable people page for shell app navigation.
- `modules/demo-module/src/app/roles/page.tsx` - module-owned role assignment test page.
- `modules/demo-module/src/app/settings/page.tsx` - stable settings page for shell app navigation.
- `modules/demo-module/src/app/globals.css` - Tailwind v4 theme tokens aligned with `apps/host/src/app/globals.css`.
- `modules/demo-module/src/components/DemoModuleUi.tsx` - shared dashboard layout, metric, detail, people, and storage UI composition.
- `modules/demo-module/src/components/ui/*` - local shadcn UI primitives mirrored from the Host app where needed.
- `modules/demo-module/src/app/api/health/route.ts` - health and writable-storage probe.
- `modules/demo-module/src/app/api/config/route.ts` - sanitized runtime configuration.
- `modules/demo-module/src/app/api/people/route.ts` - assigned Host users from the scoped module directory.
- `modules/demo-module/src/app/api/roles/route.ts` - assigned Host users with effective module roles.
- `modules/demo-module/src/app/api/roles/[userId]/route.ts` - module-owned role assignment mutation.
- `modules/demo-module/src/app/api/auth/identity/route.ts` - Host gateway or shell identity, request-header, module directory, and module-owned permission diagnostics.
- `modules/demo-module/src/app/api/auth/bootstrap/route.ts` - direct-origin shell iframe bootstrap endpoint that stores a Host-issued module identity token in a module-origin cookie.
- `modules/demo-module/src/components/HostIdentityBridge.tsx` - client-side `postMessage` bridge that requests identity from the Host shell and bootstraps the module session.
- `modules/demo-module/src/lib/host-auth.ts` - module-side validation of Host-issued module identity JWTs from `X-Docker-Host-Identity` or the module identity cookie, plus scoped directory lookup.
- `modules/demo-module/src/lib/module-roles.ts` - module-owned JSON role store and effective permission mapping.

## Local Development

Run the Next.js app directly:

```bash
npm run demo-module:dev
```

The development server listens on `http://localhost:3100`.

Run the Host shell with this current checkout's demo module already linked as a developer app:

```bash
npm run host:dev:demo
```

This starts Docker Host with auto-login and module developer mode enabled, signs in as the development administrator by default, remembers the normal development user for account switching, starts the demo module dev server, and seeds `.docker-host-dev-demo/dev/module-targets.json` so the app appears in the Apps sidebar immediately.

Run Docker Host from a built Host image and install the built demo module image as a real managed module:

```bash
docker build -f apps/host/Dockerfile -t docker-host:dev .
npm run demo-module:docker:build:local
docker-host config set HOST_IMAGE docker-host:dev
docker-host config set HOST_DATA_ROOT_HOST "$HOME/.docker-host-dev"
docker-host start
docker-host open
```

Then install the fixture metadata from `/modules/install` using `http://localhost:3000/fixtures/modules/demo-module`. This mode is slower, but it exercises the same installed-module lifecycle path used by production-like runs: install plan, install apply, module container creation, start/stop/restart, runtime status, storage mounts, shell app discovery, direct iframe navigation, and Host identity propagation.

## Docker Image

Build the local image from the repository root:

```bash
npm run demo-module:docker:build
```

The metadata uses:

```text
ghcr.io/alex-de-haas/demo-module:latest
```

For current-branch install testing, build the local development tag instead:

```bash
npm run demo-module:docker:build:local
```

Then install the Host fixture metadata at:

```text
http://localhost:3000/fixtures/modules/demo-module
```

That fixture rewrites the image reference to `docker-host-demo-module:dev` with `pullPolicy: ifNotPresent`, so the Host installs the locally built image instead of the published registry image.

The CI image workflow publishes `latest` and SHA tags to GitHub Container Registry. It authenticates with the built-in `GITHUB_TOKEN`, so no extra registry secrets are required. The metadata uses `pullPolicy: always`, so Docker Host pulls the rolling image on install and update.

## Install Testing

Docker Host accepts a URL to a metadata JSON file. Install this module from the repository metadata URL:

```bash
docker-host modules install https://raw.githubusercontent.com/alex-de-haas/docker-host/main/modules/demo-module/metadata.json
```

The module currently validates these Host flows:

- install plan generation from metadata;
- settings prompts and env injection;
- module-owned storage directory creation and mounting;
- optional external mount collection input;
- container start, stop, restart, remove, and update paths;
- health-check metadata and the module's own `/api/health` endpoint;
- shell app discovery through `ui.entrypoint` and nested navigation for `/`, `/people`, `/roles`, and `/settings`;
- assigned Host user rendering on `/people` and `/api/people` through the scoped module directory;
- module-owned role assignment on `/roles` and `/api/roles` using stable Host user ids;
- gateway exposure policies through the presence or absence of a Host identity token;
- direct-origin shell identity bootstrap through the Host `postMessage` bridge and `/api/auth/bootstrap`;
- module identity token validation through Host discovery and JWKS endpoints;
- module-scoped directory reads through `DOCKER_HOST_INTERNAL_ORIGIN`, `DOCKER_HOST_MODULE_ID`, and `DOCKER_HOST_MODULE_SERVICE_TOKEN`;
- module-owned permission mapping from Host identity claims and explicit role assignments;
- gateway request sanitization, including stripped Host session cookies and visible `X-Docker-Host-*` headers;
- authorization diagnostics through `/api/auth/identity`.

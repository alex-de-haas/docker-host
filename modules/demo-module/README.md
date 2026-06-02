# Docker Host Demo Module

Demo Module is a small Next.js application used to validate Docker Host module operations:

- install and remove through `metadata.json`;
- start, stop, restart, and update lifecycle actions;
- two-service frontend/backend metadata with startup dependency and internal endpoint wiring;
- setting injection through environment variables;
- module-owned storage mounts under `/app/data` and `/app/logs`;
- optional external mount collections under `/mnt/sources/{key}`;
- Host gateway identity token propagation and validation;
- provider-neutral external ingress readiness checks;
- shell app discovery metadata with stable overview, people, roles, and settings routes;
- scoped module directory access through the module service token;
- assigned Host user rendering from the scoped module directory;
- module-owned role assignment and permission mapping from Host identity claims;
- health-check and inspection endpoints for Host features.

The module UI uses the same Tailwind v4, shadcn `new-york` primitives, semantic theme tokens, and lucide icon library as the Host app. This keeps the standalone demo routes and embedded Host app surface visually consistent.

## Metadata

The module metadata lives at:

```text
modules/demo-module/metadata.json
modules/demo-module/metadata.dev.json
```

For Docker Host testing, install the module from the raw metadata URL in this repository. The metadata declares two services:

- `backend` exposes the non-public `api` endpoint;
- `frontend` depends on `backend`, exposes the public `http` endpoint, and receives `DEMO_BACKEND_BASE_URL` from the `api` endpoint connection.

Both services currently use the same GitHub Container Registry image reference:

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
hosty modules install https://raw.githubusercontent.com/alex-de-haas/docker-host/main/modules/demo-module/metadata.json
```

## Local app development

Run the frontend-compatible app process without Docker:

```bash
npm run demo-module:dev
```

The development server listens on `http://localhost:3100`.

The development metadata also declares a `backend` process on `http://localhost:3101` so the same service keys, endpoint wiring, and dependency shape are available to the metadata validator. The current `hosty dev up` supervisor starts the process behind the selected public endpoint, which is the `frontend` service.

To run it through Docker Host with real gateway identity, app shell embedding, development users, assignments, and scoped directory behavior, use the repository-local dev metadata:

```bash
hosty dev up --manifest modules/demo-module/metadata.dev.json
```

For direct API diagnostics against the local module origin, issue a real Host-signed development token after `dev up` has prepared the target:

```bash
TOKEN="$(hosty dev identity --manifest modules/demo-module/metadata.dev.json --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

This is useful for checking module-side identity validation without a browser, but it is not a replacement for testing the app shell or gateway URLs printed by `hosty dev up`.

When running from inside `modules/demo-module`, the default works because the CLI discovers `metadata.dev.json` in the current directory:

```bash
hosty dev up
```

Useful endpoints:

- `/` - demo dashboard;
- `/people` - stable people page for shell app navigation;
- `/roles` - module-owned role assignment page;
- `/settings` - stable runtime settings page for shell app navigation;
- `/api/health` - health and storage probe;
- `/api/config` - sanitized runtime config;
- `/api/people` - assigned Host users from the scoped module directory;
- `/api/roles` - assigned Host users with effective module roles;
- `/api/auth/identity` - Host identity, gateway header, module directory, and module-owned permission diagnostics.

## Auth gateway testing

When the module is installed by Docker Host, each service container receives:

- `DOCKER_HOST_INTERNAL_ORIGIN` for Host discovery and internal APIs;
- `DOCKER_HOST_MODULE_ID` as the expected JWT audience;
- `DOCKER_HOST_MODULE_SERVICE_TOKEN` for the scoped module directory API.

Requests routed through a Host gateway exposure may include `X-Docker-Host-Identity`. The demo module validates that ES256 JWT against Host discovery and JWKS endpoints, shows the normalized claims on the dashboard, and exposes the same sanitized data through `/api/auth/identity`. The endpoint never returns raw bearer tokens, service tokens, session cookies, or raw identity JWTs.

## External ingress readiness testing

The demo module is suitable as the first manual external ingress readiness target because its `frontend` service metadata declares a public HTTP endpoint and a health endpoint:

```text
endpoints[].key = http
endpoints[].service = frontend
services[].healthCheck.path = /api/health
```

After installing the module, create a Host gateway exposure for the `http` port under `HOST_GATEWAY_BASE_DOMAIN`. The Host external ingress readiness panel can then generate manual DNS, reverse proxy, TLS, OIDC, and trusted-proxy setup guidance for that exposure. Once the external route is configured, use the demo dashboard and `/api/auth/identity` to verify that gateway identity headers, forwarded request headers, and module directory access still behave the same through the external hostname.

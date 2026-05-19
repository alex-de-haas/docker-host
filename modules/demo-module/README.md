# Docker Host Demo Module

Demo Module is a small Next.js application used to validate Docker Host module operations:

- install and remove through `metadata.json`;
- start, stop, restart, and update lifecycle actions;
- setting injection through environment variables;
- module-owned storage mounts under `/app/data` and `/app/logs`;
- optional external mount collections under `/mnt/sources/{key}`;
- Host gateway identity token propagation and validation;
- provider-neutral external ingress readiness checks;
- shell app discovery metadata with stable overview, people, and settings routes;
- scoped module directory access through the module service token;
- module-owned permission mapping from Host identity claims;
- health-check and inspection endpoints for Host features.

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
- `/people` - stable people page for shell app navigation;
- `/settings` - stable runtime settings page for shell app navigation;
- `/api/health` - health and storage probe;
- `/api/config` - sanitized runtime config;
- `/api/people` - sample people payload;
- `/api/auth/identity` - Host identity, gateway header, module directory, and module-owned permission diagnostics.

## Auth gateway testing

When the module is installed by Docker Host, the container receives:

- `DOCKER_HOST_INTERNAL_ORIGIN` for Host discovery and internal APIs;
- `DOCKER_HOST_MODULE_ID` as the expected JWT audience;
- `DOCKER_HOST_MODULE_SERVICE_TOKEN` for the scoped module directory API.

Requests routed through a Host gateway exposure may include `X-Docker-Host-Identity`. The demo module validates that ES256 JWT against Host discovery and JWKS endpoints, shows the normalized claims on the dashboard, and exposes the same sanitized data through `/api/auth/identity`. The endpoint never returns raw bearer tokens, service tokens, session cookies, or raw identity JWTs.

## External ingress readiness testing

The demo module is suitable as the first manual external ingress readiness target because its metadata declares a public HTTP runtime port and a health endpoint:

```text
runtime.ports[0].key = http
runtime.ports[0].public = true
runtime.healthcheck.path = /api/health
```

After installing the module, create a Host gateway exposure for the `http` port under `HOST_GATEWAY_BASE_DOMAIN`. The Host external ingress readiness panel can then generate manual DNS, reverse proxy, TLS, OIDC, and trusted-proxy setup guidance for that exposure. Once the external route is configured, use the demo dashboard and `/api/auth/identity` to verify that gateway identity headers, forwarded request headers, and module directory access still behave the same through the external hostname.

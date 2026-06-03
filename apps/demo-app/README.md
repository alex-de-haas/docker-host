# Hosty Demo App

Demo App is a small Next.js runtime app used to validate Hosty app operations:

- install and remove through `manifest.json`;
- start, stop, restart, and update lifecycle actions;
- two-service frontend/backend manifest shape with startup dependency and internal endpoint wiring;
- setting injection through environment variables;
- app-owned storage mounts under `/app/data` and `/app/logs`;
- optional external mount collections under `/mnt/sources/{key}`;
- Hosty app launch-code exchange and app-local session revalidation;
- Host gateway identity token propagation and validation;
- provider-neutral external ingress readiness checks;
- shell app discovery metadata with stable overview, people, roles, and settings routes;
- scoped app directory access through the app service token;
- assigned Host user rendering from the scoped app directory;
- app-owned role assignment and permission mapping from Host identity claims;
- health-check and inspection endpoints for Host features.

The app UI uses the same Tailwind v4, shadcn `new-york` primitives, semantic theme tokens, and lucide icon library as the Host app. This keeps the standalone demo routes and embedded Shell surface visually consistent.

## Manifest

The app manifest lives at:

```text
apps/demo-app/manifest.json
```

The manifest declares two services:

- `backend` exposes the non-public `api` endpoint;
- `frontend` depends on `backend`, exposes the public `http` endpoint, and receives `DEMO_BACKEND_BASE_URL` from the `api` endpoint connection.

Both services currently use the same GitHub Container Registry image reference:

```text
ghcr.io/alex-de-haas/demo-app:latest
```

Hosty pulls it on install and update because the manifest uses `pullPolicy: always`.

## Build The App Image

From the repository root:

```bash
npm run demo-app:docker:build
```

Then install the app in Hosty:

```bash
hosty apps install apps/demo-app/manifest.json
```

## Local App Development

Run the frontend-compatible app process without Docker:

```bash
npm run demo-app:dev
```

The development server listens on `http://localhost:3100`.

Useful endpoints:

- `/` - demo dashboard;
- `/people` - stable people page for shell app navigation;
- `/roles` - app-owned role assignment page;
- `/settings` - stable runtime settings page for shell app navigation;
- `/api/health` - health and storage probe;
- `/api/config` - sanitized runtime config;
- `/api/people` - assigned Host users from the scoped app directory;
- `/api/roles` - assigned Host users with effective app roles;
- `/api/auth/app-code` - app-owned exchange endpoint for one-time Hosty app authorization codes;
- `/api/auth/identity` - Host identity, gateway header, app directory, and app-owned permission diagnostics.

## Hosty App Session Testing

When Shell opens the app through Core, Core returns an app redirect URI with a short-lived `code` query parameter. The Demo App client removes that code from the URL, posts it to `/api/auth/app-code`, and stores the returned app-scoped identity token in an HttpOnly app-origin cookie. `/api/auth/identity` revalidates that app session against `HOSTY_CORE_ORIGIN` and reports the app id, Host user id, expiry, and any Core error without exposing the raw token.

The app reads:

- `HOSTY_APP_ID` as the installed app id;
- `HOSTY_CORE_ORIGIN` as the Core origin for token exchange and revalidation.

## Auth Gateway Testing

When the app is installed by Hosty, each service container receives:

- `DOCKER_HOST_INTERNAL_ORIGIN` for Host discovery and internal APIs;
- `DOCKER_HOST_MODULE_ID` as the expected JWT audience;
- `DOCKER_HOST_MODULE_SERVICE_TOKEN` for the scoped app directory API.

Requests routed through a Host gateway exposure may include `X-Docker-Host-Identity`. The demo app validates that ES256 JWT against Host discovery and JWKS endpoints, shows the normalized claims on the dashboard, and exposes the same sanitized data through `/api/auth/identity`. The endpoint never returns raw bearer tokens, service tokens, session cookies, or raw identity JWTs.

## External Ingress Readiness Testing

The demo app is suitable as the first manual external ingress readiness target because its `frontend` service manifest declares a public HTTP endpoint and a health endpoint:

```text
endpoints[].key = http
endpoints[].service = frontend
services[].healthCheck.path = /api/health
```

After installing the app, create a Host gateway exposure for the `http` port under `HOST_GATEWAY_BASE_DOMAIN`. The Host external ingress readiness panel can then generate manual DNS, reverse proxy, TLS, OIDC, and trusted-proxy setup guidance for that exposure. Once the external route is configured, use the demo dashboard and `/api/auth/identity` to verify that gateway identity headers, forwarded request headers, and app directory access still behave the same through the external hostname.

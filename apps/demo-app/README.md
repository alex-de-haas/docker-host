# Hosty Demo App

The Demo App is the repository-local Hosty runtime app used to validate app lifecycle, local command runtime profiles, app auth, scoped app directory access, app-owned roles, storage probes, and health endpoints.

## Local Core-Managed Run

```bash
hosty core start
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
hosty apps open com.haas.demo-app --user user@docker-host.local
```

If Core is already running from another terminal or debugger, run the `hosty apps ...` commands against that process.

## Runtime Environment

Core injects:

- `HOSTY_APP_ID`
- `HOSTY_APP_SERVICE_KEY`
- `HOSTY_APP_SERVICE_TOKEN`
- `HOSTY_CORE_ORIGIN`
- `HOSTY_APP_DATA_DIR`
- `HOSTY_PORT_HTTP`
- `PORT`

The app also reads demo settings from the manifest:

- `DEMO_GREETING`
- `DEMO_RELEASE_CHANNEL`
- `DEMO_REFRESH_SECONDS`
- `DEMO_AUTH_PREVIEW`

## API Routes

- `/api/health` - storage write probe and runtime health.
- `/api/config` - sanitized runtime configuration and storage paths.
- `/api/auth/app-code` - app authorization code exchange.
- `/api/auth/identity` - app identity and scoped directory diagnostics.
- `/api/people` - assigned Host users from the scoped app directory.
- `/api/roles` - app-owned role catalog and assignments.

## Direct Identity Probe

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

The endpoint revalidates the app identity token through Core and never returns raw tokens or cookies.

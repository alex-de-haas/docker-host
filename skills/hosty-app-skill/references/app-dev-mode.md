# App Developer Mode Reference

Use this reference when validating a local runtime app through Hosty without a full production install.

## Purpose

Developer mode lets app authors run a local development server behind Hosty routing. It validates Shell discovery, gateway access policy, identity token injection, header stripping, route rewriting, iframe embedding, WebSockets, SSE, and scoped user behavior faster than rebuilding containers.

Developer targets are local-only state. They do not change production app manifests, installed app records, legacy module records, or gateway exposure records.

Use this mode as the default feedback loop for Host-facing app behavior. Do not replace it with hand-written identity tokens: seed Hosty users and assignments, then access the app through Hosty so the normal gateway and app embed paths mint `X-Docker-Host-Identity`.

## Fast Repo Loop

For this repository's demo app:

```bash
npm run host:dev:demo
```

This wraps `hosty dev up --manifest modules/demo-module/metadata.dev.json`. It starts Hosty at `http://localhost:3000`, the demo app at `http://localhost:3100`, seeds development users through Hosty control, and links a developer target visible through Hosty Shell.

It also enables development auto-login and browser account seeding. The default accounts are:

- `admin@docker-host.local` with password `docker-host-dev-admin`;
- `user@docker-host.local` with password `docker-host-dev-user`.

`metadata.dev.json` can add app-specific local users under `development.users`. The CLI reads this CLI-only block, creates or updates those Hosty users, assigns them to the developer target by default, and strips the block before serving metadata to the Host validator. Supported roles are `admin`, `user`, `host.admin`, `host.user`, `host-admin`, and `host-user`.

Use the account switcher to validate assigned-user behavior. Do not edit identity headers by hand for this path.

## Installed CLI Harness

The generic installed-CLI harness is `hosty dev`. The deprecated `docker-host dev` alias remains compatible during migration.

The harness reads a local `metadata.dev.json` file and can:

- run the app's local process service;
- start a local Hosty process from configured `HOST_DEV_REPOSITORY_PATH` or connect to an already running loopback Host origin with `--host-url`;
- use `<HOST_DATA_ROOT_HOST>/run/control.json` for trusted local control;
- seed development users, assignments, and directory policy through Hosty-owned control routes;
- revoke conflicting pending invitations before creating missing development users;
- link or update the developer target;
- create persistent dev data under `<HOST_DATA_ROOT_HOST>/dev/modules/<app-id>/`;
- print the Hosty Shell app URL;
- report Host readiness, target reachability, app registry visibility, and identity mode;
- issue a real Hosty-signed development identity token for direct app-origin endpoint probes;
- reset only harness-owned developer state;
- clean persistent dev data explicitly.

The harness does not require a Hosty user session, a CLI admin token, or `DOCKER_HOST_CLI_TOKEN`.

Example `metadata.dev.json`:

```json
{
  "schemaVersion": "0.3",
  "id": "com.example.app",
  "name": "Example App",
  "version": "1.0.0",
  "development": {
    "users": [
      {
        "email": "reviewer@example.test",
        "displayName": "Review User",
        "role": "user"
      }
    ]
  },
  "services": [
    {
      "key": "app",
      "source": {
        "type": "process",
        "command": "npm run dev",
        "workingDirectory": ".",
        "environment": {
          "PORT": "3100"
        }
      },
      "runtime": {
        "ports": [
          {
            "key": "http",
            "containerPort": 3000,
            "localPort": 3100,
            "protocol": "http"
          }
        ]
      },
      "healthCheck": {
        "type": "http",
        "path": "/api/health",
        "successStatus": [200]
      }
    }
  ],
  "endpoints": [
    {
      "key": "http",
      "service": "app",
      "port": "http",
      "public": true
    }
  ],
  "ui": {
    "entrypoint": {
      "portKey": "http",
      "path": "/"
    }
  }
}
```

Run the harness:

```bash
hosty dev up
hosty dev up --prepare-only
hosty dev status
hosty dev identity --format token
hosty dev reset
hosty dev clean metadata.dev.json
hosty dev up --manifest modules/demo-module/metadata.dev.json
hosty dev up --manifest path/to/metadata.dev.json --host-url http://localhost:3000
```

Use `--host-url` when Hosty is already running locally in another terminal or debugger. The URL must be loopback, such as `http://localhost:3000` or `http://127.0.0.1:3000`, because the top-level dev harness serves metadata and process targets through the developer machine loopback interface. Without `--host-url`, configure `HOST_DEV_REPOSITORY_PATH` first; the top-level dev harness does not start or inspect the production Host container.

After `dev up` prepares the target, use `hosty dev identity --format token` when a direct `curl` or test script needs an app identity JWT:

```bash
TOKEN="$(hosty dev identity --manifest path/to/metadata.dev.json --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

Use `--user user@docker-host.local` to issue the token for the normal development user. This helper still uses Hosty-owned users, assignments, access policy, and signing keys. It is not a substitute for validating gateway routing or Shell iframe identity through the Hosty URLs printed by `dev up`.

## Manual Developer Target

Run the app dev server, then link it:

```bash
hosty modules dev link \
  http://localhost:3000/fixtures/modules/demo-module \
  demo.localhost \
  http \
  http://127.0.0.1:3100
```

Optional flags:

```text
--policy public|loginRequired|assignedUsersOnly
--identity none|optional|required
--disabled
```

For assigned-user testing, make sure Hosty has development users and app assignments before using `--policy assignedUsersOnly`. The low-level `modules dev` target commands do not seed users or assignments; use `hosty dev up` when dev metadata is available, use the repository demo script for the host-side demo loop, or configure users through the Hosty UI/API for external apps.

## Rules

- Mutating developer target control routes require local control discovery and the per-start control secret.
- Target URLs must use HTTP and point to localhost, `*.localhost`, `host.docker.internal`, loopback, or private IP ranges.
- Public target URLs are rejected.
- The selected endpoint key must exist and be marked `public: true` in metadata.
- When `ui.entrypoint` metadata is valid, the target appears in `/api/apps` as a developer app.
- Developer app ids use `dev:{targetId}`.
- Disabled targets are hidden from `/api/apps`.
- Developer targets are checked before production gateway exposures.
- Developer mode does not install app containers, create production app storage, prove Dockerfile behavior, or create production gateway exposure/external ingress records.

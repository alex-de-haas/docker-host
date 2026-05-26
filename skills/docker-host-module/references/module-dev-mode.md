# Module Developer Mode Reference

Use this reference when validating a local module app through Docker Host without a full module install.

## Purpose

Module developer mode lets module authors run a local development server behind the Docker Host gateway. It validates Host shell discovery, gateway access policy, identity token injection, header stripping, route rewriting, iframe embedding, WebSockets, SSE, and module-scoped user behavior faster than rebuilding containers.

Developer targets are local-only state. They do not change production module metadata, installed module records, or gateway exposure records.

Use this mode as the default feedback loop for Host-facing module behavior. Do not replace it with hand-written module identity tokens: seed Host users and assignments, then access the module through Docker Host so the normal gateway and app embed paths mint `X-Docker-Host-Identity`.

## Fast Repo Loop

For this repository's demo module:

```bash
npm run host:dev:demo
```

This uses the local CLI project to run `docker-host dev up --manifest modules/demo-module/metadata.dev.json`. It starts Docker Host at `http://localhost:3000`, the demo module at `http://localhost:3100`, seeds development users through Host control, and links a developer target visible through the Host Apps shell.

It also enables development auto-login and browser account seeding. The default accounts are:

- `admin@docker-host.local` with password `docker-host-dev-admin`;
- `user@docker-host.local` with password `docker-host-dev-user`.

Use the account switcher to validate assigned-user behavior. Do not edit module identity headers by hand for this path.

## Installed CLI Harness

The generic installed-CLI harness is `docker-host dev`. It reads a module-local `metadata.dev.json` file and can:

- run the module's local process service;
- start a local Host process from configured `HOST_DEV_REPOSITORY_PATH` or connect to an already running loopback Host origin with `--host-url`;
- use `<HOST_DATA_ROOT_HOST>/run/control.json` for trusted local control;
- seed development users, assignments, and module directory policy through Host-owned control routes;
- revoke conflicting pending invitations before creating missing development users;
- link or update the developer target;
- create persistent dev data under `<HOST_DATA_ROOT_HOST>/dev/modules/<module-id>/`;
- print the Host shell app URL;
- report Host readiness, target reachability, app registry visibility, and identity mode;
- reset only harness-owned developer state;
- clean persistent dev data explicitly.

The harness does not require a Host user session, a CLI admin token, or `DOCKER_HOST_CLI_TOKEN`.

Example `metadata.dev.json`:

```json
{
  "schemaVersion": "0.3",
  "id": "com.example.module",
  "name": "Example Module",
  "version": "1.0.0",
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
  ]
}
```

Run the harness:

```bash
docker-host dev up
docker-host dev up --prepare-only
docker-host dev status
docker-host dev reset
docker-host dev clean metadata.dev.json
docker-host dev up --manifest modules/demo-module/metadata.dev.json
docker-host dev up --manifest path/to/metadata.dev.json --host-url http://localhost:3000
```

Use `--host-url` when the Host is already running locally in another terminal or debugger. The URL must be loopback, such as `http://localhost:3000` or `http://127.0.0.1:3000`, because the top-level dev harness serves metadata and module process targets through the developer machine loopback interface. Without `--host-url`, configure `HOST_DEV_REPOSITORY_PATH` first; the top-level dev harness does not start or inspect the production Host container.

## Manual Developer Target

Run the module dev server, then link it:

```bash
docker-host modules dev link \
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

For assigned-user testing, make sure the Host has development users and module assignments before using `--policy assignedUsersOnly`. The low-level `modules dev` target commands do not seed users or assignments; use `docker-host dev up` when dev metadata is available, use the repository demo script for the host-side demo loop, or configure users through the Host UI/API for external modules.

## Rules

- Mutating developer target control routes require local control discovery and the per-start control secret.
- Target URLs must use HTTP and point to localhost, `*.localhost`, `host.docker.internal`, loopback, or private IP ranges.
- Public target URLs are rejected.
- The selected endpoint key must exist and be marked `public: true` in metadata.
- When `ui.entrypoint` metadata is valid, the target appears in `/api/apps` as a developer app.
- Developer app ids use `dev:{targetId}`.
- Disabled targets are hidden from `/api/apps`.
- Developer targets are checked before production gateway exposures.
- Developer mode does not install module containers, create production module storage, prove Dockerfile behavior, or create production gateway exposure/external ingress records.

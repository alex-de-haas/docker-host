# Module Developer Mode Reference

Use this reference when validating a local module app through Docker Host without a full module install.

## Purpose

Module developer mode lets module authors run a local development server behind the Docker Host gateway. It validates Host shell discovery, gateway access policy, identity token injection, header stripping, route rewriting, iframe embedding, WebSockets, SSE, and module-scoped user behavior faster than rebuilding containers.

Developer mode is local-only state. It does not change production module metadata, installed module records, or gateway exposure records.

Use this mode as the default feedback loop for Host-facing module behavior. Do not replace it with hand-written module identity tokens: seed Host users and assignments, then access the module through Docker Host so the normal gateway and app embed paths mint `X-Docker-Host-Identity`.

## Modes

Standalone mode:

```text
module dev server -> http://localhost:3100
auth -> module-owned mocks or local test token
```

Integrated mode:

```text
module.localhost -> Docker Host Gateway -> http://127.0.0.1:3100
auth -> real Host principal and module-scoped JWT
```

Use integrated mode when testing Host sessions, shell app embedding, access assignments, `X-Docker-Host-Identity`, trusted header stripping, redirects, WebSockets, SSE, or module directory access.

Production-like image mode:

```text
Docker Host install flow -> local module image -> managed container
auth -> real Host principal and module-scoped JWT
```

Use production-like image mode when testing Dockerfile behavior, storage mounts, module install/update plans, lifecycle actions, runtime resources, dependency networking, or container-only bugs. It is intentionally slower than developer targets.

## Fast Repo Loop

For this repository's demo module:

```bash
npm run host:dev:demo
```

This starts Docker Host at `http://localhost:3000`, the demo module at `http://localhost:3100`, enables module developer mode, and seeds a developer target visible through the Host Apps shell.

It also enables development auto-login and browser account seeding. The default accounts are:

- `admin@docker-host.local` with password `docker-host-dev-admin`;
- `user@docker-host.local` with password `docker-host-dev-user`.

Use the account switcher to validate assigned-user behavior. Do not edit module identity headers by hand for this path.

## Manual Developer Target

Enable developer mode:

```bash
docker-host config set HOST_MODULE_DEV_MODE enabled
docker-host restart
```

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

For assigned-user testing, make sure the Host has development users and module assignments before using `--policy assignedUsersOnly`. The low-level `modules dev` target commands do not seed users or assignments; use `docker-host dev up --manifest <path>` when a manifest is available, use the repository demo script for the host-side demo loop, or configure users through the Host UI/API for external modules.

## Installed CLI Harness

The generic installed-CLI harness is `docker-host dev`. It reads a module-local `.docker-host/dev.json` manifest and can:

- run the module's local dev command;
- ensure Docker Host developer mode is enabled for Docker-container and local-process Host runs;
- start the configured Host container, start a local Host process, or connect to an already running Host API origin;
- seed development users, assignments, and module directory policy through Host-owned APIs;
- revoke conflicting pending invitations before creating missing development users;
- link or update the developer target;
- print the Host shell app URL;
- report Host readiness, target reachability, app registry visibility, and identity mode;
- reset only harness-owned developer state.

Do not invent a parallel token or mock-auth mechanism when the harness or low-level developer target APIs can exercise the real Host gateway.

The harness is a Host API-backed workflow. The Host must already be set up, and the local CLI must have a Host admin token from `docker-host auth token import` or `DOCKER_HOST_CLI_TOKEN`. The harness calls Host-owned APIs; it does not write auth state, assignments, directory policy, or developer target JSON directly.

Example `.docker-host/dev.json`:

```json
{
  "metadataFile": "../metadata.json",
  "moduleCommand": "npm run dev",
  "workingDirectory": "..",
  "target": {
    "id": "mdev_local_demo_module",
    "hostname": "demo.localhost",
    "portKey": "http",
    "localPort": 3100,
    "policy": "assignedUsersOnly",
    "identity": "required"
  },
  "users": [
    {
      "email": "admin@docker-host.local",
      "displayName": "Development Admin",
      "role": "host.admin"
    },
    {
      "email": "user@docker-host.local",
      "displayName": "Development User",
      "role": "host.user",
      "assigned": true
    }
  ],
  "directoryPolicy": {
    "includeEmail": true
  },
  "environment": {
    "PORT": "3100",
    "DEMO_PUBLIC_URL": "http://localhost:3100"
  }
}
```

Manifest notes:

- `host.mode` is optional and defaults to `docker-container`. It also supports `local-process` and `external`.
- `host.origin` is the Host API origin, for example `http://localhost:3000`. `host.port` is shorthand for `http://localhost:<port>`.
- `host.command`, `host.workingDirectory`, and `host.environment` are used only by `local-process` mode. The CLI injects `HOST_MODULE_DEV_MODE=enabled`, `HOST_INTERNAL_ORIGIN`, and a matching `PORT` when needed.
- Use `metadataFile` for repo-local metadata, or `metadataUrl` when the metadata is already served from an absolute URL.
- `metadataFileHost` defaults to `host.docker.internal` for Docker-container Host runs and `127.0.0.1` for local/external Host runs.
- `moduleCommand` is required unless `docker-host dev up` is run with `--prepare-only`.
- `target.id` is optional; when omitted, the CLI derives `mdev_{sanitized-hostname}` from `target.hostname`.
- `target.portKey` must match a public endpoint key in module metadata.
- `target.targetBaseUrl` is the explicit URL the Host process proxies to; Docker-container mode on Docker Desktop usually needs `host.docker.internal`, while direct host probes may rewrite that to loopback.
- `target.localPort` is a shorthand for a module dev server on the developer machine. It expands to `http://host.docker.internal:<port>` for `docker-container` mode and `http://127.0.0.1:<port>` for `local-process` or `external` mode.
- `target.policy` supports `public`, `loginRequired`, and `assignedUsersOnly`.
- `target.identity` supports `none`, `optional`, and `required`.
- Existing active users are reused and updated; pending invitations with the same email are revoked before the CLI creates a fresh invitation.
- `users[].assigned` adds the manifest module id to that user's assignments when true and removes it when false or omitted.
- `users[].password` is optional. Defaults are `docker-host-dev-admin` for `host.admin` and `docker-host-dev-user` for `host.user`.
- `directoryPolicy.includeEmail` controls whether scoped module directory responses include email addresses.
- `environment` is merged into the local module process. The CLI also injects `DOCKER_HOST_INTERNAL_ORIGIN`, `DOCKER_HOST_MODULE_ID`, `MODULE_ID`, and `MODULE_VERSION`.

Run the harness:

```bash
docker-host dev up --manifest .docker-host/dev.json
docker-host dev up --manifest .docker-host/dev.json --prepare-only
docker-host dev status --manifest .docker-host/dev.json
docker-host dev reset --manifest .docker-host/dev.json
docker-host dev up --manifest .docker-host/dev.json --host-url http://localhost:3000
```

Use `--host-url` when the Host is already running locally in another terminal or debugger. It skips Docker container lifecycle and connects directly to that Host API origin.

Host mode examples:

```json
{
  "host": {
    "mode": "local-process",
    "origin": "http://localhost:3000",
    "command": "npm run host:dev",
    "workingDirectory": "../../.."
  }
}
```

```json
{
  "host": {
    "mode": "external",
    "origin": "http://localhost:3000"
  }
}
```

## Rules

- Mutating developer target APIs require `host.admin`.
- Developer mode must be enabled with `HOST_MODULE_DEV_MODE=enabled`.
- Target URLs must use HTTP and point to localhost, `*.localhost`, `host.docker.internal`, loopback, or private IP ranges.
- Public target URLs are rejected.
- The selected endpoint key must exist and be marked `public: true` in metadata.
- When `ui.entrypoint` metadata is valid, the target appears in `/api/apps` as a developer app.
- Developer app ids use `dev:{targetId}`.
- Disabled targets and all targets under disabled developer mode are hidden from `/api/apps`.
- Developer targets are checked before production gateway exposures while developer mode is enabled.
- Developer mode does not install module containers, create module storage, prove Dockerfile behavior, or create production gateway exposure/external ingress records.

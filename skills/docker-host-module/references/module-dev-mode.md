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

For assigned-user testing, make sure the Host has development users and module assignments before using `--policy assignedUsersOnly`. The current low-level CLI target commands do not seed users or assignments; use the repository demo script for the demo module, or configure users through the Host UI/API for external modules.

## Future Harness

A generic installed-CLI harness is planned in the Docker Host repository documentation. The target shape is a manifest-driven workflow that can:

- run the module's local dev command;
- ensure Docker Host developer mode is enabled;
- seed development users, assignments, and module directory policy through Host-owned APIs;
- link or update the developer target;
- print the Host shell app URL;
- reset only harness-owned developer state.

Until that exists, agents should compose the current primitives instead of inventing a parallel token or mock-auth mechanism.

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

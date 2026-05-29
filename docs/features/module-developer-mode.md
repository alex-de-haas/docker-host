# Module Developer Mode

Module developer mode lets module authors test a local development server through the Docker Host gateway without running the full install flow for every code change.

It is local-only operational state. It does not change production module metadata, installed module records, or production gateway exposure records.

## Modes

Standalone mode remains owned by the module:

```text
module dev server -> http://localhost:3100
auth -> module-owned mock user or local test token
```

Integrated mode is owned by Docker Host:

```text
demo.localhost -> Docker Host Gateway -> http://127.0.0.1:3100
auth -> real Host principal and module-scoped JWT
```

Integrated mode is intended for testing gateway behavior that standalone mode cannot prove: exposure policy, Host sessions, trusted proxy principals, module-scoped identity tokens, header stripping, redirects, WebSockets, SSE, Host-owned access assignment, and direct-origin shell identity bridging.

## Recommended Workflow

Use three development loops with clear ownership:

- Standalone module development is for module-owned UI, business logic, and local mocks.
- Integrated developer target development is the default loop for shell apps, authenticated module pages, scoped user directory access, redirects, WebSockets, SSE, and Host identity propagation.
- Production-like local image testing is for Dockerfile changes, storage mounts, install/update plans, lifecycle actions, runtime resources, and container networking.

Do not inject fake module identity tokens into requests when validating Host integration. Seed Host development users and module assignments instead, then reach the module through the Host gateway or app shell so the module receives the same signed identity contract it receives in production-like runs.

The generic installed-CLI harness for this workflow is documented in [Module Development Harness](module-development-harness.md). Use `docker-host dev up` for reusable `metadata.dev.json` local module development, `npm run host:dev:demo` for the repository's host-side demo loop, or the lower-level `docker-host modules dev link` commands when only target registration is needed.

For Host development, the harness can connect to a local Host process instead of the installed Host container. Use a loopback URL such as `--host-url http://localhost:3000` when the Host is already running in a debugger or another terminal.

## Decisions

- Developer targets are stored in `/data/dev/module-targets.json`.
- Developer target mutation is available only through local trusted control.
- Browser and remote HTTP APIs cannot mutate developer targets unless explicitly wired through authenticated admin routes.
- Developer target visibility no longer requires `HOST_MODULE_DEV_MODE`; enabled targets are local-only records and can appear in `/api/apps`.
- The Host validates metadata before storing a target and does not create containers or storage mappings.
- Target URLs must be absolute HTTP URLs and are limited to localhost, `*.localhost`, `host.docker.internal`, loopback, and private IP ranges.
- The gateway checks enabled developer targets before production gateway exposures.
- Integrated mode uses the normal Host-signed `X-Docker-Host-Identity` token.

## Control API

Developer target control routes are local machine-control routes:

- `GET /control/v1/modules/dev/targets` lists developer targets.
- `PUT /control/v1/modules/dev/targets/{targetId}` replaces a developer target.
- `POST /control/v1/modules/dev/targets/{targetId}/identity-token` issues a Host-signed identity token for a local development user.
- `DELETE /control/v1/modules/dev/targets/{targetId}` removes a developer target.
- `DELETE /control/v1/modules/dev/data/{moduleId}` removes stored development data for one module.

Create/update input:

```json
{
  "metadataUrl": "http://127.0.0.1:51234/metadata.dev.json",
  "hostname": "demo.localhost",
  "portKey": "http",
  "targetBaseUrl": "http://127.0.0.1:3100",
  "exposurePolicy": "assignedUsersOnly",
  "identityMode": "required",
  "enabled": true
}
```

The Host downloads and validates the metadata graph, resolves the root module id, checks that `portKey` exists and is marked `public: true`, and stores the normalized target.

When the selected `portKey` matches valid module `ui.entrypoint` metadata, the Host also stores a shell app snapshot on the developer target:

- display name and description from module metadata;
- optional shell icon from `ui.icon`;
- entrypoint path from `ui.entrypoint.path`;
- nested navigation from `ui.navigation`.

This snapshot keeps `/api/apps` fast and deterministic. Module authors should re-run `docker-host dev up` or relink a developer target when UI metadata changes.

Identity-token input:

```json
{
  "userEmail": "user@docker-host.local"
}
```

The request may use `userEmail` or `userId`. The Host looks up an enabled local user, checks the developer target exposure policy and module assignments, and signs the same module identity JWT used by the shell and gateway paths. It does not issue a token when the target identity mode is `none` or when the selected user cannot access the target.

## Apps Portal

Enabled developer targets with shell app snapshots appear in the authenticated Apps portal alongside installed module apps.

Developer app behavior:

- `/api/apps` returns developer entries with `source: "developer"` and `developerTargetId`;
- app ids use `dev:{targetId}` to avoid collisions with installed module ids;
- shell pages use `/apps/dev/{targetId}`;
- iframe transport uses the direct origin derived from `targetBaseUrl`;
- identity tokens are issued by `/api/apps/dev/{targetId}/identity-token` and delivered through the Host shell `postMessage` bridge;
- the Apps sidebar, Apps portal, and app topbar show a compact `Dev` badge;
- disabled targets are hidden from `/api/apps`.

Developer app visibility reuses the target exposure policy after Host authentication:

- `public` and `loginRequired` targets are visible to authenticated Host users;
- `assignedUsersOnly` targets use existing module access assignments;
- anonymous shell App discovery is not supported.

Developer app entries remain local-only portal state. They do not create production gateway exposure records or external ingress readiness state.

## CLI

Manage targets directly:

```bash
docker-host modules dev list
docker-host modules dev link http://localhost:3000/fixtures/modules/demo-module demo.localhost http http://127.0.0.1:3100
docker-host modules dev unlink <target-id>
```

`modules dev link` also accepts:

```text
--policy public|loginRequired|assignedUsersOnly
--identity none|optional|required
--disabled
```

The `modules dev` commands intentionally manage developer targets only. User seeding, assignment seeding, local module process startup, status checks, reset behavior, and dev data cleanup live in the top-level `docker-host dev` harness.

The top-level harness uses `metadata.dev.json` directly. The repository demo metadata provides the local process command, working directory, environment, local port, endpoint selection, and shell UI metadata; the CLI derives the developer target and seeds standard development users from that metadata-driven workflow:

```bash
docker-host dev up --manifest modules/demo-module/metadata.dev.json
docker-host dev status --manifest modules/demo-module/metadata.dev.json
docker-host dev identity --manifest modules/demo-module/metadata.dev.json --format token
docker-host dev reset --manifest modules/demo-module/metadata.dev.json
docker-host dev clean modules/demo-module/metadata.dev.json
```

`--host-url` makes the command connect to that already running loopback development Host origin instead of starting `npm run host:dev` from `HOST_DEV_REPOSITORY_PATH`:

```bash
docker-host dev up --manifest modules/demo-module/metadata.dev.json --host-url http://localhost:3000
```

Use `docker-host dev identity` only for direct module-origin probes, for example checking `/api/auth/identity` on a local Next.js server with a real Host-signed JWT. It is not a substitute for validating shell iframe transport or gateway routing through Docker Host.

## Gateway Rules

When a hostname matches an enabled developer target:

- Host applies the target's exposure policy;
- Host authenticates through trusted proxy assertion or browser session using the existing rules;
- Host mints the normal module identity JWT when identity mode requires or allows it;
- Host strips Host-owned and trusted proxy headers before forwarding;
- Host proxies HTTP and WebSocket traffic to the local target URL;
- Host preserves the external module hostname in `Host` and `X-Forwarded-Host`.

Stored disabled targets are inert.

## Security Boundaries

- Developer target mutation requires local control discovery and the per-start control secret.
- Target URLs must use `http` and point to localhost, `host.docker.internal`, loopback, or private IP ranges.
- Public target URLs are rejected.
- Developer targets are local state and should not be exported as production gateway exposure records.

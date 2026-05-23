# Module Implementation Checklist

Use this checklist before finishing a Docker Host module task.

## Metadata

- The module has `schemaVersion: "0.2"`.
- The module id is stable and reverse-DNS-like.
- Container keys, endpoint keys, setting keys, storage keys, and dependency ids are stable.
- Every endpoint references an existing container and port key.
- `endpoints[].public` is used only as a gateway capability hint.
- Settings declare concrete env targets and do not contain real secret defaults.
- Storage directories map only intended writable paths.
- External mount collections are used only for administrator-selected host folders.
- `ui.entrypoint.portKey` references a public endpoint key.
- `ui.entrypoint.path` and navigation paths are same-origin absolute paths.
- Metadata has no unsupported extension fields for schema `0.2`.

## Container Runtime

- The app listens on the declared container port.
- The Docker image can run without local development-only files.
- The Dockerfile builds a Linux container image.
- Health or readiness endpoints do not require Host browser cookies.
- Runtime config comes from metadata settings or Host-injected variables.
- Persistent state is under declared storage paths.

## Auth And Users

- The module does not receive or depend on Host session cookies.
- The module validates `X-Docker-Host-Identity` signature, issuer, audience, and expiration before trusting user claims.
- The module stores internal permissions by Host user id.
- The module uses scoped directory APIs for assignable users instead of assuming a full Host user list.
- Public anonymous gateway traffic is handled without requiring a user token unless the exposure opts into optional identity.

## Development Validation

- For metadata-only work, run targeted metadata/parser tests when available.
- For Host behavior changes, run `npm run host:test`.
- For module app changes, run that module's lint and build scripts.
- For shell app integration, identity, assigned-user behavior, scoped directory reads, redirects, WebSockets, or SSE, run `npm run host:dev:demo` or link a developer target.
- Integrated developer-target validation uses Host-seeded users and assignments; it does not rely on hand-written module identity tokens.
- For managed lifecycle behavior, build the module image locally and install metadata through Docker Host.

## Documentation

- Update `docs/features/module-metadata.md` if the metadata contract changes.
- Update `docs/features/auth-gateway.md` or `docs/features/user-management.md` if identity, roles, assignments, or gateway policy behavior changes.
- Update `docs/features/module-developer-mode.md` if developer target behavior changes.
- Link new feature docs from `docs/root.md`.

# Module Implementation Checklist

Use this checklist before finishing a Docker Host module task.

## Metadata

- The module has `schemaVersion: "0.2"`.
- The module id is stable and reverse-DNS-like.
- Container keys, endpoint keys, setting keys, storage keys, and dependency ids are stable.
- Every endpoint references an existing container and port key.
- `endpoints[].public` is used only as a gateway capability hint.
- Dependencies are required, use numeric major versions, and reference direct metadata URLs.
- Settings declare concrete env targets and do not contain real secret defaults.
- Storage directories map only intended writable paths.
- External mount collections are used only for administrator-selected host folders.
- External mount collection templates contain `{key}` as a path segment and stay below their declared prefix.
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
- The module treats `moduleAccess`, `moduleExposurePolicy`, `hostRole`, email, and name as signed claims, not standalone headers.
- The module stores internal permissions by Host user id.
- The module uses scoped directory APIs for assignable users instead of assuming a full Host user list.
- Public anonymous gateway traffic is handled without requiring a user token unless the exposure opts into optional identity.
- OIDC, trusted-proxy assertions, Host cookies, and CLI bearer tokens are never used directly as module identity.

## Gateway And Publishing

- Browser UI access is modeled with `ui` metadata and the Host shell, not as a public service/API hostname.
- Service/API subdomains use explicit gateway exposure policy and identity mode.
- External ingress readiness, DNS, TLS, tunnels, and reverse proxy setup are Host/operator concerns, not module metadata.

## Development Validation

- For metadata-only work, run targeted metadata/parser tests when available.
- For Host behavior changes, run `npm run host:test`.
- For module app changes, run that module's lint and build scripts.
- For shell app integration, identity, assigned-user behavior, scoped directory reads, redirects, WebSockets, or SSE, run `npm run host:dev:demo` or link a developer target.
- Integrated developer-target validation uses Host-seeded users and assignments; it does not rely on hand-written module identity tokens.
- For managed lifecycle behavior, build the module image locally and install metadata through Docker Host.
- `docker-host dev` is not a replacement for image install tests when Dockerfile, storage, lifecycle, or container networking changed.

## Documentation

- Update `docs/features/module-metadata.md` if the metadata contract changes.
- Update `docs/features/auth-gateway.md` or `docs/features/user-management.md` if identity, roles, assignments, or gateway policy behavior changes.
- Update `docs/features/module-developer-mode.md` if developer target behavior changes.
- Link new feature docs from `docs/root.md`.

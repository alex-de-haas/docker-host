# App Implementation Checklist

Use this checklist before finishing a Hosty runtime app task.

## Manifest

- New app-oriented work uses `schemaVersion: "app.0.1"` when possible.
- `app.0.1` manifests use app-level `runtimeProfiles[]` plus top-level `services[]`; image and command details live in `services[].runtimes.<profileKey>`.
- Legacy Docker compatibility work may use `schemaVersion: "0.2"` with `containers[]` or schema `0.3` with image-backed `services[]`.
- Local process launch uses an app manifest runtime profile with `type: "localCommand"`.
- The app id is stable and reverse-DNS-like.
- Runtime profile keys, service/container keys, endpoint keys, setting keys, storage keys, and dependency ids are stable.
- Every required service declares a runtime implementation for each supported runtime profile.
- `source` is present only when there is useful repository metadata; it is not required for image-only apps.
- Every endpoint references an existing service/container and port key.
- `endpoints[].public` is used only as a gateway capability hint.
- Dependencies are required, use numeric major versions, and reference direct `manifestUrl` or legacy `metadataUrl` values.
- Settings declare concrete env targets and do not contain real secret defaults.
- `data.enabled` is used when Hosty should manage and back up the primary app data directory.
- External mount collections are used only for administrator-selected host folders that Hosty should not back up or delete.
- `ui.entrypoint` references a public endpoint or a runtime port that can become one.
- `ui.entrypoint` and navigation paths are same-origin absolute paths.
- Metadata has no unsupported extension fields for the selected schema version.

## Runtime

- Docker service runtimes declare an installable Linux container image.
- Local command service runtimes declare a command and are launched by Core when the selected runtime profile is active.
- Each service listens on its declared container or local port.
- The Docker image can run without local development-only files.
- Health or readiness endpoints do not require Hosty browser cookies.
- Runtime config comes from manifest settings or Hosty-injected variables.
- Persistent app-owned state is under the primary data directory when it should be included in Hosty backups.

## Auth And Users

- The app does not receive or depend on Hosty session cookies.
- The app validates `X-Docker-Host-Identity` signature, issuer, audience, and expiration before trusting user claims.
- The app treats `moduleAccess`, `moduleExposurePolicy`, `hostRole`, email, and name as signed claims, not standalone headers.
- The app stores internal permissions by Hosty user id.
- The app uses scoped directory APIs for assignable users instead of assuming a full Hosty user list.
- Public anonymous gateway traffic is handled without requiring a user token unless the exposure opts into optional identity.
- OIDC, trusted-proxy assertions, Hosty cookies, and CLI bearer tokens are never used directly as app identity.
- App-owned third-party integration credentials are stored and authorized separately from Hosty user authentication.

## Gateway And Publishing

- Browser UI access is modeled with `ui` metadata and Hosty Shell unless the app intentionally supports a separate standalone origin.
- Service/API subdomains use explicit gateway exposure policy and identity mode.
- External ingress readiness, DNS, TLS, tunnels, and reverse proxy setup are Hosty/operator concerns, not manifest metadata.
- Gateway-protected mode is used only when the app is not Hosty-aware or needs an outer access gate.

## Data And Backups

- The app has one primary Hosty-managed data directory: `apps/<app-id>/data/` for new app-oriented installs.
- Docker service runtimes receive `HOSTY_APP_DATA_DIR` when the primary data mapping exists.
- App backups include only the primary data directory.
- External mounts and additional storage mappings are excluded from Hosty-managed backups.
- Update and restore behavior is reviewed when changing storage or data paths.

## Development Validation

- For manifest-only work, run targeted metadata/parser tests when available.
- For Hosty behavior changes, run `npm run core:test`.
- For app changes, run that app's lint/build/test scripts.
- For Shell integration, identity, assigned-user behavior, scoped directory reads, redirects, WebSockets, or SSE, install the manifest with a local runtime profile and run lifecycle through Core.
- Integrated validation uses existing Hosty users and assignments; it does not rely on hand-written identity tokens.
- For managed lifecycle behavior, build the app image locally and install the manifest through Hosty.
- Local command runtime profiles are not a replacement for image install tests when Dockerfile, storage, lifecycle, or container networking changed.

## Documentation

- Update `docs/features/hosty-runtime-app-platform.md` if Hosty app registry, system app, data, or backup behavior changes.
- Update `docs/features/module-metadata.md` if the manifest or legacy metadata contract changes.
- Update `docs/features/auth-gateway.md` or `docs/features/user-management.md` if identity, roles, assignments, or gateway policy behavior changes.
- Update `docs/features/local-development.md` if local runtime profile validation behavior changes.
- Link new feature docs from `docs/root.md`.

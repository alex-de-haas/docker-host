---
name: hosty-app-skill
description: Build, wrap, or update Hosty runtime apps. Use when creating app manifests under schemaVersion app.0.1, migrating legacy Docker Host modules, authoring legacy schemaVersion 0.2 or 0.3 metadata, configuring Docker or localCommand runtime profiles, app data directories and backups, Shell UI metadata, Hosty Core identity, scoped user directory access, runtime-app roles, dependencies, channels, or validating apps with Hosty developer mode.
---

# Hosty Runtime App

## Overview

Use this skill to implement Hosty runtime apps in the shape expected by this repository. The preferred contract is an app manifest with `schemaVersion: "app.0.1"`. Legacy Docker module metadata with `schemaVersion: "0.2"` or `"0.3"` remains supported through compatibility adapters.

Hosty is the target product model: a headless Core API, a replaceable Shell client, system apps such as Hosty Shell, and user-installed runtime apps. Docker is the first runtime adapter, not the whole product boundary.

## First Pass

1. Identify whether the user wants to create a new runtime app, wrap an existing app, update an app manifest, migrate legacy module metadata, add Hosty identity/roles, configure data/backups, or validate an app.
2. Treat `docs/features/hosty-runtime-app-platform.md`, `docs/features/module-metadata.md`, `docs/features/domain-model.md`, `docs/features/auth-gateway.md`, `docs/features/cli-trusted-control-and-dev-metadata.md`, `apps/host/src/lib/app-manifest.ts`, `apps/host/src/lib/module-metadata.ts`, and `modules/demo-module` as source of truth when implementation details matter.
3. Prefer `hosty` commands and Hosty terminology. Use `docker-host` only as a deprecated compatibility alias or when referring to legacy behavior already implemented under that name.
4. Keep Hosty Core access decisions separate from app-owned domain authorization. Hosty decides whether a Hosty user can reach the app; the app owns its internal roles and permissions.
5. For Host-facing behavior, validate through the integrated developer target loop before rebuilding images. Seed Hosty users and assignments, then let Hosty issue the normal signed app identity token.
6. Validate with the narrowest useful checks for the change, and update repository docs in English when the app contract or user-visible workflow changes.

## Reference Map

- Read `references/app-manifest.md` when authoring or reviewing `manifest.json`, legacy `metadata.json`, runtime profiles, settings, storage, dependencies, endpoints, install/update behavior, or backups.
- Read `references/app-auth-and-users.md` when working with Shell embedding, standalone app auth, gateway protection, `X-Docker-Host-Identity`, scoped user directory APIs, app-owned roles, external providers, or third-party integration credentials.
- Read `references/app-dev-mode.md` when linking a local app dev server through Hosty or authoring `metadata.dev.json`.
- Read `references/demo-app-patterns.md` when copying repo-local examples from `modules/demo-module`.
- Read `references/app-implementation-checklist.md` before finishing an app implementation or review.

## Workflows

### Author A New Runtime App

1. Choose a stable reverse-DNS app id, display name, version, and whether the app is user-facing, service-only, or both.
2. Prefer an `app.0.1` manifest. Start from `assets/app-template/manifest.json`, then replace ids, image references, ports, settings, storage, UI, and dependencies.
3. Declare one or more runtime profiles. Docker profiles are installable today. `localCommand` profiles are parsed and normalized for future runtime switching and are useful for development planning, but production local-command supervision is still planned.
4. Treat `source` as optional Git metadata. Some apps, such as Redis-like service dependencies, may have only a Docker image and no source repository.
5. Use `data.enabled: true` when the app needs a primary Hosty-managed data directory. Hosty backs up only that primary `data/` directory, not external mounts or additional storage.
6. Add `ui` only when the app should appear in Hosty Shell. Service-only apps can omit UI and still be managed as runtime apps or dependencies.

### Wrap An Existing Docker App

1. Locate the image reference or Docker build context, runtime port, health endpoint, configuration environment variables, writable paths, and any external host folders.
2. Prefer an `app.0.1` manifest with a Docker runtime profile. Legacy `0.2` or `0.3` module metadata is acceptable when updating an existing legacy module.
3. Map administrator-provided settings to environment variables. Never place real secret defaults in a manifest.
4. Use the primary data directory for app-owned persistent state. Use external mount collections only for administrator-selected external folders that Hosty must not back up or delete.
5. Add Shell UI metadata only for browser UI access through Hosty Shell. Dedicated service/API hostnames are gateway exposures, not Shell discovery.

### Integrate Hosty Identity

1. The app must not trust Hosty browser cookies, unsigned identity headers, or forwarded proxy headers.
2. When identity propagation is enabled, validate the signed `X-Docker-Host-Identity` token against Hosty Core JWKS, issuer, audience, and expiration.
3. Store app-owned permissions by stable Hosty user id from token `sub` or the scoped directory API.
4. Keep app-owned third-party integration credentials, such as Azure DevOps PATs, OAuth grants, and API keys, separate from Hosty user authentication.
5. Use gateway-protected mode only when the app is not Hosty-aware or needs an outer access gate. Hosty-aware standalone apps should use app-scoped identity from Core instead of relying on a full request proxy.

### Validate Host Integration

1. Choose the fastest loop that proves the behavior:
   - standalone app dev for app-owned UI and business logic;
   - integrated developer target for Shell embedding, gateway policy, Hosty sessions, identity, scoped directory access, redirects, WebSockets, and SSE;
   - production-like local image install for Dockerfile, storage, lifecycle, install/update, and container runtime behavior.
2. Use `hosty dev up --manifest <path-to-metadata.dev.json>` for metadata-driven local orchestration. It starts or connects to a loopback Hosty Core, seeds development users and assignments, links the developer target, and starts local app commands.
3. For this repository's demo loop, use `npm run host:dev:demo`.
4. For direct app-origin endpoint probes after the target is prepared, use `hosty dev identity --manifest <path-to-metadata.dev.json> --format token` and pass the token as `X-Docker-Host-Identity`. This is a diagnostic helper, not a replacement for Shell or gateway testing.
5. Do not hand-inject fake identity tokens or validate Hosty identity by running the app only in standalone mode.

### Update An Existing Runtime App

1. Preserve the app id unless intentionally creating a different app.
2. Treat runtime profile keys, endpoint keys, setting keys, storage keys, dependency ids, and data directory semantics as stable contracts.
3. Remember that update refreshes the manifest or metadata URL first. It is not only a Docker image pull.
4. Review install/update plan impact: images, runtime profile selection, settings schema, primary data directory, storage mappings, dependencies, endpoints, resources, UI metadata, and backups.
5. Hosty creates pre-update backups for the primary app data directory when it exists. External mounts are excluded by design.

## Validation

Use focused validation based on what changed:

- App manifest or metadata parser behavior: run targeted Host tests, commonly `npm run host:test`.
- App code changes: run the app's lint/build/test commands.
- Demo app changes: run `npm run demo-module:lint` and `npm run demo-module:build`.
- Shell app, embedded transport, identity behavior, or scoped directory behavior: use `npm run host:dev:demo` or a linked developer target.
- Production-like container behavior: build the Host image and app image locally, then install the manifest through Hosty.

Do not claim app security or identity work is complete without checking Hosty-issued token validation, cookie/header stripping assumptions, and audience validation.

## Documentation

When implementation changes runtime app behavior, update repository docs in English. Use `docs/features/{feature-name}.md` for feature documentation and link it from `docs/root.md`. Keep planning docs only for not-yet-implemented plans.

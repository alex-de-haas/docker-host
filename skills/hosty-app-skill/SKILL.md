---
name: hosty-app-skill
description: Build, wrap, or update Hosty runtime apps. Use when creating app manifests under schemaVersion app.0.1, publishing app-feeds.0.1 feeds, configuring Docker or localCommand runtime profiles, app data directories and backups, external host-path mounts (externalMounts / catalog roots), Shell UI metadata, Hosty Core identity, scoped app directory access, runtime-app roles, dependencies, OpenTelemetry/telemetry export (telemetry block + OTEL_* env), or validating apps with Core-managed local runtime profiles.
---

# Hosty App Skill

Use this skill to implement Hosty runtime apps in the shape expected by this repository. The supported contract is an app manifest with `schemaVersion: "app.0.1"`.

## Workflow

1. Identify whether the user wants to create a new runtime app, wrap an existing app, update an app manifest, add Hosty identity/roles, configure data/backups, or validate an app.
2. Treat `docs/features/hosty-runtime-app-platform.md`, `docs/features/runtime-app-manifest.md`, `docs/features/domain-model.md`, `docs/features/auth-gateway.md`, `apps/core/src/Haas.Hosty.Core/RuntimeAppManifest.cs`, `apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs`, and `apps/demo-app` as source of truth when implementation details matter.
3. Use `apps/demo-app/manifest.json` as the manifest shape and `hosty apps install apps/demo-app --runtime dev` as the local directory install pattern.

## References

- Read `references/app-manifest.md` when authoring or reviewing `manifest.json`, runtime profiles, service implementations, settings, storage, dependencies, endpoints, install/update behavior, or backups.
- Read `references/app-auth-and-users.md` when adding app identity, app-owned roles, or scoped app directory access.
- Read `references/app-feeds.md` when publishing or reviewing repository-owned `feeds.json` for Marketplace discovery and Core-managed updates.
- Read `references/demo-app-patterns.md` when validating against the repository Demo App.
- Read `references/app-implementation-checklist.md` before final verification.

## Local Validation

Use Core-managed runtime app lifecycle:

```bash
hosty core start
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
```

For direct endpoint probes:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

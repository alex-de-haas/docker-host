---
name: docker-host-module
description: Build, wrap, or update Docker Host modules. Use when creating modules under modules/*, turning an existing app into a Docker Host module, authoring schemaVersion 0.2 or 0.3 metadata JSON, adding shell app UI metadata, settings, storage, dependencies, Host gateway identity, scoped user directory access, module-owned roles, or validating modules with Docker Host developer mode.
---

# Docker Host Module

## Overview

Use this skill to implement Docker Host modules in the shape expected by this repository. A module is a Docker-hosted functional unit described by a direct JSON metadata URL, optionally surfaced as an authenticated Host shell app, and optionally integrated with Host identity, module assignments, and module-owned permissions.

## First Pass

1. Identify whether the user wants to wrap an existing app, build a new module, update module metadata, add Host identity/roles, or validate a module.
2. In this repository, treat `docs/features/*.md`, `apps/host/src/lib/module-metadata.ts`, and `modules/demo-module` as source of truth. Use the bundled references here as a compact guide, then check repo source when implementation details matter.
3. Prefer existing module and Host patterns over inventing a new contract. The metadata schema is strict and unknown fields are rejected for supported schema versions.
4. Keep Host authorization and module authorization separate. Docker Host decides whether a Host user reaches the module; the module owns its internal roles and permissions.
5. For Host integration work, prefer the integrated developer target loop before rebuilding module images. Seed Host users and assignments, then let the Host gateway issue the normal signed module identity token.
6. Validate with the narrowest useful checks for the change, and include documentation updates when the module contract or user-visible workflow changes.

## Reference Map

- Read `references/module-metadata.md` when authoring or reviewing `metadata.json`, storage, settings, dependencies, endpoints, or install/update behavior.
- Read `references/module-auth-and-users.md` when working with gateway exposure, shell apps, Host roles, `X-Docker-Host-Identity`, scoped user directory APIs, module-owned roles, external providers, or external ingress readiness.
- Read `references/module-dev-mode.md` when linking a local module dev server through the Host gateway or authoring `metadata.dev.json`.
- Read `references/demo-module-patterns.md` when copying repo-local examples from `modules/demo-module`.
- Read `references/module-implementation-checklist.md` before finishing a module implementation or review.

## Workflows

### Wrap an Existing App

1. Locate the app's Docker build context, runtime port, health endpoint, configuration environment variables, writable paths, and any external host folders it needs.
2. Add or update a Dockerfile only if the app cannot already produce a runnable Linux container image.
3. Create `metadata.json` with `schemaVersion: "0.2"`, a stable reverse-DNS `id`, one or more containers, public endpoint hints only for endpoints safe for Host gateway routing, setting targets, and storage mappings.
4. Add `ui` metadata only when the app should appear inside the authenticated Host shell. Do not model browser UI access as a public service/API subdomain.
5. If the app needs the current Host user, validate the signed `X-Docker-Host-Identity` token against Host JWKS. Do not trust unsigned identity headers or Host cookies.
6. If the app needs a user list for internal role assignment, use the scoped module directory model and store module roles by stable Host user id.
7. Keep operator publishing details such as DNS, TLS, tunnels, reverse proxies, and external ingress readiness out of module metadata.

### Build a New Module

1. Prefer a small, conventional app with a clear health endpoint, explicit config env vars, and a Dockerfile.
2. In this repo, use `modules/demo-module` as the canonical local example. Keep module UI styling compatible with the Host shell when embedding browser screens.
3. If the new module is part of the monorepo, add its workspace entry and package scripts intentionally. Avoid changing existing demo-module behavior unless the user asked for shared pattern updates.
4. Start from `assets/module-template/metadata.json` for a minimal metadata skeleton, then replace ids, image references, settings, storage, UI, and navigation.

### Validate Host Integration

1. Choose the fastest loop that proves the behavior:
   - standalone module dev for module-owned UI and business logic;
   - integrated developer target for shell apps, gateway policy, Host sessions, identity, scoped directory access, redirects, WebSockets, and SSE;
   - production-like local image install for Dockerfile, storage, lifecycle, install/update, and container runtime behavior.
2. For manifest-driven local orchestration, use `docker-host dev up --manifest <path>`. It enables module developer mode, connects to the configured Host mode, seeds development accounts and assignments through Host-owned APIs, links the developer target, and starts the local module command.
3. For this repository's host-side demo loop, use `npm run host:dev:demo`. It wraps `docker-host dev up --manifest modules/demo-module/.docker-host/dev.json`, starts Host and the module locally, seeds development accounts, and registers the demo developer target.
4. When changing the Host itself, either set `HOST_DEV_REPOSITORY_PATH`/`HOST_DEV_PORT` in CLI config for `local-process` startup or pass `--host-url http://localhost:<port>` when the Host is already running in another terminal or debugger. The CLI should talk to that Host origin through trusted local control, not assume the Host is a Docker container.
5. Use `target.localPort` for module dev servers on the developer machine when possible. The CLI expands it to `host.docker.internal` for Docker-container Host runs and to `127.0.0.1` for local/external Host runs.
6. For low-level target-only work, run the module dev server locally, then link it with `docker-host modules dev link <metadata-url> <hostname> <port-key> <target-url>`.
7. Do not hand-inject fake `X-Docker-Host-Identity` tokens to claim Host integration is working. Use Host-owned development users and assignments so Docker Host signs the token and serves the scoped directory through its normal APIs.

### Update an Existing Module

1. Preserve the module `id` unless intentionally creating a different module. Docker Host treats one installed module instance per id.
2. Treat container keys, endpoint keys, storage keys, setting keys, and dependency ids as stable contracts. Changing them can affect updates and persisted state.
3. Remember that module update refreshes the metadata URL first; it is not only `docker pull` for an existing image tag.
4. Review install/update plan impact: containers/images, settings schema, storage mappings, dependencies, endpoints, runtime resources, and UI metadata.

## Validation

Use focused validation based on what changed:

- Metadata parser or lifecycle behavior: run targeted Host tests, commonly `npm run host:test`.
- Module app changes: run the module's lint/build commands, for example `npm run demo-module:lint` and `npm run demo-module:build` for the demo module.
- Shell app, embedded transport, identity behavior, or scoped directory behavior: use `npm run host:dev:demo` or a linked developer target for the fast integrated loop.
- Service/API gateway exposure or external ingress readiness: validate through the Host gateway and ingress UI/API, not by adding module metadata fields.
- Production-like container behavior: build the Host image and module image locally, then install metadata through Docker Host.

Do not claim module security or identity work is complete without checking Host-issued token validation, cookie/header stripping assumptions, and module audience validation.

## Documentation

When implementation changes module behavior, update repository docs in English. Use `docs/features/{feature-name}.md` for feature documentation and link it from `docs/root.md`. Keep planning docs only for not-yet-implemented plans.

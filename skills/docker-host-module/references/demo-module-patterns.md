# Demo Module Patterns

Use this reference when adapting or comparing against the repository-local demo module at `modules/demo-module`.

## What To Copy

- Metadata shape from `modules/demo-module/metadata.json`.
- Production image build pattern from `modules/demo-module/Dockerfile`.
- Health endpoint pattern from `modules/demo-module/src/app/api/health/route.ts`.
- Host identity validation pattern from `modules/demo-module/src/lib/host-auth.ts`.
- Scoped user directory lookup from the demo module identity and people routes.
- Module-owned role storage from `modules/demo-module/src/lib/module-roles.ts`.
- Embedded shell navigation from `ui.navigation` in metadata and Next.js pages under `src/app`.
- Host-compatible UI primitives from `modules/demo-module/src/components/ui`.

## What To Replace

- Module id, display name, description, version, image repository, image tag, settings, storage keys, and UI navigation.
- Demo-specific environment variables such as `DEMO_GREETING`.
- Demo diagnostics pages that expose implementation details not relevant to the real module.
- Demo role names unless the target module intentionally uses the same role model.
- Demo external mount collection if the target app does not need administrator-selected host folders.

## Recommended Module App Shape

- Provide `GET /api/health` for simple runtime and writable-storage checks.
- Keep configuration as environment variables declared in metadata settings.
- Keep persistent state under paths declared in metadata storage directories.
- Use root-relative links so Host shell embed routes can rewrite paths reliably.
- Keep long-lived realtime endpoints behind the service/API gateway, not only the shell embed route.
- Keep module UI compact and consistent with Host shell patterns when the UI is embedded.

## Useful Repo Commands

```bash
npm run demo-module:dev
npm run demo-module:lint
npm run demo-module:build
npm run host:dev:demo
npm run demo-module:docker:build:local
```

Use `npm run host:dev:demo` for shell app, Host identity, assigned-user, and scoped directory feedback. It wraps `docker-host dev up --manifest modules/demo-module/.docker-host/dev.json`, seeds the development administrator and user accounts, and links the demo module as a developer target, so the module receives normal Host-issued identity instead of a mock token.

The demo module's `metadata.dev.json` uses a schema `0.3` process service with `runtime.ports[].localPort`. The `.docker-host/dev.json` harness manifest references that clean metadata and adds repository-local commands, users, directory policy, and target defaults.

Use the local Docker image path when testing managed install, start, stop, restart, update, and storage behavior.

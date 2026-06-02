# Demo App Patterns

Use this reference when adapting or comparing against the repository-local demo app at `modules/demo-module`.

The physical folder still uses `modules/demo-module` because it exercises the legacy Docker module adapter. In Hosty vocabulary, it is a runtime app used as the compatibility fixture.

## What To Copy

- Legacy metadata shape from `modules/demo-module/metadata.json` when working on schema `0.3` multi-service compatibility.
- Development metadata shape from `modules/demo-module/metadata.dev.json` when using `hosty dev` with process services.
- Production image build pattern from `modules/demo-module/Dockerfile`.
- Health endpoint pattern from `modules/demo-module/src/app/api/health/route.ts`.
- Hosty identity validation pattern from `modules/demo-module/src/lib/host-auth.ts`.
- Scoped user directory lookup from the demo identity and people routes.
- App-owned role storage from `modules/demo-module/src/lib/module-roles.ts`.
- Embedded Shell navigation from `ui.navigation` in metadata and Next.js pages under `src/app`.
- Hosty-compatible UI primitives from `modules/demo-module/src/components/ui`.

## What To Replace

- App id, display name, description, version, image repository, image tag, settings, storage keys, and UI navigation.
- Demo-specific environment variables such as `DEMO_GREETING`.
- Demo diagnostics pages that expose implementation details not relevant to the real app.
- Demo role names unless the target app intentionally uses the same role model.
- Demo external mount collection if the target app does not need administrator-selected host folders.

## Recommended Runtime App Shape

- Provide `GET /api/health` for simple runtime and writable-storage checks.
- Keep configuration as environment variables declared in manifest or metadata settings.
- Keep primary persistent state under the Hosty-managed `data/` directory when the app needs backup/restore.
- Keep external mount data out of the primary app data directory when it should not be backed up by Hosty.
- Use root-relative links so Hosty Shell embed routes can rewrite paths reliably.
- Keep long-lived realtime endpoints behind the service/API gateway, not only the Shell embed route.
- Keep embedded UI compact and consistent with Hosty Shell patterns.

## Useful Repo Commands

```bash
npm run demo-module:dev
npm run demo-module:lint
npm run demo-module:build
npm run host:dev:demo
npm run demo-module:docker:build:local
```

Use `npm run host:dev:demo` for Shell app, Hosty identity, assigned-user, and scoped directory feedback. It wraps `hosty dev up --manifest modules/demo-module/metadata.dev.json`, seeds the development administrator and user accounts, and links the demo app as a developer target, so the app receives normal Hosty-issued identity instead of a mock token.

The demo app's metadata uses schema `0.3` services for a tightly related frontend and backend fixture. `metadata.dev.json` uses process services with `runtime.ports[].localPort`. The CLI derives the local command, target, development users, assignments, and directory policy from the metadata-driven harness workflow.

Use the local Docker image path when testing managed install, start, stop, restart, update, app data backup, restore, and storage behavior.

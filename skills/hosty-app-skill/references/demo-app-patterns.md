# Demo App Patterns

Use this reference when adapting or comparing against the repository-local demo app at `apps/demo-app`.

The legacy `modules/demo-module` fixture remains useful when working on schema `0.3` metadata compatibility or the existing `hosty dev` harness.

## What To Copy

- App manifest shape from `apps/demo-app/manifest.json` when working on runtime app manifests.
- Legacy metadata shape from `modules/demo-module/metadata.json` when working on schema `0.3` multi-service compatibility.
- Development metadata shape from `modules/demo-module/metadata.dev.json` when using `hosty dev` with process services.
- Production image build pattern from `apps/demo-app/Dockerfile`.
- Health endpoint pattern from `apps/demo-app/src/app/api/health/route.ts`.
- Hosty identity validation pattern from `apps/demo-app/src/lib/host-auth.ts`.
- Scoped user directory lookup from the demo identity and people routes.
- App-owned role storage from `apps/demo-app/src/lib/module-roles.ts`.
- Embedded Shell navigation from `ui.navigation` in manifests or metadata and Next.js pages under `src/app`.
- Hosty-compatible UI primitives from `apps/demo-app/src/components/ui`.

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
npm run demo-app:dev
npm run demo-app:lint
npm run demo-app:build
npm run core:dev
hosty dev up --manifest modules/demo-module/metadata.dev.json --host-url http://localhost:3001
npm run demo-app:docker:build:local
```

Use `npm run core:dev` plus `hosty dev up --manifest modules/demo-module/metadata.dev.json --host-url http://localhost:3001` for Shell app, Hosty identity, assigned-user, and scoped directory feedback. The harness seeds the development administrator and user accounts and links the demo app as a developer target, so the app receives normal Hosty-issued identity instead of a mock token.

The demo app's metadata uses schema `0.3` services for a tightly related frontend and backend fixture. `metadata.dev.json` uses process services with `runtime.ports[].localPort`. The CLI derives the local command, target, development users, assignments, and directory policy from the metadata-driven harness workflow.

Use the local Docker image path when testing managed install, start, stop, restart, update, app data backup, restore, and storage behavior.

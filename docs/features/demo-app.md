# Demo App

Demo App is the repository-local Hosty runtime app under `apps/demo-app`. It is the primary first-party app used to validate runtime app lifecycle work, source overrides, local command runtime profiles, Hosty identity, scoped app directory access, storage probes, and app-owned roles.

```mermaid
flowchart LR
  A["apps/demo-app/manifest.json"] --> B["Hosty Core install"]
  B --> C{"Runtime profile"}
  C --> D["docker image ghcr.io/alex-de-haas/demo-app"]
  C --> E["localCommand dev services"]
  E --> F["frontend localhost:3100"]
  E --> G["backend localhost:3101"]
  B --> H["Hosty identity and app directory"]
```

## Files

- `apps/demo-app/manifest.json` - `app.0.1` manifest with Docker and `dev` local command runtime profiles.
- `apps/demo-app/Dockerfile` - production image build for the Demo App.
- `apps/demo-app/src/app/page.tsx` - runtime diagnostics dashboard.
- `apps/demo-app/src/app/people/page.tsx` - assigned Host users from the scoped app directory.
- `apps/demo-app/src/app/roles/page.tsx` - app-owned role assignment test page.
- `apps/demo-app/src/app/settings/page.tsx` - runtime configuration and storage inspection page.
- `apps/demo-app/src/app/api/health/route.ts` - health and writable-storage probe.
- `apps/demo-app/src/app/api/auth/identity/route.ts` - Host identity, request-header, app directory, and app-owned permission diagnostics.

## Local Runtime Loop

```bash
hosty core start
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
hosty apps health com.haas.demo-app
hosty apps open com.haas.demo-app --user user@docker-host.local --mode shell
```

The `dev` runtime profile starts two Core-managed local command services from `apps/demo-app`:

- `frontend` on `http://localhost:3100`;
- `backend` on `http://localhost:3101`.

Use source overrides when validating changes from a specific worktree:

```bash
hosty apps source-override com.haas.demo-app --path "$PWD"
hosty apps restart com.haas.demo-app
```

## Legacy Fixture

The legacy `modules/demo-module` package remains as a schema `0.3` metadata compatibility fixture until the post-validation removal phase. New first-party runtime app workflows should use `apps/demo-app/manifest.json`.

# Demo App

Demo App is the repository-local Hosty runtime app under `apps/demo-app`. It is the primary first-party app used to validate runtime app lifecycle work, source overrides, local command runtime profiles, runtime switching, Hosty identity, scoped app directory access, storage probes, and app-owned roles.

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

This installed-app loop replaces the removed legacy developer harness. Local checks should use Core-managed app lifecycle, existing Host users, app assignments, source overrides, and `hosty apps identity` or `hosty apps open`; they should not seed deterministic development users or inject fake identity headers.

## Docker Image

Build the local image from the repository root:

```bash
docker build -f apps/demo-app/Dockerfile -t hosty-demo-app:dev .
```

The published manifest image uses:

```text
ghcr.io/alex-de-haas/demo-app:latest
```

For legacy Host UI install testing, the dev-only fixture route is:

```text
http://localhost:3000/fixtures/apps/demo-app
```

That fixture returns the Demo App `app.0.1` manifest and rewrites Docker runtime image references to `hosty-demo-app:dev` with `pullPolicy: ifNotPresent`. It replaces the removed legacy Demo Module fixture.

## Compatibility Boundary

Demo App is the only first-party repository runtime app workflow. Legacy schema `0.2` and `0.3` metadata remains supported for compatibility and migration scenarios, but there is no repository-local Demo Module package or image workflow. See [Legacy compatibility](legacy-compatibility.md).

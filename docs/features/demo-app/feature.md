---
created: 2026-06-03
updated: 2026-10-01
summary: The repository-local reference app used to validate lifecycle, identity, directory access and app roles.
components: [apps/demo-app]
---

# Demo App

Demo App is the repository-local Hosty runtime app under `apps/demo-app`. It is the primary first-party app used to validate runtime app lifecycle work, source overrides, local command runtime profiles, runtime switching, Hosty identity, scoped app directory access, storage probes, and app-owned roles.

```mermaid
flowchart LR
  A["apps/demo-app/manifest.json"] --> B["Hosty Core install"]
  B --> C{"Runtime profile"}
  C --> D["docker image ghcr.io/alex-de-haas/demo-app"]
  C --> E["localCommand dev services"]
  E --> F["frontend Core-assigned port"]
  E --> G["backend Core-assigned port"]
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
- `apps/demo-app/src/app/api/auth/identity/route.ts` - app identity, request-header, app directory, and app-owned permission diagnostics.

## Local Runtime Loop

```bash
hosty core start
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
hosty apps health com.haas.demo-app
hosty apps open com.haas.demo-app --user user@docker-host.local --mode shell
```

The `dev` runtime profile starts two Core-managed local command services from `apps/demo-app`. Core assigns available local ports and injects each service's selected port as `HOSTY_PORT_HTTP` and `PORT`.

- `frontend` exposes the public app UI endpoint.
- `backend` exposes the internal API endpoint.

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

For local install testing, pass the app directory to Core:

```bash
hosty apps install apps/demo-app --runtime dev
```

The removed Legacy Host fixture route at `http://localhost:3000/fixtures/apps/demo-app` is no longer available. Local Docker image testing should use `hosty-demo-app:dev` together with a manifest or feed entry that selects the local image and `pullPolicy: ifNotPresent`.


## Browser Identity

The SDK `AppIdentityBridge` completes app-owned authorization before `DemoSession` loads the
current user through `/api/auth/identity`. Overview, People, Roles and the Session panel consume
that authenticated client snapshot. Server components pass runtime diagnostics, not user identity.
This works when Safari blocks app cookies inside Shell: `appFetch` sends the app grant held in
document memory. Standalone navigation uses the app's HttpOnly cookie. Core's primary session
cookie is never an application credential.

Explicit bearer identity takes precedence over cookies, and an invalid bearer cannot fall back
to a different cookie identity. The identity endpoint distinguishes missing/expired identity (401),
denied access (403) and unavailable validation (503), while retaining the SDK recovery coordinates.
Role updates use `appFetch` and retain server-side app-role authorization. JSON buttons display
responses in a dialog using the same transport, preserving the document's embedded grant.

An iframe document replacement discards its in-memory grant. In cookie-restricted contexts the
replacement document offers app-owned sign-in again; Shell does not relay the previous grant.

## Testing Expectations

- Run `npm test --workspace @haas/hosty-demo-app`, `npm run lint --workspace @haas/hosty-demo-app`
  and `npm run build --workspace @haas/hosty-demo-app -- --webpack`.
- Cover authenticated client loading, refused/unavailable sessions and retry, bearer precedence,
  invalid-bearer refusal and recovery coordinates on 401 responses.
- Verify a Core-managed installation both inside Shell and standalone with normal password login.
  Check the current user, scoped directory, role page, Session panel and protected JSON inspection
  in a cookie-restricted browser. Diagnostic CLI tokens alone do not establish browser acceptance.

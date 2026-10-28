# Demo App Patterns

Use the repository Demo App as an implementation reference when its source is available.
For a new app, validate the app itself through the supported creation and preview workflow.

## Source

- Manifest: `apps/demo-app/manifest.json`
- App auth: `apps/demo-app/src/app/api/auth/app-code/route.ts`
- Identity diagnostics: `apps/demo-app/src/app/api/auth/identity/route.ts`
- App-owned roles: `apps/demo-app/src/lib/app-roles.ts`

## Local Flow

Prepare a Core-managed test instance with separate data and normal login first. Use its actual
data root and the registered worktree; these commands do not start a preview environment.

```bash
hosty --data-root <test-instance-root> apps install <managed-worktree>/apps/demo-app/manifest.json --runtime dev
hosty --data-root <test-instance-root> apps start com.haas.demo-app
```

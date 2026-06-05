# Demo App Patterns

Use the repository Demo App as the first-party runtime app validation target.

## Source

- Manifest: `apps/demo-app/manifest.json`
- App auth: `apps/demo-app/src/app/api/auth/app-code/route.ts`
- Identity diagnostics: `apps/demo-app/src/app/api/auth/identity/route.ts`
- App-owned roles: `apps/demo-app/src/lib/app-roles.ts`

## Local Flow

```bash
hosty core start
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
```

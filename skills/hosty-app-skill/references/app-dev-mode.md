# Local Runtime App Development

Use this reference when validating a local runtime app through Hosty without publishing a new Docker image.

## Purpose

Local runtime profiles let app authors run local source commands behind Hosty Core lifecycle. This validates Shell discovery, app assignment, identity token issuance, scoped user directory access, route handling, WebSockets, SSE, and app-owned authorization while still using the normal app manifest and lifecycle APIs.

Separate local target commands are not part of the current workflow. Do not create separate dev metadata files or local target state.

## Repository Demo Loop

For this repository's demo app:

```bash
npm run core:dev
hosty apps install apps/demo-app/manifest.json --runtime dev
hosty apps start com.haas.demo-app
```

The demo app manifest declares local command services under the `dev` runtime profile:

- `frontend` runs from `apps/demo-app` on `http://localhost:3100`;
- `backend` runs from `apps/demo-app` on `http://localhost:3101`.

Use the normal lifecycle while iterating:

```bash
hosty apps logs com.haas.demo-app
hosty apps restart com.haas.demo-app
hosty apps switch-runtime-plan com.haas.demo-app --runtime docker
```

## Identity Helpers

For direct app-origin endpoint probes, request an app identity token for an existing Hosty user:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
```

For launch validation, ask Core for an app open link:

```bash
hosty apps open com.haas.demo-app --user user@docker-host.local --mode shell
hosty apps open com.haas.demo-app --user user@docker-host.local --mode standalone
```

These helpers use Core-owned users, assignments, access policy, and signing keys. They are diagnostics and launch helpers, not replacements for checking the actual Shell or gateway user flow.

## App Manifest Shape

Use `runtimeProfiles` to declare both Docker and local command modes:

```json
{
  "runtimeProfiles": [
    { "key": "docker", "type": "docker", "default": true },
    { "key": "dev", "type": "localCommand" }
  ],
  "defaultRuntime": "docker",
  "services": [
    {
      "key": "frontend",
      "runtimes": {
        "dev": {
          "type": "localCommand",
          "workingDirectory": "apps/demo-app",
          "command": "npm run dev:frontend",
          "ports": [
            {
              "key": "http",
              "containerPort": 3000,
              "localPort": 3100,
              "protocol": "http",
              "public": true
            }
          ]
        }
      }
    }
  ]
}
```

Keep the same service keys, endpoint keys, settings, data directory semantics, and UI navigation across runtime profiles so switching runtimes is reviewable and reversible.

## Validation

- App-owned UI and business logic can be checked with the app's standalone dev server.
- Hosty identity, Shell embedding, assignments, scoped directory access, redirects, WebSockets, and SSE must be checked through Core-managed lifecycle.
- Dockerfile, storage mounts, lifecycle behavior, and container networking still need image install tests.

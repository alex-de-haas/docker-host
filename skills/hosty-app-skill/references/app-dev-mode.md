# Development Runtimes And Live Trials

Use this reference for supported local/source runtime profiles. Default runtime acceptance uses a
Core-managed child Core with separate users and data. An ordinary-data development
trial is a separate operator-authorized operation: use the installed app's unified development
controls to enter, restart or Return. Return restores runtime selection; it does not reset Git or
restore application data. Preserve live edits and the recorded recovery state.

## Purpose

Local runtime profiles let app authors run local source commands behind Hosty Core lifecycle. This validates Shell discovery, app assignment, identity token issuance, scoped user directory access, route handling, WebSockets, SSE, and app-owned authorization while still using the normal app manifest and lifecycle APIs.

Separate local target commands are not part of the current workflow. Do not create separate dev metadata files or local target state.

## Repository Demo Loop

In an already prepared test instance, with the registered source worktree:

```bash
hosty --data-root <test-instance-root> apps install <managed-worktree>/apps/demo-app/manifest.json --runtime dev
hosty --data-root <test-instance-root> apps start com.haas.demo-app
```

The demo app manifest declares local command services under the `dev` runtime profile:

- `frontend` runs from `apps/demo-app` on a Core-assigned public app UI port;
- `backend` runs from `apps/demo-app` on a Core-assigned internal API port.

Use that test instance's normal lifecycle while iterating:

```bash
hosty --data-root <test-instance-root> apps logs com.haas.demo-app
hosty --data-root <test-instance-root> apps restart com.haas.demo-app
hosty --data-root <test-instance-root> apps switch-runtime-plan com.haas.demo-app --runtime docker
```

## Identity Helpers

For direct app-origin endpoint probes, request an app identity token for an existing Hosty user:

```bash
TOKEN="$(hosty --data-root <test-instance-root> apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

For launch validation, ask Core for an app open link:

```bash
hosty --data-root <test-instance-root> apps open com.haas.demo-app --user user@docker-host.local --mode shell
hosty --data-root <test-instance-root> apps open com.haas.demo-app --user user@docker-host.local --mode standalone
```

These helpers use the selected test Core's users, assignments and access policy. They are diagnostics and launch helpers, not replacements for checking the actual Shell or gateway user flow.

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
          "setup": "npm install",
          "command": "npm run dev:frontend",
          "ports": [
            {
              "key": "http",
              "containerPort": 3000,
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

Do not add `localPort` or `hostPort` for normal local app development. Core assigns available ports, exposes them through `HOSTY_PORT_{KEY}`, and injects `PORT` for single-port services unless the app explicitly set `PORT`.

Declare `setup` when the source needs preparation before it can run. Core checks out the app's source but does not install dependencies or build for you, so a Node app must declare `"setup": "npm install"` (and a compiled app its own restore/build) — otherwise `command` starts against a checkout with no `node_modules` and fails (`sh: next: command not found`). Core runs `setup` to completion before `command` on every start; keep it idempotent.

Keep the same service keys, endpoint keys, settings, data directory semantics, and UI navigation across runtime profiles so switching runtimes is reviewable and reversible.

## Validation

- App-owned UI and business logic can be checked with the app's standalone dev server.
- Hosty identity, Shell embedding, assignments, scoped directory access, redirects, WebSockets, and SSE must be checked through Core-managed lifecycle.
- Dockerfile, storage mounts, lifecycle behavior, and container networking still need image install tests.

## Environment build selection

Retain the existing current/release/source choices. Current and release copy a prepared executable
into the child's private build directory; source explicitly builds an authorized Core project.
An application workspace alone does not select a source Core. Parent updates do not replace a
continuing child's build; parent Start/Restart still prepares its selected input. Observe the child
process/version instead of assuming a permanent version pin. No alternate single-app relay or
sandbox-aware identity path is supported.

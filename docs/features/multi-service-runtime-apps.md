# Multi-Service Runtime Apps

## Description

Runtime apps can declare more than one service. Each service has runtime-specific configuration for Docker or local command execution, and Core reports service-level health, logs, endpoints, and process/container state.

## Manifest Shape

```json
{
  "schemaVersion": "app.0.1",
  "id": "com.example.app",
  "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
  "services": [
    {
      "key": "api",
      "runtimes": {
        "dev": {
          "type": "localCommand",
          "command": "npm run dev:api",
          "ports": [{ "key": "http", "containerPort": 3000, "protocol": "http" }]
        }
      }
    },
    {
      "key": "web",
      "dependsOn": ["api"],
      "runtimes": {
        "dev": {
          "type": "localCommand",
          "command": "npm run dev:web",
          "ports": [{ "key": "http", "containerPort": 3000, "protocol": "http", "public": true }]
        }
      }
    }
  ]
}
```

## Runtime Behavior

- Core starts services in dependency order.
- `HOSTY_APP_SERVICE_KEY` identifies the running service.
- `HOSTY_PORT_{KEY}` exposes assigned local ports. Prefer omitting `localPort` so Core can avoid collisions.
- Single-port `localCommand` services receive `PORT` when the manifest or settings did not explicitly set it.
- A service that `dependsOn` a sibling also receives that sibling's internal base URL as `HOSTY_SERVICE_{KEY}_URL` (see below).
- Public endpoints are shown in Shell and used by `hosty apps open`.
- Health and logs are reported per service.

## Intra-App Service Discovery

`dependsOn` drives both startup ordering **and** intra-app URL discovery. When service `web` declares `dependsOn: ["api"]`, Core injects `HOSTY_SERVICE_API_URL` into `web`, pointing at `api`'s internal port — so `web` can proxy REST/WebSocket traffic to `api` without exposing `api`'s management port publicly or pinning ports app-side.

- The target port is `api`'s first non-`public` port, or the port named explicitly: `dependsOn: [{ "service": "api", "port": "internal" }]`.
- Under `docker`, siblings share a per-app user network and resolve each other by service name: `HOSTY_SERVICE_API_URL=http://api:3000`. The internal port is not host-published.
- Under `localCommand`, siblings resolve over loopback at the assigned port: `HOSTY_SERVICE_API_URL=http://localhost:43210`.
- `HOSTY_SERVICE_{KEY}_URL` is intra-app (sibling services); the cross-app `HOSTY_DEPENDENCY_{KEY}_URL` resolves a *different* installed app's public endpoint. The two namespaces never collide.

In the manifest above, `web` receives `HOSTY_SERVICE_API_URL` resolving to `api`'s `http` port.

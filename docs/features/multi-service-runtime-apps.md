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
- Public endpoints are shown in Shell and used by `hosty apps open`.
- Health and logs are reported per service.

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
          "ports": [{ "key": "http", "localPort": 3101, "protocol": "http" }]
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
          "ports": [{ "key": "http", "localPort": 3100, "protocol": "http", "public": true }]
        }
      }
    }
  ]
}
```

## Runtime Behavior

- Core starts services in dependency order.
- `HOSTY_APP_SERVICE_KEY` identifies the running service.
- `HOSTY_PORT_{KEY}` exposes assigned local ports.
- Public endpoints are shown in Shell and used by `hosty apps open`.
- Health and logs are reported per service.

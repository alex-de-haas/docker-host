# App Implementation Checklist

- Manifest uses `schemaVersion: "app.0.1"`.
- Runtime profiles match the app's intended Docker and local development workflows.
- Local command profiles declare working directories, commands, ports, and environment clearly.
- Local command profiles omit `localPort` / `hostPort` unless the app intentionally needs a fixed local port.
- UI apps define `ui.entrypoint` and navigation.
- Apps read `HOSTY_APP_ID`, `HOSTY_CORE_ORIGIN`, `HOSTY_APP_DATA_DIR`, `HOSTY_PORT_{KEY}`, and `PORT` instead of hard-coding local paths or ports.
- Apps that need assigned users call `/api/internal/apps/{appId}/directory/users` with `HOSTY_APP_SERVICE_TOKEN`.
- App-owned roles are stored under the app data directory.
- Local validation uses `hosty apps install apps/demo-app/manifest.json --runtime dev` or the target app's manifest path.
- Documentation links point to `docs/features/runtime-app-manifest.md` when the manifest contract changes.

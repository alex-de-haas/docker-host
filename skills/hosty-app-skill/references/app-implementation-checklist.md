# App Implementation Checklist

- Manifest uses `schemaVersion: "app.0.1"`.
- Runtime profiles match the app's intended Docker and local development workflows.
- Local command profiles declare working directories, commands, ports, and environment clearly.
- Local command profiles omit `localPort` / `hostPort` unless the app intentionally needs a fixed local port.
- UI apps define `ui.entrypoint` and navigation.
- UI apps resolve `hosty_launch` and hide the name and page navigation a shell already renders, keeping contextual controls and information (see `app-launch-mode.md`).
- Apps published through Marketplace include an `app-feeds.0.1` `feeds.json` whose `appId` matches the manifest and whose manifest refs are HTTP(S) URLs.
- Apps read `HOSTY_APP_ID`, `HOSTY_CORE_ORIGIN`, `HOSTY_APP_DATA_DIR`, `HOSTY_PORT_{KEY}`, and `PORT` instead of hard-coding local paths or ports.
- Apps that need assigned users call `/api/internal/apps/{appId}/directory/users` with `HOSTY_APP_SERVICE_TOKEN`.
- App-owned roles are stored under the app data directory.
- Apps declaring `interfaces.mcp` use the SDK's MCP-specific introspection helper for assistant MCP-only tokens and supported direct delegated/scoped credentials. Ordinary API introspection must reject MCP-only credentials. Answer `notifications/initialized` with HTTP 202 and an empty body (never an empty 200), and declare `annotations.readOnlyHint` on every tool (see `app-manifest.md`, "MCP Interface").
- Local validation uses `hosty apps install apps/demo-app --runtime dev` or `hosty apps install . --runtime <profile>` from the target app directory.
- Browser identity validation uses ordinary Core password login after setup/recovery on an isolated
  data root; no user-selector or direct-session shortcut is available in Development.
- Documentation links point to `docs/features/runtime-app-manifest/feature.md` when the manifest contract changes.

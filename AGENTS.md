# Agent Instructions

## Hosty Runtime App Development

- Do not validate Hosty identity, Shell embedding, app assignments, or scoped directory behavior by running an app only in standalone mode.
- Use the integrated Hosty development harness for runtime app work that depends on Hosty identity:
  ```bash
  hosty config set HOST_DEV_REPOSITORY_PATH "<path-to-hosty-repository>"
  hosty config set HOST_DEV_PORT 3001
  hosty dev up --manifest modules/demo-module/metadata.dev.json
  ```
- If the Host is already running from another terminal or debugger, connect to it instead of starting another Host process:
  ```bash
  hosty dev up --manifest modules/demo-module/metadata.dev.json --host-url http://localhost:3001
  ```
- For direct API probes against the local app origin, request a real Hosty-signed development identity token after the developer target has been prepared:
  ```bash
  TOKEN="$(hosty dev identity --manifest modules/demo-module/metadata.dev.json --format token)"
  curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
  ```
- Use `--user user@docker-host.local` when a check must run as the normal development user. The default identity user is the first assigned development user from `metadata.dev.json`, usually `admin@docker-host.local`.
- Treat `hosty dev identity` as a diagnostic helper for direct endpoint probes only. Gateway and Shell integration still need to be checked through the Host URL printed by `hosty dev up`.

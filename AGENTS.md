# Agent Instructions

## Docker Host Module Development

- Do not validate Host identity, app shell embedding, module assignments, or scoped directory behavior by running a module only in standalone mode.
- Use the integrated Docker Host development harness for module work that depends on Host identity:
  ```bash
  docker-host config set HOST_DEV_REPOSITORY_PATH "<path-to-docker-host-repository>"
  docker-host config set HOST_DEV_PORT 3000
  docker-host dev up --manifest modules/demo-module/metadata.dev.json
  ```
- If the Host is already running from another terminal or debugger, connect to it instead of starting another Host process:
  ```bash
  docker-host dev up --manifest modules/demo-module/metadata.dev.json --host-url http://localhost:3000
  ```
- For direct API probes against the local module origin, request a real Host-signed development identity token after the developer target has been prepared:
  ```bash
  TOKEN="$(docker-host dev identity --manifest modules/demo-module/metadata.dev.json --format token)"
  curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
  ```
- Use `--user user@docker-host.local` when a check must run as the normal development user. The default identity user is the first assigned development user from `metadata.dev.json`, usually `admin@docker-host.local`.
- Treat `docker-host dev identity` as a diagnostic helper for direct endpoint probes only. Gateway and shell integration still need to be checked through the Host URL printed by `docker-host dev up`.

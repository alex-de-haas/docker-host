# Agent Instructions

## Hosty Runtime App Development

- Do not validate Hosty identity, Shell embedding, app assignments, or scoped directory behavior by running an app only in standalone mode.
- Use Core-managed runtime app lifecycle for local app work that depends on Hosty identity. Install the app manifest with the local/source runtime profile, then start it through Core:
  ```bash
  hosty core start
  hosty apps install apps/demo-app/manifest.json --runtime dev
  hosty apps start com.haas.demo-app
  ```
- If Core is already running from another terminal or debugger, use normal `hosty apps ...` commands against that Core process instead of starting another Core process.
- For direct API probes against the local app origin, request a real Hosty-signed app identity token through Core:
  ```bash
  TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
  curl -H "X-Docker-Host-Identity: $TOKEN" http://127.0.0.1:3100/api/auth/identity
  ```
- Treat `hosty apps identity` as a diagnostic helper for direct endpoint probes only. Gateway and Shell integration still need to be checked through Core/Shell URLs and `hosty apps open`.

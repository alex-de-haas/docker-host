# Agent Instructions

## Versioning

Hosty uses semantic versioning `major.minor.patch`, applied per release artifact. See `docs/features/repository-release-model.md` for the full policy. When a change ships in one of these components, bump its version in the same commit:

- **patch** - bug fix or small enhancement to existing functionality.
- **minor** - new functionality, or a large/breaking change (while the project is in `0.x`).
- **major** - reserved until `1.0`; then breaking changes (Core HTTP API, removed/renamed CLI command or flag).

Where the version lives:

- **Platform (`apps/core` + `apps/cli`)** share one version in the root `Directory.Build.props`. Bump it there; do not add `<Version>` to individual `.csproj` files.
- **`apps/shell`**, **`apps/marketplace`**, and **`apps/demo-app`** are first-party runtime apps: bump `version` in their respective `manifest.json` (the artifact source of truth) and keep their `package.json` in step. They version independently from the platform.
- **`apps/telemetry`** (collector + backend + `apps/telemetry-ui`) ships as one app: bump `version` in `apps/telemetry/manifest.json` and keep the first-party service image tags (`backend`, `ui`) and `apps/telemetry-ui/package.json` in step (`scripts/check-versions.mjs` enforces this). The collector is a third-party image and is exempt.
- **Runtime app manifests** (including external apps like project-manager, media-server, torrent-engine) follow the hosty-app-skill rules in `skills/hosty-app-skill/references/app-manifest.md`. Do not bump `schemaVersion` for ordinary changes - it only tracks the manifest contract format.

## Pull Requests

- **Do not squash-merge PRs.** Parallel PRs are common here, and squash merges rewrite the merged branch's history — the other in-flight branches can no longer rebase cleanly onto main. Use a regular merge commit instead.
- **One PR per feature, not per phase.** When a feature plan is split into phases, implement all phases on one branch and open a single PR. Individual phases rarely deliver complete functionality on their own, and under the versioning rules above each per-phase PR would pointlessly bump the version.

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

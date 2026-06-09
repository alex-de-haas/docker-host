# Feature: Hosty Shell Docker Image

Status: Implemented.

## Goal

Publish Hosty Shell as a Docker image and let Hosty Core install and start it as the normal Core-owned system runtime app `hosty.shell`.

The intended installed flow is:

1. `scripts/install.sh` installs the `hosty` CLI.
2. `hosty install` prepares local Hosty directories and `~/.hosty/config/launch.env`.
3. `hosty start` downloads and starts the managed Hosty Core executable when needed.
4. The CLI passes the configured Shell manifest reference and runtime to Core.
5. Core downloads that manifest through the existing runtime app manifest loader.
6. Core installs or reconciles `hosty.shell` as a system app and starts it through the normal runtime app lifecycle.

## Non-goals

- Do not restore the retired combined Next.js Host image.
- Do not move Shell lifecycle ownership into the CLI.
- Do not embed a fixed Shell manifest in the Core executable.
- Do not introduce desktop Shell packaging in this change.
- Do not introduce generated product channel indexes or digest-pinned channels yet.
- Do not publish Docker images from pull request CI.
- Do not expose Shell lifecycle controls in Shell UI; system apps remain inspect-only.

## Previous Behavior

- `apps/shell/Dockerfile` exists and can build a standalone Next.js image.
- `.github/workflows/ci.yml` builds Shell with `npm run shell:build`, but does not build or publish a Shell Docker image.
- `.github/workflows/demo-app-image.yml` publishes only the Demo App image.
- `apps/shell/manifest.json` declares a Docker runtime profile, but its image is local-only: `hosty-shell:local` with `pullPolicy: never`.
- Core can install runtime apps from local manifest paths or HTTP(S) manifest URLs through the existing app manifest loader.
- Core bootstraps `hosty.shell` as a system app when it can find a Shell manifest.
- Source runs can find `apps/shell/manifest.json`, but installed Core startup currently depends on local manifest discovery or explicit `HOSTY_SHELL_MANIFEST_PATH`.
- Outside Development, Core leaves `ShellPublicOrigin` unset unless the user configures it, so `hosty open` cannot open Shell even if the container starts.
- When `hosty.shell` is already installed, Core bootstrap updates settings/autostart only; it does not reconcile the installed Shell manifest with a newer configured manifest URL.

## Implemented Behavior

- Publish the browser Shell image as Hosty Shell on pushes to `main`.
- Use `ghcr.io/alex-de-haas/hosty-shell` as the Docker image repository.
- Keep the runtime app id and in-product display name as `hosty.shell` and `Hosty Shell`.
- Update the Shell Docker runtime profile to use `ghcr.io/alex-de-haas/hosty-shell:latest` with `pullPolicy: always` for the rolling development channel.
- Keep the Shell manifest source repository clonable from a remote manifest by declaring `https://github.com/alex-de-haas/docker-host.git`.
- Add a Shell image workflow that runs only on pushes to `main` and publishes `latest` plus `sha-<commit>` tags.
- Keep the existing CI workflow shape for pull requests. Pull requests continue to run the current Shell build, Demo App build, Core build, and CLI build checks; they do not build or publish the Shell Docker image.
- Add a launch setting for the Shell manifest reference: `HOSTY_SHELL_MANIFEST_PATH`.
- `HOSTY_SHELL_MANIFEST_PATH` accepts either a local manifest path or an HTTP(S) manifest URL.
- Default `HOSTY_SHELL_MANIFEST_PATH` to the raw GitHub URL for `apps/shell/manifest.json` on `main`.
- Add `HOSTY_SHELL_BOOTSTRAP_RUNTIME` as the selected Shell runtime profile, defaulting to `docker`.
- With the default URL manifest, `HOSTY_SHELL_BOOTSTRAP_RUNTIME=docker` starts the latest published Shell image. If a user selects a Shell `localCommand` runtime from a URL manifest, Core clones the manifest's `source.repository` into Hosty managed sources before start.
- Let users override the Shell manifest reference and runtime in `launch.env` to run a custom Shell implementation.
- Keep Core as the owner of Shell system app bootstrap. The CLI writes and passes launch settings only.
- Make Core bootstrap accept either a local Shell manifest path or URL, then use the same install/update path used by ordinary runtime apps.
- Make Core bootstrap reconcile an existing `hosty.shell` system app with the configured Shell manifest URL while preserving explicit runtime/source override intent where possible.
- Set the installed launch default `HOST_SHELL_PUBLIC_ORIGIN` to `http://localhost:3000`, while keeping explicit `HOST_SHELL_PUBLIC_ORIGIN` configuration authoritative.

## User/API Scenarios

- A new user installs Hosty through `scripts/install.sh`, runs `hosty install`, then `hosty start`. Core downloads the configured Shell manifest and starts `hosty.shell` from the published `ghcr.io/alex-de-haas/hosty-shell:latest` image.
- `hosty open` opens the configured Shell origin after Core startup.
- A user replaces the Shell by setting `HOSTY_SHELL_MANIFEST_PATH` in `launch.env` to another compatible local manifest path or manifest URL, and setting `HOSTY_SHELL_BOOTSTRAP_RUNTIME` when the replacement should use a non-default runtime profile.
- A developer runs `npm run dev`; Core still bootstraps Shell with the repository-local manifest's `dev` local command runtime and source override.
- An administrator sees Hosty Shell under System Apps and can inspect logs, but cannot stop, update, back up, or remove it from Shell UI.
- An existing installation with a local-only Shell manifest is reconciled to the configured Shell manifest URL on startup or update.

## Technical Design

- `.github/workflows/shell-image.yml` publishes the image on `push` to `main` with path filters for:
  - `apps/shell/**`;
  - `package.json`;
  - `package-lock.json`;
  - `.github/workflows/shell-image.yml`.
- Root package scripts provide local Shell image builds:
  - `shell:docker:build`;
  - `shell:docker:build:local`.
- `apps/shell/manifest.json` Docker image metadata points to `ghcr.io/alex-de-haas/hosty-shell`.
- CLI launch settings include:
  - `HOSTY_SHELL_MANIFEST_PATH`, defaulting to `https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json`;
  - `HOSTY_SHELL_BOOTSTRAP_RUNTIME`, defaulting to `docker`;
  - `HOST_SHELL_PUBLIC_ORIGIN`, defaulting to `http://localhost:3000`.
- `CoreCommand.BuildCoreEnvironment` passes those launch settings to Core.
- Core runtime config resolves a Shell manifest reference in this priority order:
  - explicit `HOSTY_SHELL_MANIFEST_PATH` for local paths, manifest URLs, and existing development workflows;
  - repository-local `apps/shell/manifest.json` when running from source and no setting is configured.
- Core Shell bootstrap:
  - install `hosty.shell` when missing;
  - configure settings/autostart as today;
  - reconcile the installed Shell manifest when the configured manifest reference changes or the remote manifest content changes;
  - avoid silently switching a developer-selected `dev` runtime back to Docker.

## Data Model / API Changes

No Core API schema change is expected.

The app registry already stores `ManifestPath`, `ManifestUrl`, `SelectedRuntime`, and `System`. Existing records can be updated through normal lifecycle install/update logic.

The CLI launch configuration schema gains two settings:

- `HOSTY_SHELL_MANIFEST_PATH`
- `HOSTY_SHELL_BOOTSTRAP_RUNTIME`

## Edge Cases

- Docker is not installed or not running: Core remains available and records Shell autostart failure.
- GHCR image is not published yet: Shell start fails until the image exists, but Core remains available.
- Raw GitHub manifest URL is unreachable: Core remains available and Shell bootstrap logs a warning.
- Port `3000` is already occupied: Shell start fails unless the configured manifest/origin uses a different port.
- Existing installations with `hosty-shell:local` should not remain pinned to a non-existent local image after upgrade.
- Explicit `HOSTY_SHELL_MANIFEST_PATH`, `HOSTY_SHELL_BOOTSTRAP_RUNTIME`, and source override settings must keep working for local development.
- URL manifests that use a Shell `localCommand` runtime must declare an absolute clonable `source.repository`; relative repositories such as `.` work only for local manifest path installs.
- If Shell image publishing and CLI/Core release publishing race on the same commit, the rolling `latest` tag may briefly point to the previous image.
- A custom Shell manifest must use the same Core API/session expectations as the built-in Shell.

## Testing Plan

- `npm run shell:build`
- `docker build -f apps/shell/Dockerfile -t hosty-shell:dev .`
- `dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj`
- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj`
- `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj`
- GitHub Actions syntax/path review for the new Shell image workflow
- Manual installed-flow smoke:
  - install CLI;
  - run `hosty install`;
  - run `hosty start`;
  - verify Core bootstraps `hosty.shell`;
  - verify Docker pulls and starts the Shell image;
  - verify `hosty open`.

## Rollout / Migration Notes

The first rollout should publish the Shell image before relying on new installed Core bootstrap behavior.

The default manifest URL intentionally targets `main` because early Hosty development uses rolling integration instead of stable product channels.

Runtime app UI and Demo App image workflows are not changed by this feature except for shared package dependency cache behavior.

Future product channels can replace the rolling `latest` reference with digest-pinned Shell manifests.

## Decisions

- The public Docker package is `ghcr.io/alex-de-haas/hosty-shell`.
- The in-product app id remains `hosty.shell`.
- Shell remains a normal runtime app installed by Core, not a special CLI-owned process.
- The default Shell manifest comes from configurable `HOSTY_SHELL_MANIFEST_PATH`, not an embedded Core resource.
- `HOSTY_SHELL_MANIFEST_PATH` can be a local path or an HTTP(S) URL.
- `HOSTY_SHELL_BOOTSTRAP_RUNTIME` selects the Shell runtime profile.
- The default installed values are the raw GitHub Shell manifest URL and runtime `docker`.
- `HOST_SHELL_PUBLIC_ORIGIN` defaults to `http://localhost:3000` for the installed CLI launch path.
- Core auto-applies Shell manifest reconciliation for `hosty.shell` only when the installed runtime matches `HOSTY_SHELL_BOOTSTRAP_RUNTIME`.
- Pull requests keep the existing standard CI and do not build or publish the Shell Docker image.

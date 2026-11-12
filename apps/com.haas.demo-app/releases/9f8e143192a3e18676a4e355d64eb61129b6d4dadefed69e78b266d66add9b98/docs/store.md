![Demo App](../assets/icon.svg)

# Demo App

A reference Hosty runtime app. It exists to exercise and demonstrate the platform
end to end — the lifecycle, settings, app data and backups, external mounts, app
identity, and app-owned role flows — and to serve as a worked example for the
catalog and the manifest-level asset model.

## What it shows

- **Two services** (`backend` + `frontend`) with a dependency edge, each runnable
  as a Docker image or, in Development Mode, as a local command from source.
- **Settings** surfaced from the manifest — a greeting, a release channel, a
  refresh interval, and an auth-preview toggle.
- **App data** at a Hosty-managed directory, with backup and restore.
- **External mounts** via a `catalogRoots` host-path slot.
- **App identity + role flows** against Hosty Core's app directory.

## Using it

Install it from the marketplace, open it from the sidebar, and poke at the People,
Roles, and Settings pages. Nothing here is load-bearing for a real deployment —
treat it as a live specimen of what a Hosty app manifest can declare.

# Docker runtime and dependencies

Docker source mounts and cache paths are manifest contracts. The bootstrap mounts source
read-only at /workspace, node_modules as a separate cache and app data at /app/data. The agent
edits its writable worktree; changes become visible in the container's source mount.
Never move dependencies, outputs or secrets into source just because it is convenient.
Internet may be needed for the first image/package download. Setup/command run through a login
shell in the image: use an explicit toolchain PATH when the image's login profile resets it.
For Rust, keep Cargo registry/target output in declared cache directories. If Cargo must update
`Cargo.lock`, declare `sourceMount.generatedFiles: ["Cargo.lock"]`: Core provides a writable
app-cache overlay for that file while retaining the read-only source mount. A missing file gets
an empty source mountpoint; an existing file seeds the first cache. Runtime changes to the overlay
are not source edits or an accepted dependency lockfile. Restart retains it; Finish removes it.

Keep schemaVersion `app.0.1`. A profile with `type: "docker"` runs containers; `localCommand` is not
the preview route. Read the actual manifest before changing service keys, endpoint targets or mounts.
Inspect the generated bootstrap manifest and the installed app contract instead of guessing fields.

A .NET backend plus Node UI uses distinct service keys and health checks, a public UI and a private
backend endpoint. Use `dependsOn` and injected `HOSTY_SERVICE_<KEY>_URL` discovery. Dependency apps
such as Transcode Engine are separate installations in the same child Core, not shared parent apps.
Keep app data, source and caches separate for every service. New images, permission or topology
changes need a reviewed update. Health alone does not prove readiness, identity or a working UI.

Use published SDK packages and real dependency locks. Never add host paths, parent data, service
credentials or the Docker socket to an app manifest as a workaround. Shared directories are explicit
operator-reviewed mounts; media input granted read-only stays read-only and output uses child data.

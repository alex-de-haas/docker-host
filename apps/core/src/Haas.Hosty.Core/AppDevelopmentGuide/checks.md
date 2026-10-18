# Checks and recovery

Check preview is optional. Use stack-specific bounded commands in the assigned worktree or
the child runtime. For Node run the project's actual typecheck/test/build scripts; for .NET
build the relevant project and run affected tests; for Rust run cargo check/test if present.
A successful build is not proof that the service restarted. Inspect runtime/build/restart
observations, health and the actual browser. Show failed/unknown/stale results honestly.

For the Harness **Check preview** control, place an optional `.hosty/preview-checks.json` array
in a Docker service's source root, for example:

```json
[{"id":"unit","command":["node","--test","checks.test.mjs"],"cwd":".","timeoutSeconds":60}]
```

Each service sharing that source offers its own checks. Use its actual installed toolchain:
`npm test`, `dotnet test` or `cargo test` are commands, not built-in success assertions. Declare
runtime cache/output mounts for generated build files or use the container's temporary directory;
source stays read-only. No recipe means not checked. The operator reviews the exact argv, cwd,
timeout and interruption warning, then runs one check. Read recipes/results through
`GET /api/apps/{appId}/preview-checks`; execution uses `POST /api/apps/{appId}/preview-checks/run`
with `{id,digest,requestId}` from that observation, never browser-supplied command text. Preserve
the request UUID after a lost response. The parent environment API serializes checks with workspace
writers; wait for the active source turn to stop before an operator check.

Checks run inside the selected app service container with its existing resource limits. Timeout
or cancellation stops that container to terminate descendants; use an explicit Restart afterwards.
Source/recipe, manifest, image and container revisions invalidate prior results. Declared generated
files, caches and Git metadata are excluded from source hashing; after manually changing installed
tools/caches, restart and rerun checks. Core restart with uncertain execution reports unknown and
requires service restart before another check. Fix build/start failures in the same worktree and
sandbox, preserving test data. Manifest/environment-image changes still use normal review.

The bootstrap's Node watch command restarts server imports; the browser bundle is rebuilt on
request, so refresh the page after client changes. Adding dependencies may need setup/cache
refresh; manifest/service topology changes need reviewed runtime reload/restart. Do not
claim hot reload for changes that require restart. Remove obsolete bootstrap services when
installing the replacement topology. Preserve the sandbox data unless reset was requested.

Before reporting success: validate normal login, anonymous denial, real app data, requested
behavior, logs/health and the operator preview link. Prepare synthetic data in the child
app's own data directory. A child dependency must be a separate child installation.
Shared mounts need explicit reviewed permission; read-only examples remain read-only.


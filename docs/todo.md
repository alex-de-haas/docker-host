# Future Work

## Runtime App Updates

- Add an `image.pullPolicy` mode such as `ifChanged` for rolling tags. Core should check the remote image digest, pull only when the registry digest differs from the locally installed image, and require app service replacement only when the image actually changed.

## CLI Self-Update Architecture

- Evaluate replacing in-place CLI self-update with a stable launcher/shim and immutable content-addressed CLI binaries. The `hosty` command on `PATH` would remain a small stable shim that reads the active version pointer, forwards arguments and standard streams to `~/.hosty/cli/store/<sha256>/hosty`, and returns the child exit code. Updates would download and verify a new binary into staging, move it into the hash-addressed store, atomically update the active pointer, and continue any update workflow by launching the new binary. Define rollback and cleanup rules, such as retaining the last N versions and keeping shim updates as a rare separate path.

## Runtime App Removal

- Consider showing concrete app-owned files or directories that will be deleted when an administrator enables app data deletion in the app removal flow. The preview should be limited to app data owned by Hosty under the Hosty data root. External mount paths must never be listed as delete targets or removed.

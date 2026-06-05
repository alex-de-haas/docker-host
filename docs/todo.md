# Future Work

## Runtime App Updates

- Add an `image.pullPolicy` mode such as `ifChanged` for rolling tags. Core should check the remote image digest, pull only when the registry digest differs from the locally installed image, and require app service replacement only when the image actually changed.

## Runtime App Removal

- Consider showing concrete app-owned files or directories that will be deleted when an administrator enables app data deletion in the app removal flow. The preview should be limited to app data owned by Hosty under the Hosty data root. External mount paths must never be listed as delete targets or removed.

# Future Work

This page tracks small product and implementation ideas that are not yet large enough for a dedicated planning document.

## Module Updates

- Add an `image.pullPolicy` mode such as `ifChanged` for rolling tags. The Host should check the remote image digest, pull only when the registry digest differs from the locally installed image, and require module container replacement only when the image actually changed. This would give modules using tags like `latest` a less aggressive alternative to `always`.

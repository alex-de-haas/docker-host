# Future Work

This page tracks small product and implementation ideas that are not yet large enough for a dedicated planning document.

## Module Updates

- Add an `image.pullPolicy` mode such as `ifChanged` for rolling tags. The Host should check the remote image digest, pull only when the registry digest differs from the locally installed image, and require module container replacement only when the image actually changed. This would give modules using tags like `latest` a less aggressive alternative to `always`.

## Module Removal

- Consider showing the concrete module-owned files or directories that will be deleted when an administrator enables `Delete module data` in the module removal flow. The preview should be limited to root module data owned by Docker Host under the Host data root. External mount paths must never be listed as delete targets or removed, because those files are provided by the administrator and do not belong to the module.

## Demo Module

- Split the demo module into distinct frontend/backend runtime implementations, or make the current frontend consume the declared backend endpoint at runtime. The metadata already declares two services and connection wiring; the remaining work is to exercise a real cross-service request flow instead of using the same image for both services.

## External Ingress

- Add optional provider-specific external ingress automation on top of the implemented provider-neutral readiness flow. Cloudflare DNS, Cloudflare Tunnel public hostname, Cloudflare Access application management, and adapter/preset support for other ingress providers are candidates, but should remain separate provider adapters instead of blocking Host-owned authorization work.

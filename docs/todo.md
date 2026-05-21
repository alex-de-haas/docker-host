# Future Work

This page tracks small product and implementation ideas that are not yet large enough for a dedicated planning document.

## Module Updates

- Add an `image.pullPolicy` mode such as `ifChanged` for rolling tags. The Host should check the remote image digest, pull only when the registry digest differs from the locally installed image, and require module container replacement only when the image actually changed. This would give modules using tags like `latest` a less aggressive alternative to `always`.

## Demo Module

- Expand the demo module into a two-service frontend/backend module. The frontend should consume a backend API through the module connection model so Docker Host can dogfood multi-container module metadata, internal endpoint wiring, dependency order, per-service runtime status, and lifecycle testing against a realistic full-stack fixture.

## External Ingress

- Add optional provider-specific external ingress automation on top of the implemented provider-neutral readiness flow. Cloudflare DNS, Cloudflare Tunnel public hostname, Cloudflare Access application management, and adapter/preset support for other ingress providers are candidates, but should remain separate provider adapters instead of blocking Host-owned authorization work.

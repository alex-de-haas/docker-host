# Module metadata planning

## Decisions

### Implementation order

Implement the standalone `docker-host` CLI first and make it reliably manage the Host container lifecycle: install, start, stop, restart, update, status, logs, open, and configuration.

For the first CLI milestone, the Host container can continue running the existing Host application code. The current Next.js Docker container management UI should remain as a working launch target and smoke-test example while the CLI and Host bootstrap flow are built out.

Module metadata support comes after the CLI can bootstrap and manage the Host container correctly.

### Repository and application split

Leave the shared API contract details for the implementation phase. As part of the first CLI implementation work, split the current repository structure into separate application areas:

- move the existing Next.js application into the Host application area;
- create a new application area for the standalone `docker-host` CLI;
- define the shared API contract between Web UI, Host backend API, and CLI while introducing the CLI-facing Host API surface.

### Module metadata schema

For now, the module metadata schema is documented in [Module metadata files](../features/module-metadata.md). That document is the source of truth for the expected shape, defaults, and validation rules until an executable schema exists.

The likely future validation artifact is JSON Schema. When implementation reaches runtime validation, add a versioned JSON Schema to the repository and wire Host backend validation to it.

### Dependency MVP scope

The first implementation should support only required dependencies. Optional dependencies should be designed and implemented later as a separate feature.

### Secret settings MVP

The first implementation should store secret settings in the same settings storage as regular module settings. A setting marked as `type: "secret"` is not a separate storage class in the MVP; it is a presentation and API handling rule.

Secret setting values may be stored in `module-settings.json` together with other module setting values. The Host should still treat them as write-only values at the UI/API boundary:

- API responses used by the Web UI must not include the raw secret value;
- UI forms should show whether a value is set and allow setting, changing, and clearing it without revealing the current value;
- install plans, status views, logs, error messages, and diagnostics must redact secret values;
- secret values may still be injected into module runtime configuration, for example as environment variables, when the metadata setting target requires it.

This is acceptable for the local-first MVP. The primary goal is to prevent accidental exposure through the Web UI, API responses, logs, and diagnostics. Encrypted files, OS keychain integration, protected local files, and external secret managers can be considered later as advanced storage backends if the project starts handling more sensitive data.

### CLI implementation stack

The first `docker-host` CLI implementation must be a .NET self-contained single-file executable using Spectre.Console for command structure, prompts, status output, tables, and progress indicators.

The CLI should not require a .NET runtime to be installed on the administrator machine.

The CLI project should target `net10.0`.

### Docker daemon connection MVP

The first implementation should use the local Docker Unix socket at `/var/run/docker.sock` as the Docker daemon connection mechanism.

The CLI should use the Docker socket for Host container lifecycle commands. The Host container should receive the same socket through a bind mount:

```text
/var/run/docker.sock:/var/run/docker.sock
```

`DOCKER_HOST` support is out of scope for the first implementation and can be considered later if the project needs non-standard Docker daemon endpoints.

### CLI Docker execution MVP

The first CLI implementation should call the installed Docker CLI executable for Host container lifecycle operations. The CLI should shell out to commands such as `docker pull`, `docker run`, `docker stop`, `docker rm`, `docker inspect`, and `docker logs`.

Implementation rules:

- invoke Docker through `ProcessStartInfo.ArgumentList` or equivalent argument-array APIs, not by constructing shell command strings;
- keep Docker command execution behind a small adapter layer so it can be replaced later;
- prefer structured JSON output such as `docker inspect` over parsing human-readable command output;
- surface Docker command failures with the command name, exit code, stderr, and a clear next step for the administrator.

The architecture can still be described as CLI -> Docker daemon, with Docker CLI acting as the first implementation transport. A later implementation may replace this adapter with direct Docker Engine API communication over the Unix socket.

### Metadata URL security MVP

The first implementation should not add special security restrictions for module metadata URLs. When an administrator installs a module from a metadata URL, that URL is considered an explicit trust decision made by the administrator.

For the MVP, the Host should:

- download the metadata URL provided by the administrator;
- parse and validate the JSON metadata shape;
- show a clear install plan before creating containers or mounts;
- treat Docker image references, dependencies, ports, settings, and mounts as normal install plan data rather than security warnings;
- allow common image tags such as `latest` without warning.

The MVP should not require trusted domain allow-lists, metadata signatures, SSRF protection, special redirect handling, or warnings for `latest` tags. These hardening features can be considered later if Docker Host grows beyond local/private-network usage.

Module-to-module connection URLs generated by the Host should be internal Docker-network URLs only. External URLs, if needed by a module, are the module author's responsibility and are not part of Host-managed dependency URL resolution.

### Public module exposure scope

The first module implementation should not solve public host port assignment or external exposure for modules. Module-to-module communication should stay inside the Host-managed Docker network.

Publishing selected modules outside the local/private network should be implemented later as a dedicated feature with explicit authorization and exposure settings.

### Runtime status MVP

The first module implementation should not introduce module runtime health checks or readiness probes. Host should rely only on Docker daemon container state for module status, for example whether a container is created, running, stopped, exited, or failed according to Docker.

For required dependencies, the first implementation should consider a dependency started when Docker successfully starts the dependency container and the Host can compute its internal Docker-network base URL. Host should not wait for an HTTP health endpoint or custom readiness signal in the MVP.

Future module health checks should be implemented as a separate feature. Each module can expose a health endpoint or equivalent signal later, and Host should use a unified health response model across modules when that feature is designed.

### Install failure handling MVP

The first implementation should use a simple optimistic fail-fast install flow without automatic rollback.

If an install step fails, Host should mark the module install as `failed` and keep already created files, directories, downloaded images, and containers for diagnostics. Host should not automatically delete module directories or Docker resources created before the failure.

Retry and cleanup should be explicit administrator actions. A retry should tolerate already existing directories, images, and containers where possible. Cleanup/removal of failed installs can be implemented as a separate explicit operation and should make clear when module data directories may be deleted.

Minimal lifecycle states for the first implementation:

```text
installing
installed
failed
disabled
removing
```

`disabled` means the module remains installed with metadata, settings, and data preserved, but Host should not start its container.

### Module update MVP

Module updates should always refresh the installed module's metadata URL. When an administrator updates a module, Host should download the latest metadata JSON from the stored metadata URL and use that new metadata as the basis for updating the module.

The update flow should:

- download and validate the latest metadata JSON;
- compare it with the locally stored installed metadata;
- show an update plan before changing containers, settings, storage mappings, dependencies, or images;
- apply the update using the new metadata after administrator confirmation;
- save the new metadata as the module's local `metadata.json` after the update is accepted;
- update Docker image/container configuration according to the new metadata.

For the MVP, update failure handling follows the same optimistic fail-fast model as install failure handling. Host should not automatically rollback metadata, containers, directories, or images after a failed update. It should mark the module as `failed`, keep partial state for diagnostics, and require explicit administrator retry or cleanup.

### Host data root path mapping

The first implementation should use explicit host/container data root path mapping.

The CLI knows how it starts the Host container and should pass both paths into the Host container:

```env
HOST_DATA_ROOT_HOST=/Users/example/.docker-host
HOST_DATA_ROOT_CONTAINER=/data
```

The Host backend should use `HOST_DATA_ROOT_CONTAINER` for its own file IO inside the Host container. It should use `HOST_DATA_ROOT_HOST` when computing Docker bind mount source paths for module containers.

Example for module-owned storage:

```text
metadata modulePath:
  data

Host backend state path:
  /data/modules/com.acme.reports/data

Docker bind source path:
  /Users/example/.docker-host/modules/com.acme.reports/data

Module container mount path:
  /app/data
```

All computed bind source paths for `storage.directories` must be derived from `HOST_DATA_ROOT_HOST + modules/<module-id>/<modulePath>`. Metadata files must not provide absolute host paths for module-owned storage.

### Image reference naming

Docker image references should not follow a project-wide naming convention. Module metadata can point to any valid container registry and repository, including Docker Hub, GHCR, an internal registry, or another registry chosen by the module author.

For the Docker Host image itself, the first CLI should default to the image reference produced by the current repository workflow: `ghcr.io/<owner>/<repo>:latest`, with version and SHA tags using the same repository path. There is no need to introduce an additional nested `/docker-host` image path unless the repository later publishes multiple different container images.

The default Host image reference should still be configurable through `docker-host config` and persisted in `launch.env` as `HOST_IMAGE`.

## Open questions

No open questions currently.

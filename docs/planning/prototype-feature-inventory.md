# Prototype feature inventory

This document records useful behavior from the current Docker Host Manager prototype before the rewrite. The prototype implementation may be overwritten, but these capabilities should be considered when rebuilding the product around Host modules.

## Purpose

The current codebase is a direct Docker container management prototype, not the target architecture. The rewrite should not preserve its structure, routes, or data model by default. This inventory exists only to avoid losing proven user-facing and operational behaviors.

## Current prototype scope

The prototype is a full-stack Next.js app that talks directly to Docker through Dockerode. It manages raw Docker containers rather than metadata-defined modules.

Docker connection behavior:

- uses `DOCKER_SOCKET_PATH` when set;
- uses `DOCKER_HOST` when set;
- falls back to `/var/run/docker.sock`;
- returns clearer errors for missing Docker endpoint and permission failures.

## UI capabilities to remember

- Dashboard with sticky header, refresh action, update-check action, and last refresh/update status badges.
- Summary cards for:
  - total containers;
  - running containers;
  - stopped containers;
  - unique images.
- Container table showing:
  - name;
  - image reference;
  - status;
  - uptime/status text;
  - action buttons.
- Per-container actions:
  - start;
  - stop;
  - restart;
  - update image when an update is detected;
  - view logs;
  - open first mapped host port in browser;
  - remove container.
- Expandable container details:
  - configured port mappings;
  - environment variables;
  - inline add/update environment variables.
- Logs dialog:
  - recent log tail;
  - manual refresh;
  - timestamp-aware display when Docker log timestamps are present.
- Create container dialog:
  - name;
  - image and tag;
  - multiple port mappings;
  - multiple environment variables;
  - multiple bind volume mounts;
  - read-only volume option;
  - auto-restart option.
- Loading and pending-action states for long-running Docker operations.
- User-facing Docker connection error banner with socket/container guidance.

## API capabilities to remember

Current endpoints:

- `GET /api/containers` - list all containers.
- `POST /api/containers` - create and start a container.
- `PUT /api/containers` - start, stop, restart, update image, or update environment variables.
- `DELETE /api/containers?id=<id>&force=<bool>` - remove a container.
- `GET /api/containers/{id}` - inspect container details.
- `GET /api/containers/{id}?logs=true&tail=<n>` - return recent logs.
- `POST /api/containers/check-updates` - check whether container images have newer remote digests.
- `GET /api/images` - list local Docker images.
- `POST /api/images` - pull an image by image/tag.

These routes should not be copied as-is into the rewrite. They are useful references for future Host API module endpoints and possible admin/debug APIs.

## Docker behavior to remember

- Container listing maps Docker state into UI-friendly statuses.
- Container detail inspect extracts:
  - image;
  - ports;
  - environment variables;
  - volume binds;
  - restart policy.
- Container creation:
  - pulls the image when missing locally;
  - supports Docker Hub, GHCR, and explicit registry references;
  - supports tag normalization with default `latest`;
  - configures exposed ports and host port bindings;
  - configures environment variables;
  - configures bind mounts with optional read-only flag;
  - configures restart policy.
- Logs use Docker stdout/stderr with timestamps and tail.
- Image listing parses repository, tag, digest-like references, size, and created timestamp.
- Image update check:
  - treats digest-pinned images as pinned;
  - compares local repo digests with remote distribution digest when available;
  - reports update-available, up-to-date, pinned, or unknown.
- Container image update:
  - pulls the current image reference;
  - creates a replacement container preserving most original container configuration;
  - preserves networks, mounts, ports, env, healthcheck, labels, restart policy, and many host config fields;
  - swaps container names after stopping the original;
  - attempts rollback if replacement fails before completion.
- Environment update:
  - merges requested env changes into existing env;
  - recreates the container with updated env;
  - preserves the rest of the container configuration.
- Self-update path:
  - detects when the app is updating its own running container;
  - creates a helper container to complete replacement after the UI process exits;
  - UI waits and retries until the app comes back.

## Features likely to reappear in module model

Near-term:

- module list/status table;
- start/stop/restart module actions;
- logs dialog;
- Docker connection diagnostics;
- status/summary cards;
- open module URL when a module exposes a local/public endpoint later.

Later:

- image update checks and update available indicators;
- update apply flow using replacement container behavior;
- settings/environment editing;
- storage/bind mount configuration;
- local image list/pull tooling for diagnostics;
- self-update or Host update UX, though CLI remains the recovery path.

## Rewrite guidance

- Do not keep direct raw-container management as the primary product model.
- Rebuild UI around installed modules, not arbitrary Docker containers.
- Reuse behavior concepts, not implementation structure.
- Keep Docker operation errors explicit and actionable.
- Continue treating Docker daemon as the source for runtime status.

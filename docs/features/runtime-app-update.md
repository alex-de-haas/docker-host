# Runtime App Update

Created: 2026-06-04
Updated: 2026-07-13

## Description

Runtime app updates are reviewed changes from the currently installed `app.0.1` manifest to a new manifest or source snapshot, including a manifest resolved from the app's followed feed. Core owns the update plan, digest, backup, apply, and failure state.

## Update Flow

1. Core loads the installed app record and current manifest.
2. Core resolves the target manifest from the installed app's stored feed, explicit manifest, or source snapshot.
3. Core creates an update plan with changed version, runtime, services, images, commands, ports, environment keys, settings, endpoints, storage, dependencies, and capabilities.
4. The caller applies the reviewed plan by passing the plan digest.
5. Core creates a `pre-update` backup when the app has a primary data directory.
6. Core applies runtime changes and records the final lifecycle state.

## Digest Semantics

`manifestDigest` is the SHA-256 of the exact manifest JSON text loaded from a local manifest file, local app directory, `file://` URL, or HTTP(S) URL. For a locally installed `dev` runtime app, Core hashes the manifest JSON, not the app source folder or local command working directory.

If an update request does not provide a manifest reference and the app has both `FeedsUrl` and `FollowedFeedId`, Core re-fetches `feeds.json`, validates `app-feeds.0.1`, resolves the followed feed, and loads its current `manifestRef`. Otherwise Core resolves the source in this order: the stored manifest URL for remote direct installs; the original local manifest path or directory captured at install (so edits to the source folder are picked up on recheck); and finally the installed manifest copy under the app's Core state directory when that original source is no longer present.

`planDigest` is the SHA-256 of the reviewed update plan seed: app id, current and target versions, current and target runtimes, current and target manifest digests, whether a pre-update backup will be created, and the reported changes. Update apply re-resolves any followed feed, recomputes the current plan, and rejects stale input when the supplied plan digest no longer matches.

## Changes

The `changes` list is a human-review summary of the update plan. Core reports specific contract changes when it can classify them, such as `version`, `runtime`, `service`, `image`, `command`, `port`, `environment`, `setting`, `endpoint`, `data`, `dependency`, and `capability` changes. When the target manifest digest differs but none of those contract categories changed, Core reports `manifest` as a fallback meaning "manifest content changed." A recheck against the same installed manifest returns an empty `changes` list.

## Update Availability (`update-status`)

`GET /api/apps/{appId}/update-status` is the read-only probe behind the Shell update badge and the fleet "Check updates" action. It resolves the candidate the reviewed plan would use — the followed feed's current `manifestRef` for feed-bound apps, or a refetch of the stored manifest URL for non-feed URL installs — and reports `updateAvailable` when the candidate manifest digest differs from the installed copy or a locked image tag resolves to a different registry digest. Refetching the external manifest matters for candidates that move to new *versioned* image tags: comparing the registry against the installed copy's old tags would report "up to date" forever. Resolution failures degrade to `unknown` fields, never an error, and the installed app is left untouched.

## System Apps

System apps (Shell, Telemetry, Marketplace) update through this same reviewed flow, gated on `host.admin` plus the app's `update` capability. Core startup never applies updates: the boot reconcile installs missing distribution apps, re-applies Hosty-owned provisioning, and migrates a moved http(s) distribution manifest reference (pointer only — no content change, no restart). A Shell self-update briefly restarts the Shell serving the page; the Shell UI warns, keeps the tab alive through the swap, and reloads once the new Shell answers. See [On-Demand System App Updates](../ideas/system-app-updates.md) for the design and its deferred hardening (readiness gate, automatic rollback).

## Live Source Runtimes

A reviewed update does not apply to a **live source** runtime: an app whose selected runtime is a source artifact (`localCommand` in v1) running from the operator's own folder (a `source-override`, or the original folder install) with no recorded manifest URL. For these the manifest is the operator's own contract and is re-read, validated, and adopted on each start — there is no trust boundary to gate, so changes take effect on restart rather than through an update plan (see [Runtime App Marketplace](runtime-app-marketplace.md), "Live source").

Core reports this on the app summary as `live: true`. Clients mark the runtime **Live** and hide the Update affordance; it returns when the operator switches to a compiled (Docker) runtime. When no explicit manifest reference is supplied, `update-plan` for a live source app is refused with `update_live_source_runtime` instead of re-reading and validating the (possibly mid-edit) folder manifest. Passing an explicit `--manifest` path or URL remains available as an escape hatch for an out-of-band comparison. A URL/publisher install is never live source: its code may run live, but its manifest **contract** is still reviewed on change.

## CLI

```bash
hosty apps update-plan <app-id> --manifest apps/demo-app
hosty apps update <app-id> --plan-digest <digest> --manifest apps/demo-app
```

## Failure Behavior

Failed updates leave enough state for diagnosis and retry. Runtime state and app data are not deleted automatically. Restore uses normal app backup restore behavior.

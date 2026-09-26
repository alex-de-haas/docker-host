# Runtime Artifact Extensions

Status: Draft
Created: 2026-07-02
Updated: 2026-09-26

## Goal

Extend the implemented [artifact model](feature.md) without coupling the existing source-development
loop to new delivery mechanisms. This plan retains the unbuilt work from the legacy artifact design.

## Deliverables

- [ ] Add reviewed `git-release` and URL delivery for prebuilt artifacts, with integrity verification,
      bounded downloads, safe extraction and reproducible artifact locks.
- [ ] Detect changed prebuilt delivery content during reviewed update planning even when the manifest
      version is unchanged; include the candidate hash in the reviewed operation.
- [ ] Expose update availability per runtime rather than conflating the active profile and alternatives.
- [ ] Decide whether a demonstrated multi-source use case warrants per-runtime source bindings and a
      unified artifact-state record; preserve app-level source and existing paths until then.
- [ ] Extend reviewed image artifact locks with selected OS/architecture/variant and the execution
      mode or emulation policy needed by [app adaptation](../app-authoring/plan.md). Persist that
      selection with the resolved image identity, distinguish an image-index digest from its chosen
      platform image, and enforce it during install/start/restart/update. Define behavior for legacy
      locks with missing platform information; never silently substitute the new host's default
      platform or enable emulation when the reviewed selection cannot run.
- [ ] Verify the selected extensions, update feature.md and retire this plan when its work is complete.

## Open Questions

Delivery authentication, archive formats and multi-source ownership remain undecided.
Docker build/mount development and mixed source/image profiles are owned by
[Mixed Development Runtimes](../mixed-development-runtimes/plan.md), including Telemetry adoption.
Private source credentials belong to Runtime Source Extensions. No automatic pull,
branch switching, or migration to per-runtime source directories is authorized by this plan.

## Verification

Test artifact integrity, archive containment, offline locked starts, stale update reviews, platform
compatibility, failed materialization cleanup and preservation of existing source/data directories.

Platform-lock acceptance covers a multi-platform image and an amd64-only image on an arm64 host,
explicit native/emulated execution, restart after host changes, unavailable emulation and legacy
locks. The same reviewed platform must be used or startup must fail with an actionable incompatibility;
a matching index digest alone is insufficient evidence of the selected execution platform.

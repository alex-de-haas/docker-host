---
status: In Progress
created: 2026-09-25
updated: 2026-10-29
summary: Remaining child-Core host and runtime acceptance and the separately approved remote preview decision.
components: [apps/core, apps/harness, apps/shell, packages/app-sdk]
---

# Core Environment Acceptance

## Scope

The 2026-10-29 owner decision retains the existing child-Core environment manager and removes
the alternate single-app relay runtime. The [unified environment feature](../unified-sandbox-environments/feature.md)
records that removal, client contracts and Dashboard changes. This plan owns only the remaining
platform matrix and remote-preview decision; it does not restore retired persona, network-relay
or private-browser requirements.

Prior completed deliverables are recorded in the current [feature](feature.md) and dated
[local acceptance](../../reviews/2026-10-15-sandbox-d9-local-acceptance.md),
[child manager](../../reviews/2026-10-14-child-core-manager.md),
[trusted-Core consent](../../reviews/2026-10-15-trusted-core-consent-acceptance.md) and
[cold-engine acceptance](../../reviews/2026-10-15-sandbox-d9-cold-engine-acceptance.md) reports.
Those reports describe their stated baseline; earlier offline-profile observations do not describe
the current environment contract. Deliverable IDs remain stable; all IDs except D9 and D11 are
completed or retired and are not reused.

## Deliverables

- [ ] D9. Verify remaining native Linux-host/Windows, Linux amd64 worker and additional child-Core application/runtime guarantees before claiming them. macOS arm64 and Linux in Docker establish only their measured cases. Preserve current/release/source, ordinary accounts, dedicated dependencies, shared-mount approval, interruption/replay, root-wide quotas and independent Finish checks on each claimed host.
- [ ] D11. Decide and separately approve optional remote preview ingress/private access, then implement and verify it, or explicitly retire it if the owner abandons it. Local delivery does not wait for it.

## Verification

Use supported managed child environments, normal setup/password login and separate test users/data.
Record exact host/architecture, builds, cold/warm startup, native and container resources separately,
failure/recovery observations and owner-driven Finish removal. Keep source and exported reports.
No native Windows/Linux-host or additional recipe support is inferred from Docker acceptance.
Remote preview remains unapproved; its ingress, authorization and exposure need an explicit decision.

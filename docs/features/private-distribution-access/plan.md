---
status: Draft
created: 2026-09-28
updated: 2026-09-28
summary: Authenticate private feeds, release assets and container registries independently of source access.
components: [apps/core]
---

# Private Distribution Access

## Goal

Authenticate distribution resources independently from repository source access. Private repository
manifests and Git sources belong to [private app sources](../private-app-sources/feature.md).

## Deliverables

- [ ] D1. Design authenticated feed and release-asset grants, provider adapters and redirect handling.
- [ ] D2. Design private container registry credential ownership, pull adapters and revocation.
- [ ] D3. Add explicit resource selection and review without inheriting Git credentials.
- [ ] D4. Verify installation/update recovery, multi-account isolation and no credential disclosure.

## Open Questions

- Which feed/release providers and registries ship first?
- Which registry identity belongs to the host runtime, and which belongs to an individual user?
- How do expiring signed downloads and cross-host redirects preserve resource authorization?

## Verification

Test independent repository/artifact grants, denied unrelated hosts, revoked reads and recovery
without stopping already running applications.

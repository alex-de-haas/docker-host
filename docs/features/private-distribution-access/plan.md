# Private Distribution Access

Status: Draft
Created: 2026-09-28
Updated: 2026-09-28

## Goal

Authenticate distribution resources independently from repository source access. Private repository
manifests and Git sources belong to [private app sources](../private-app-sources/feature.md).

## Deliverables

- [ ] Design authenticated feed and release-asset grants, provider adapters and redirect handling.
- [ ] Design private container registry credential ownership, pull adapters and revocation.
- [ ] Add explicit resource selection and review without inheriting Git credentials.
- [ ] Verify installation/update recovery, multi-account isolation and no credential disclosure.

## Open Questions

- Which feed/release providers and registries ship first?
- Which registry identity belongs to the host runtime, and which belongs to an individual user?
- How do expiring signed downloads and cross-host redirects preserve resource authorization?

## Verification

Test independent repository/artifact grants, denied unrelated hosts, revoked reads and recovery
without stopping already running applications.

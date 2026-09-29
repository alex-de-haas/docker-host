# Azure DevOps Pull Request Lifecycle

Status: Draft
Created: 2026-09-29
Updated: 2026-09-29

## Goal

Extend the [GitHub-first PR lifecycle](../assistant-pr-lifecycle/feature.md) to Azure DevOps Services.
The owner agreed on 2026-09-29 to deliver this provider separately. Existing
[user connections](../user-profile-connections/feature.md) and
[private source reads](../private-app-sources/feature.md) do not yet provide PR publication.

## Target Behavior

Reuse Core's managed operation/recovery model, observed development state, shared MCP approval
policy and Harness presentation. Select a concrete user-owned Azure DevOps connection and repository;
map provider-specific PR, review, build-policy and completion facts without assuming GitHub semantics.

## Deliverables

- [ ] Define supported Azure DevOps Services contribution paths and verify existing Entra/PAT
  connections against repository writes, PR operations and observation permissions.
- [ ] Implement publication/update, review/build-policy observation and merge through the shared
  Core services, with durable retry/reconciliation and no exported credentials.
- [ ] Map repository completion requirements and external-review/abandoned outcomes; preserve
  provider/repository identity and independent per-PR results in multi-provider sessions.
- [ ] Verify provider-specific authorization, revocation, policy failures and restart recovery;
  document shipped behavior and remove this plan when all deliverables are complete.

## Open Questions

- Which Azure DevOps contribution/fork topologies and completion strategies ship first?
- Which build/review/release policies and exact artifact references form completion evidence?

## Verification

Use deterministic provider fixtures for retries, partial failures and authorization boundaries.
Verify publish, review/build observation and permitted completion against an operator-authorized
Azure DevOps Services test repository before claiming live provider support.

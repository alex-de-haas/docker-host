---
status: In Progress
created: 2026-09-16
updated: 2026-10-18
summary: Deferred source-override migration assessment after unified ordinary-app dev mode, live data, shared manual and MCP control, and recoverable runtime return.
components: [apps/core, apps/cli, apps/harness, apps/shell]
---

# Development Controls For Existing Apps

## Remaining Goal

Unified ordinary-app development is implemented and verified under the owner's 2026-10-18
approval. Its current contract is in [feature.md](feature.md); the bounded acceptance results,
coverage limits and fixture cleanup are in the
[QA report](../../reviews/2026-10-18-unified-app-dev-mode-qa.md).

The remaining work is D1: assess whether removing source overrides can preserve private/local
source, external-agent and system self-development workflows. This is deliberately outside the
approved ordinary-app implementation. Existing overrides remain available. Do not remove them or
start a migration without a separate owner decision.

## Settled Boundaries

- Ordinary-data dev mode switches the installed app in its existing Core; sandbox preview retains
  its separate child Core, users and data. Do not mount ordinary data into the child.
- Manual controls, CLI, Harness and direct MCP use one Core operation. Existing Ask / Run
  unprompted / Disabled settings govern agent confirmation; they do not grant missing authority.
- Live mutable Git source and profile-defined hot reload remain supported, without a mandatory
  commit or repeated runtime approval for ordinary edits.
- Entry requires a verified backup of managed app data and identifies uncovered external state.
  Return restores runtime/source selection, keeps current data and edits, and never restores data
  automatically. Failed trials remain visible until explicitly retried or returned.
- System applications and unsupported native/mixed/non-Git profiles retain their existing manual
  behavior. Their parity must be assessed before any broader migration.

## Deliverables


Stable D1–D7 IDs are retained; D8–D9 identify the additional trial-specific work.
The approved first scope is D2–D9 for ordinary apps under the decisions above. D1's broader
migration assessment remains explicitly deferred and unchecked; it must not be treated as completed
by ordinary-app acceptance or silently removed when this milestone ships.

- [ ] D1. **Deferred migration assessment:** demonstrate private/local-source, external-agent and system self-development parity before proposing removal of source overrides; obtain separate approval for any non-destructive migration. Existing overrides remain available.
- [x] D2. Implement the settled Q1–Q5 actor/app/action contract for manual and agent entry, ongoing edits and return; reuse current Core authority and shipped MCP Ask / Run unprompted / Disabled, without an additional mandatory browser gate or dependence on future execution-scoped credentials.
- [x] D3. Implement one Core prepare/apply/status/return contract with bounded context reads and expose it through manual UI, CLI, Harness and direct MCP; migrate supported manual controls to the same backend and retain existing unsupported-profile/manual compatibility paths.
- [x] D4. Implement durable enter/return orchestration with prior-state capture, one active trial per installation, exact replay, consumer admission, disconnect/restart recovery and observable partial failures; preserve unrelated source/runtime changes.
- [x] D5. Add manual and Harness entry/return controls, live-data consequences, source/runtime/health/restart state and logs; wire agent tools into existing permission settings and verify both prompted and unprompted execution, preserving Accept locally / Use locally and manual use without a conversation.
- [x] D6. Audit actor, installation, source/manifest revision, approval reference, operation ID, progress/outcome and refusals through existing Core audit infrastructure, without secrets; distinguish approval, execution and observed readiness.
- [x] D7. Verify the selected host/profile/authority matrix and real Harness/browser journey, document shipped behavior and remaining boundaries, regenerate the index and bump affected artifacts when implementation ships; close this plan only when every deliverable is complete.
- [x] D8. Implement live-worktree consumer/writer coordination and cleanup guards; verify uncommitted edits/hot reload against ordinary data, concurrent preview with separate identity/data/caches, prior source/artifact selection restoration and preservation of all source edits without Git reset/discard.
- [x] D9. Integrate verified managed-data backups and explicit external-coverage warnings with the selected policy; verify data compatibility, failed backup behavior, separate reviewed restore and preservation of ordinary data through runtime return.

## Verification For D1

- Inventory actual source-override consumers and supported private/local source paths.
- Demonstrate manual and external-agent source selection without changing ownership or authority.
- Exercise system self-development and recovery independently of ordinary-app runtime switching.
- Preserve existing source, data, runtime selection and recoverable state through any proposed
  migration; document unsupported cases and obtain the owner's migration approval.
- Keep D1 unchecked until its separate assessment and decision are complete. Do not interpret the
  ordinary-app test result as approval to retire existing source overrides.

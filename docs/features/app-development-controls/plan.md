---
status: In Progress
created: 2026-09-16
updated: 2026-10-31
summary: Deferred source-override migration assessment and retained legacy development-request refusal recovery after unified ordinary-app development.
components: [apps/core, apps/cli, apps/harness, apps/shell]
---

# Development Controls For Existing Apps

## Remaining Goal

Unified ordinary-app development is implemented and verified under the owner's 2026-10-18
approval. Its current contract is in [feature.md](feature.md); the bounded acceptance results,
coverage limits and fixture cleanup are in the
[QA report](../../reviews/2026-10-18-unified-app-dev-mode-qa.md). The subsequent
[published-build acceptance](../../reviews/2026-10-18-unified-app-dev-mode-release-qa.md)
passes the real Codex/browser journey on released artifacts, including restart/replay and cleanup.
It does not change D1's scope or approval boundary.

The remaining work includes D1: assess whether removing source overrides can preserve private/local
source, external-agent and system self-development workflows. This is deliberately outside the
approved ordinary-app implementation. Existing overrides remain available. Do not remove them or
start a migration without a separate owner decision.

## Default Workflow And Retained Compatibility (2026-10-18)

The owner selects registered workspaces and child Core sandbox preview as the default development
workflow. The recovered [source-recovery proposal](../runtime-source-workflows/plan.md) stays On Hold;
the [external-client feature](../external-development-workspaces/feature.md) supplies the direct adapters.
D1 must retain private/local/no-Git and system/Harness self-development parity, including dependent
apps and external agents. Evaluate restrictions on host-native localCommand separately from source
runtime support. Clearing obsolete local Source settings is authorized operational cleanup, not
removal of product APIs. The shipped unified live-data dev mode and Return remain supported.

Owner clarification, 2026-10-20: Harness retains Docker and Local as ordinary production runtime
profiles, with Docker as the manifest default. Its
[production-runtime feature](../assistant-shared-docker-runtime/feature.md) records verified packaging and integration.
Development profiles remain separately marked `development: true`; their redesign and general
production-preference persistence belong to platform work. D1 must preserve Local as a supported
production runtime. Harness does not add a per-conversation runtime selector.

## Related Workspace Activation

The separately approved [workspace activation](../workspace-live-activation/feature.md) extends
the shipped controls to reviewed groups of bound apps, including Shell/Harness, and optional Core
selected by configured repository identity. It owns those new source, orchestration and Return
contracts. Its acceptance can inform D1's parity assessment but does not authorize retiring
overrides or close that assessment automatically.

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

## Recorded Pre-admission Refusal (2026-10-24)

A legacy manual dev-apply restart on an active workspace with an editing lease returns
workspace_in_use before runtime replacement, but has already appended a pending receipt and a
recoverable-operation error. The documented generic Restart subsequently refreshes the existing
public-source binding successfully; it does not retire that legacy receipt. Current ordinary app
summaries remain healthy. Preserve the original request and audit evidence; do not edit the
journal, release an active writer lease or replay under a different authority to hide the result.
D10 records the repair separately from the authorized app application and visual-polish batch;
implementation and any required Core restart need their own approval.

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

- [ ] D10. Distinguish a confirmed pre-admission legacy development refusal from an uncertain transition: do not leave a new pending restart receipt/error when workspace admission refuses before lifecycle effects. Preserve original-request recovery after actual admission, lease/source authority checks and runtime/data/Return state. Define a supported, evidence-bound recovery for existing affected receipts without guessing from phase alone or mutating journals manually; verify the retained lease refusal and successful generic Restart path.

## Verification For D1

- Inventory actual source-override consumers and supported private/local source paths.
- Demonstrate manual and external-agent source selection without changing ownership or authority.
- Exercise system self-development and recovery independently of ordinary-app runtime switching.
- Preserve existing source, data, runtime selection and recoverable state through any proposed
  migration; document unsupported cases and obtain the owner's migration approval.
- Keep D1 unchecked until its separate assessment and decision are complete. Do not interpret the
  ordinary-app test result as approval to retire existing source overrides.

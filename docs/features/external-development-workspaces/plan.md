---
status: Draft
created: 2026-10-16
updated: 2026-10-18
summary: Support privileged external agents through convenient managed sandbox operations and factual reconciliation of Git and publication actions.
components: [apps/core]
---

# External Development Through Hosty

## Recovery And Current Baseline (2026-10-18)

This is a recovered Draft, not the earlier completed plan at this path. Its local D1-D6 labels
collided with retired deliverables; they are recorded here as D7-D12 respectively. The current
workspace API already links external PRs and exposes authorized provider observations. Sandbox
and child Core services, Harness integration and unified ordinary-app dev mode have also shipped.
The remaining proposal concerns direct-client adapters and broader reconciliation acceptance,
not reimplementation of those services. Re-verify gaps before promoting implementation to Ready.
The normal workflow now uses registered worktrees and sandbox preview. Live-data dev mode remains
a separately authorized operation, and a privileged external client's native actions remain facts
to observe rather than evidence of a Core-executed mutation.

## Goal And Owner Direction

[Vision decision 46](../../vision.md) describes a supported external-agent development journey:
connect to Hosty, request managed source, edit the returned worktree, add authorized dependent apps,
run sandbox instances, inspect browser previews, publish PRs, follow CI/review and finish through
Core. Source-based execution remains. Removing native localCommand, arbitrary overrides or the
current installed-app dev workflow is conditional on later acceptance and a separate migration
decision owned by [Development Controls D1](../app-development-controls/plan.md#deliverables).

This Draft records missing client integration; it does not approve implementation or change the
shipped child Core service in [Sandbox](../app-sandbox-runtimes/feature.md).

## Usage And Trust Clarification (2026-10-16)

[Vision decision 47](../../vision.md) makes the built-in constrained assistant the normal path,
especially for remote and restricted operators. This external path is an infrequent privileged
local-owner workflow. The external agent follows Hosty instructions for source preparation,
sandbox operations and lifecycle, but can still edit files, run Git or publish through its own
authorized provider tooling. Exact adherence to the managed path is not a prerequisite for truthful
workspace state. Native privileges do not enlarge its Core credential's permissions.

Prioritize an easy, documented sandbox path over enforcing exclusive mediation of all external
actions. D9 retains managed publication as a useful client capability, not a prerequisite for
sandbox adoption or a condition of recognizing externally created PRs. D12 owns verification and
any missing reconciliation needed for those actions. Internal restricted-agent enforcement remains
with Containment and Execution Authorization; this plan does not weaken it.

## Existing Foundation And Required Difference

[External workspaces](feature.md) already provide direct MCP source preparation, owned worktrees,
Git operations, durable request identities, leases and cleanup checks. One external principal/task
groups repository worktrees without a Harness conversation. Compatible apps from one repository
reuse its tree; another repository adds a child. The returned path is on Core's host, not an
automatic remote filesystem mount. Native edits are observed without transferring ownership to
an external client's private worktree manager.

The existing workspace grant does not authorize sandbox control or PR publication. The
[PR lifecycle](../assistant-pr-lifecycle/feature.md) currently exposes its managed operations through
assistant-session contracts; recording a PR URL on an external workspace does not publish it.
Sandbox's shipped general service supports app/operator clients and Harness adapters; a direct
external credential needs an explicitly defined integration with the same service.

Add direct external-client adapters and ownership/authority handling, not new source, sandbox or
publication engines. Reuse the stable external principal, Core records and operation replay rules.
Never impersonate an installed assistant, issue its service token to an external client, or treat
a task/workspace ID as authorization. Private-source, target-app and publication-connection checks
remain applicable; cross-owner substitutions must fail.

The intended sequence is prepare source → edit → plan/prepare/start sandbox → open/test preview →
export evidence and finish sandbox → publish/fix/review/merge under user/repository authority →
finish eligible workspace work. Sandbox disposal and source cleanup have separate lifetimes.
Worktrees remain while dirty, leased, unmerged or consumed; installed apps retain their normal
runtime, source and data throughout. A source-based Docker recipe supplies execution without an
installed-app override. Missing recipes or unsupported dependencies have explicit outcomes.

MCP governs managed operations. It does not restrict an external native editor's OS access to the
returned directory or prove that its processes stopped. Consume leases/consumer observations and
the existing cleanup rules; stronger execution containment has its own owner.

## Reconcile Facts Independently Of Their Origin

Git/worktree observations establish local edits, commits, refs and ancestry regardless of which
client changed them. Use the authorized source provider for PR identity, CI, review and merge
observations. Bind those facts to the canonical repository, branch and relevant commit; do not
infer a PR or a successful check from a local commit alone.

The current external workspace API can record PR references, and the inspection path uses known
publication records and authorized provider observations. That is not proof that every arbitrary
externally created PR is discovered automatically. Under D12, verify discovery or explicit linking
and refresh for external owners, including forks, multiple candidates and unavailable credentials.
Show stale/unknown observations honestly and avoid duplicate PR creation after reconciliation.
Do not fabricate a Core-executed mutation from an observed external action. Existing cleanup and
publication authority still apply even when Git/provider facts were produced outside Core.

## Deliverables

- [ ] D7. Define the direct external-client sandbox/publication authority, owner binding, supported operations, credential/revocation rules and compatibility with existing workspace grants; obtain approval before implementation.
- [ ] D8. Adapt the existing Core sandbox service to the approved direct-client contract, including owned input selection, operation replay, readiness, preview/test evidence and disposal, with a documented ordinary-use sequence and actionable errors, without requiring Harness or rewriting installed-app source.
- [ ] D9. Adapt existing Core publication and CI/review/completion services to approved external owners and provider connections, preserving repository authority, exact-head checks and replay/observation behavior without native-CLI credential workarounds.
- [ ] D10. Verify an external-client journey across same-repository apps and an additional dependency repository, browser testing, PR correction, CI/review, reconnect/revocation and consumer-aware cleanup; compose with the development-session umbrella acceptance.
- [ ] D11. Update the external-agent setup/workflow and current feature documentation, bump affected implementation artifacts, remove this plan and regenerate the index when all deliverables pass.
- [ ] D12. Verify and complete reconciliation of native edits/commits/pushes and externally created PRs for external workspace owners, using Git and authorized provider facts with verified discovery/linking, observation freshness and honest unknown states; preserve audit attribution, replay and cleanup guards.

## Open Questions

- Which separately reviewed scopes and consent surface cover sandbox and publication operations?
  Reuse [execution authorization](../assistant-execution-authorization/plan.md) where applicable
  without making its broader future execution model an unexamined prerequisite.
- Which client/host combination demonstrates the first full external journey, and what source,
  recipe and dependency cases establish parity before considering retirement of existing controls?

## Verification And Dependencies

Sandbox owns instance execution, identity, synthetic data, resource limits and preview. PR lifecycle
owns publication/provider semantics. This plan verifies their direct-client boundary; it does not
duplicate their deliverables or claim those adapters exist today. Workspace lifecycle retains its
existing cleanup and later close/revocation coordination.

Test absent/wrong/revoked scopes, owner and connection substitution, private-source revocation,
stale installation/input/HEAD, duplicate requests and unknown outcomes. Exercise a real authorized
external client against a Core-managed host with normal browser login. Verify exact checkout and
runtime identities, synthetic data separation, preview readiness, publication facts and retained
source when cleanup is blocked. Keep installed-app overrides unchanged. Run affected Core/MCP
tests and builds plus version/documentation validation; record untested platforms honestly.

Exercise a documented sandbox journey without handcrafted Docker commands or changes to the live
app. Repeat publication via an independently authorized external tool, reconcile its PR and current
CI/review through Core, then verify no duplicate publication or false managed-operation audit.
Unavailable provider access must not erase local Git observations or imply a successful remote check.

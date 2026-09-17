# App Development Controls

Status: Draft
Created: 2026-09-16
Updated: 2026-09-17

## Goal

Let an operator ask the assistant to change an existing source-capable app, inspect its development
state, enter the correct source runtime, iterate, and deliberately leave development. This is the
control-plane companion to [app authoring](../app-authoring/plan.md).

## Current And Target Behavior

[Source workflows](../runtime-source-workflows/feature.md) provide source resolution/override and
reviewed runtime switching. Development belongs to a declared `development: true` profile; there is
no independent toggle. A key named `dev` is insufficient without that marker. Commands define reload
behavior. The profile declaration and source-preservation contract live in source workflows.

The owner approved prioritizing existing applications before prototype creation on 2026-09-16.
The next acceptance loop is: select a development profile → grant the assistant source access →
change visible app content → inspect the result and source diff → explicitly discard the selected
Git changes → verify the original content and clean status. Use an ordinary app and a clean isolated
checkout, preserving unrelated operator work. This approval does not settle the authority contract below.

Recommended tool family (names are not shipped API):

| Operation | Required result/behavior |
| --- | --- |
| `get_app_development_context` | Profiles, declared development capability, resolved source/manifest paths, source state and failure reasons |
| `plan_app_runtime_switch` / `apply_app_runtime_switch` | Existing plan/digest semantics, data compatibility and settled result |

Use the implemented source status, diff and explicit Git discard from
[source workflows](../runtime-source-workflows/feature.md) for existing apps. Core does not
invent session checkpoints, automatically commit work, or promise source recovery without Git.

## Authority Is Part Of The Feature

The built-in assistant's delegated `hosty:core` token cannot invoke the already shipped lifecycle or
update mutations. Adding tool names alone cannot make the new controls usable there. External
read-only/facade clients must not gain writes as a side effect either.

Use the app/action-scoped authority owned by
[assistant approval rules](../assistant-approval-rules/plan.md) for the built-in assistant. That feature
verifies a Core-enforced grant or narrow trusted execution bridge; this feature extends the contract
to runtime-switch actions. Broad CLI approval is only the current manual fallback,
not the normal autonomous development path. Do not add write scopes to all delegated tokens,
infer write power from an admin role on a read-only credential, or expose the host control secret.
Do not expand the meaning of existing `mcp:lifecycle` silently; choose and document standing-grant
semantics for these more powerful source/runtime changes.

## Enter, Edit, Leave

Inspect → resolve/attach source → capture the current runtime and Git baseline → review/apply a declared
development profile → verify the effective working directory and Core health → bind the session → edit/test.
Re-read state between operations; this sequence is not atomic. Selecting contextual apps alone grants
neither writes nor command execution.

Leaving development selects a reviewed profile while preserving source. Pinned source starts refuse
dirty checkouts; Docker switching leaves source intact. Git discard is a separate explicit operation,
not a side effect of switching runtime. No-Git source has no promised rollback baseline. Hot reload
depends on the profile commands; other changes need a deliberate restart.

Do not automatically cycle the gateway hosting the editing session or promise seamless system-app
self-editing. A failed runtime-switch restart restores the prior selection and leaves the app stopped.
Data compatibility and backup/restore decisions remain distinct from source discard.

## Deliverables

- [ ] Decide the authorization route, scope semantics and public tool/CLI contract; make the built-in
      assistant path explicit before claiming MCP-based development works there.
- [ ] Implement bounded development-context reads and runtime-switch MCP wrappers with honest
      mutation annotations and Core-enforced grants; reuse the existing runtime-switch CLI.
- [ ] Compose existing source APIs with enter/edit/leave orchestration, preserving prior settings,
      shared source-loss warnings/Git choices and partial-failure state. Reuse the general session
      source binding from assistant approval rules; do not introduce a prototype-only binding.
- [ ] Expose an Edit with assistant entry point and effective source/runtime state, including absent
      source/profile, non-source runtimes, restart requirements and partial-failure results.
- [ ] Audit each new mutation's actor, target, outcome and reviewed operation reference without
      credentials. Compose with [Core MCP audit work](../core-mcp/plan.md), without duplicating it.
- [ ] Verify permission, failure and data-compatibility cases, update affected feature documentation,
      remove this plan, regenerate the index and bump affected release artifacts.

## Phases And Open Questions

One feature PR: contract/authority → service wrappers and CLI → assistant/UI orchestration → live
verification. Open decisions: which authority route above; exact scope name and audience; whether initial scope excludes system-app editing entirely. Initial
recommendation is ordinary user apps, with system-app capability reported but automatic cycling absent.

## Verification

Test read-only versus authorized direct callers, delegated/facade refusals, stale runtime digests,
data-incompatible switches, source-less apps, dirty managed checkouts and no-Git local folders.
Verify interruption leaves observable recoverable state, not an invented rollback success.
Live: switch an ordinary Docker app to a declared development profile, edit/view through Shell,
inspect the diff, explicitly discard the selected Git changes and verify the original page and clean
worktree. Return to the prior runtime with unrelated local work preserved. Never start a second Core for validation on the same host.

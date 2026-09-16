# App Development Controls

Status: Draft
Created: 2026-09-16
Updated: 2026-09-16

## Goal

Let an operator ask the assistant to change an existing source-capable app, inspect its development
state, enter the correct source runtime, iterate, and deliberately leave development. This is the
control-plane companion to [app authoring](../app-authoring/plan.md).

## Current And Target Behavior

[Source workflows](../runtime-source-workflows/feature.md) already provide source resolution/override
and digest-reviewed runtime switching. Core/Shell expose a per-runtime Development Mode toggle, but
the CLI has no dedicated toggle and Core MCP has neither development nor runtime-switch tools.

Add discoverable typed operations around those existing services. A runtime profile named `dev` is
not sufficient evidence: inspect runtime type, artifact kind, source availability and effective
Development Mode. `development` is a default for the operator's per-runtime setting. Docker images
and prebuilt artifacts do not gain editable source by toggling a flag; a compatible source profile
must exist. Generating a missing profile is a separate reviewed app-source change.

Recommended proposed tool family (names are not shipped API):

| Operation | Required result/behavior |
| --- | --- |
| `get_app_development_context` | Profiles and source capability, effective mode, canonical source/manifest location, provenance, current runtime and relevant failure reasons |
| `plan_app_runtime_switch` / `apply_app_runtime_switch` | Existing Core plan/digest semantics, data compatibility and final runtime result |
| `set_app_development_mode` | Explicit app, profile and boolean; return backup/restore hint, whether restart happened or is still needed, and settled state |

Add a dedicated CLI toggle using the same Core service. Source mutation tools can follow only where
needed; v1 can retain the existing trusted CLI source commands. If a toggle acquires plan/apply
semantics, implement that contract in Core first, not as an MCP-only imitation.

## Authority Is Part Of The Feature

The built-in assistant's delegated `hosty:core` token cannot invoke the already shipped lifecycle or
update mutations. Adding tool names alone cannot make the new controls usable there. External
read-only/facade clients must not gain writes as a side effect either.

Use the app/action-scoped authority owned by
[assistant approval rules](../assistant-approval-rules/plan.md) for the built-in assistant. That feature
verifies a Core-enforced grant or narrow trusted execution bridge; this feature extends the contract
to development-mode/runtime-switch actions. Broad CLI approval is only the current manual fallback,
not the normal autonomous development path. Do not add write scopes to all delegated tokens,
infer write power from an admin role on a read-only credential, or expose the host control secret.
Do not expand the meaning of existing `mcp:lifecycle` silently; choose and document standing-grant
semantics for these more powerful source/runtime changes.

## Enter, Edit, Leave

Inspect → resolve/attach source → capture current runtime/mode and reviewed baseline → enable the
target source profile's Development Mode where appropriate → review/apply the runtime switch →
verify the effective working directory and Core health → bind the authoring session → edit/test.
Enabling a non-selected source profile before switching avoids starting it in a mode that resets
the intended source. Re-read state between operations; do not present the sequence as atomic.

Leaving development offers concrete choices: keep local work, return to the previous runtime, or
prepare publication. Turning the flag off does not commit, push or release. Reuse the source-loss warnings and assisted
Git workflow owned by [prototype workspaces](../app-prototype-workspaces/plan.md) before a pinned-start
path: managed pinned checkouts can discard tracked edits and untracked files. Present the risk and
operator choices; do not add Hosty snapshots, automatic stashes/commits or a second Git writer.
A no-Git app without a reviewed source baseline must not be promised a recoverable pinned state.

Reuse Core's actual behavior: a failed runtime-switch start restores the selected profile but leaves
the app stopped; Development Mode changes on system apps defer lifecycle to the next start; a risky
disable may return a data-restore hint and leave the app stopped. Show those results faithfully.
Do not automatically cycle the gateway hosting the active editing session or promise seamless
self-editing. HMR is a property of the app's dev server, not a guarantee from the mode flag.

## Deliverables

- [ ] Decide the authorization route, scope semantics and public tool/CLI contract; make the built-in
      assistant path explicit before claiming MCP-based development works there.
- [ ] Implement bounded development-context reads and dedicated CLI toggle; add runtime-switch and
      development-mode MCP wrappers with honest mutation annotations and Core-enforced grants.
- [ ] Compose existing source APIs with enter/edit/leave orchestration, preserving prior settings,
      shared source-loss warnings/Git choices and partial-failure state. Reuse the general session
      source binding from assistant approval rules; do not introduce a prototype-only binding.
- [ ] Expose an Edit with assistant entry point and effective source/runtime state, including absent
      source/profile, non-source runtimes, system-app deferred restart and restore-hint results.
- [ ] Audit each new mutation's actor, target, outcome and reviewed operation reference without
      credentials. Compose with [Core MCP audit work](../core-mcp/plan.md), without duplicating it.
- [ ] Verify permission, failure and data-compatibility cases, update affected feature documentation,
      remove this plan, regenerate the index and bump affected release artifacts.

## Phases And Open Questions

One feature PR: contract/authority → service wrappers and CLI → assistant/UI orchestration → live
verification. Open decisions: which authority route above; exact scope name and audience; whether a
toggle needs a reviewed plan; whether initial scope excludes system-app editing entirely. Initial
recommendation is ordinary user apps, with system-app capability reported but automatic cycling absent.

## Verification

Test read-only versus authorized direct callers, delegated/facade refusals, stale runtime digests,
data-incompatible switches, source-less apps, dirty managed checkouts and no-Git local folders.
Verify interruption leaves observable recoverable state, not an invented rollback success.
Live: switch an ordinary Docker app with a declared source profile, edit/view through Shell, return
to the prior runtime and preserve local work. Assert backup/restore hints and system-app deferred
restart behavior independently. Never start a second Core for validation on the same host.

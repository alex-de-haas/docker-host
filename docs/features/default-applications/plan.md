---
status: Draft
created: 2026-10-08
updated: 2026-10-08
summary: Core-owned default application choices for supported roles and provider interfaces, beginning with shared assistant selection and coordinated shell resolution.
components: [apps/core, apps/shell, apps/plans, packages/app-sdk]
---

# Default Applications

## Owner Direction And Goal

On 2026-10-08 the owner agreed to move default assistant selection from a Shell-only preference
to Core and explore an operating-system-style Default applications settings area. Select an app
for a supported role or provider interface, rather than adding a setting for every installed app.
See [platform vision decision 22](../../vision.md). This records direction, not implementation approval.

Shell and assistant are the initial categories. A category can support a preferred provider without
preventing other installed providers from working. Defaults make sense where a caller needs one
choice; they must not turn fan-out capabilities into exclusive providers.

The owner subsequently chose Workspaces as an ordinary UI, without a provider role. Do not add a
workspace-provider category merely to navigate to it. Plans also remains an ordinary app unless the
separate [plan-provider exploration](../plan-provider-interface/plan.md) establishes a real contract.
Default agents and other categories were mentioned as possibilities, not settled requirements.

## Existing Behavior And Related Work

Core already discovers confirmed [assistant and speech providers](../provider-consumption/feature.md).
Shell owns its assistant preference in a browser cookie scoped to Core and user. That choice does
not currently define a shared default for other consumers. Core's shell destination still resolves
the installed first-party Shell; replacing that lookup is owned by
[replaceable UI clients](../replaceable-ui-clients/plan.md).

This direction supersedes the 2026-09-26 rule in the
[core extension model](../core-extension-model/plan.md) that assistant selection belongs only to
each UI client. Preserve the distinction between provider declarations, consumer permissions and
preferences. A preference neither grants access nor registers an unsupported contract.

## Candidate Behavior

Core stores preferences and resolves a compatible, accessible choice. Shell renders their settings
through Core's API; other clients consume the same state. Select by stable app/interface identity,
resolving current endpoints from the registry rather than persisting browser URLs.

Define a host-level fallback and possible per-user overrides. The pre-login shell destination
requires a host-level answer; authenticated assistant preferences can be personal. The exact scope,
precedence, migration and failure policy remain design questions, not established behavior.

Explicit destinations always win over defaults: a workspace session opens in its owning assistant,
and a referenced plan stays with its provider. Defaults apply to new or otherwise unbound requests.
An unavailable or incompatible selected assistant must not silently receive a substitute handoff.
Consumers must check required capabilities such as attachments for document discussions.

Coordinate shell storage/resolution with the existing UI-client plan, which owns those deliverables.
Its draft earliest-installed fallback is not automatically the assistant policy. Reconcile that
proposal with the common settings design before either plan becomes Ready. Keep source authority,
session ownership and independent app lifecycles unchanged by preference updates.

## Deliverables

- [ ] D1. Specify preference categories, host/user scope, precedence, compatibility checks and unavailable/removed-provider behavior; coordinate shell semantics with its owning plan.
- [ ] D2. Add shared Core storage and a permission-aware assistant-default resolution API plus SDK access, without granting provider authority through preferences.
- [ ] D3. Add the Default applications settings surface and migrate Shell's assistant preference deliberately, without importing another user's browser choice.
- [ ] D4. Make Shell and eligible assistant consumers such as Plans honor the shared assistant choice while preserving explicit targets and capability checks.
- [ ] D5. Verify persistence, multiple users/providers, grant changes, removed/stopped/incompatible apps, explicit session ownership and the agreed migration behavior; document the result.

## Open Questions

- Which settings are host-wide and which allow user overrides? Who may edit each scope?
- How is a browser-local preference offered for migration when multiple browsers disagree?
- Should an unconfigured single provider be selected automatically, and how is ambiguity shown?
- How should one settings screen compose the shell selection owned by the UI-client feature with
  shared provider preferences without creating duplicate settings or deliverables?

## Verification

Exercise two compatible assistants, an incompatible interface and missing required capabilities;
verify that changing the default never moves existing conversations or provider-bound references.
Check Core restart, independent browser sessions/users, access revocation and app removal. Verify
the settings and consumer flows through Core-managed app identity. Cross-reference the UI-client
plan for shell routing tests; this Draft does not authorize implementing either plan.

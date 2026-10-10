---
status: Draft
created: 2026-09-27
updated: 2026-10-10
summary: Let users hide app-provided panel entries in Shell and restore them later.
components: [apps/shell]
---

# User-Controlled Panel Visibility

## Goal

Owner discussion, 2026-09-27: let users hide unwanted app-provided panel entries and find and restore
them later, including the built-in assistant panel when using another UI for the same backend.
This is a Shell presentation preference, independent of app installation and backend lifetime.

## Target Behavior

Relative to [feature.md](feature.md), which currently displays declared panel entries and supports
collapsing the selected body, add per-user visibility control over individual panel entries.
Keep a discoverable list of hidden entries with a restore action. Hiding must not revoke app grants,
stop a backend, delete sessions or change which assistant handles Shell requests.

## Shared Panel-System Coordination

Owner direction, 2026-10-10: the [SDK panel system](../sdk-panel-system/plan.md) owns the shared
rail/host and the first Plans → assistant scenario in Shell and standalone. This plan continues to
own hide/restore preferences and hidden-target behavior; it does not own a second panel renderer.
Implement visibility through that host's catalog/presentation hooks if it ships first. Coordinate
D1 with its `{ appId, installationId, panelId }` reference rather than creating another label/index
key. The SDK plan now specifies optional explicit `ui.panels[].id`, deterministic legacy IDs and
unambiguous installation-local aliases. Consume that identity/migration contract here; do not
duplicate its Core implementation. Explicit IDs survive label/path changes, while reinstallation
resets the installation scope. Hide/restore storage and the hidden-target policy still belong here.

This plan's original Shell preference scope remains unchanged. Whether standalone hosts share or
have separate visibility preferences needs an explicit decision before widening that scope; the
SDK host alone does not make local Shell preferences global. Hiding a tool must never cause an
explicit finalized handoff to be recreated at another provider. D3 owns the reveal/restore policy.

## Deliverables

- [ ] D1. Define and implement persisted per-user, per-host visibility preferences with stable panel
  identity across app updates and a way to hide individual entries.
- [ ] D2. Add an accessible hidden-panels list and restore controls, including recovery when all entries
  are hidden.
- [ ] D3. Define and implement explicit-open behavior for assistant handoffs, shortcuts, deep links and
  attention indicators when the target panel is hidden, without silently rerouting work.
- [ ] D4. Verify preferences, multiple panels per app, updates/removal/reinstall and keyboard behavior;
  update feature.md, remove this plan and regenerate the index when complete.

## Open Questions

- Where do hide/restore controls live, and where are the preferences stored?
- Does an explicit open temporarily reveal a hidden panel or ask to restore it? How should attention
  from hidden panels appear without undoing the user's preference?

## Verification

Two users can choose different visibility on the same host. A hidden panel can be found and restored
with keyboard controls, including after all panels are hidden. Hiding an assistant UI preserves its
backend and sessions. An explicit handoff is neither lost nor sent to a different assistant because
its intended panel is hidden.

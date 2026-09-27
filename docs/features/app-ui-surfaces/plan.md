# User-Controlled Panel Visibility

Status: Draft
Created: 2026-09-27
Updated: 2026-09-27

## Goal

Owner discussion, 2026-09-27: let users hide unwanted app-provided panel entries and find and restore
them later, including the built-in assistant panel when using another UI for the same backend.
This is a Shell presentation preference, independent of app installation and backend lifetime.

## Target Behavior

Relative to [feature.md](feature.md), which currently displays declared panel entries and supports
collapsing the selected body, add per-user visibility control over individual panel entries.
Keep a discoverable list of hidden entries with a restore action. Hiding must not revoke app grants,
stop a backend, delete sessions or change which assistant handles Shell requests.

## Deliverables

- [ ] Define and implement persisted per-user, per-host visibility preferences with stable panel
  identity across app updates and a way to hide individual entries.
- [ ] Add an accessible hidden-panels list and restore controls, including recovery when all entries
  are hidden.
- [ ] Define and implement explicit-open behavior for assistant handoffs, shortcuts, deep links and
  attention indicators when the target panel is hidden, without silently rerouting work.
- [ ] Verify preferences, multiple panels per app, updates/removal/reinstall and keyboard behavior;
  update feature.md, remove this plan and regenerate the index when complete.

## Open Questions

- Where do hide/restore controls live, and where are the preferences stored?
- Does an explicit open temporarily reveal a hidden panel or ask to restore it? How should attention
  from hidden panels appear without undoing the user's preference?
- Which stable identity survives a changed panel label/path, and when does reinstall reset a preference?

## Verification

Two users can choose different visibility on the same host. A hidden panel can be found and restored
with keyboard controls, including after all panels are hidden. Hiding an assistant UI preserves its
backend and sessions. An explicit handoff is neither lost nor sent to a different assistant because
its intended panel is hidden.

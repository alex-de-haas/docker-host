---
status: Draft
created: 2026-06-12
updated: 2026-10-05
summary: Age-based cleanup rules and per-app retention overrides for app data backups.
components: [apps/core, apps/shell]
---

# App Data Backup Retention — Policy Extensions

Retention today uses global defaults ([feature.md](feature.md)): manual backups are kept until
explicitly deleted, and the automatic `pre-update`, `pre-restore`, `pre-runtime-switch` and
`scheduled` backups keep the latest five per app. Carried over from `docs/ideas/` on 2026-10-05; no
concrete product need has been identified yet, which is why this stays Draft.

## Target Behavior

- Retention rules can also expire backups by age, not only by count.
- An app can override the global retention policy.

The conservative default policy stays unchanged unless a change to it is approved explicitly.
Cleanup keeps verifying that every candidate path stays under the Hosty backup root, and cleanup
apply keeps requiring a reviewed plan digest.

## Deliverables

- [ ] D1. Age-based cleanup rules alongside the count-based ones.
- [ ] D2. Per-app retention overrides, editable where the app's backups are managed.

## Open Questions

1. Which product need justifies either rule, and what should its default be?

## Verification

- Cleanup preview lists exactly the backups the configured rules select, and apply refuses a stale
  plan digest.
- `npm run core:test` covers the new rules, including paths outside the backup root.

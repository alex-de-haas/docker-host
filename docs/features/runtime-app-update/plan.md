---
status: Draft
created: 2026-07-10
updated: 2026-10-05
summary: Harden reviewed updates with staged apply, automatic rollback, immutable Shell image tags, Core compatibility ranges and a skew notice.
components: [apps/core, apps/shell]
---

# Runtime App Update — Hardening

System apps update through the same reviewed, plan-first flow as every runtime app, and Core startup
never applies updates ([feature.md](feature.md)). The first increment of the on-demand system-app
update design shipped on 2026-07-13; this plan carries its deferred hardening, moved from
`docs/ideas/system-app-updates.md` on 2026-10-05.

## Target Behavior

- **Staged apply.** Apply prepares the exact reviewed artifact — pulls the image or materializes the
  bundle — before stopping the app. An unresolved target for a critical system app is refused rather
  than stopping the working version.
- **Automatic rollback.** If the updated app fails to start or never becomes ready, Core restores the
  previous manifest, record and artifact locks and restarts the previous pinned artifact. The
  pre-update backup covers only the data directory, so rollback needs an explicit app-data policy
  for a new version that has already migrated data.
- **Immutable Shell image tags.** The Shell image workflow publishes a semantic-version tag alongside
  `latest` and `sha-<commit>`, the released Shell manifest references the tag matching its
  `version`, and the moving manifest is published only after every artifact it references exists.
- **Compatibility range.** A candidate manifest can declare the Core versions it supports, and update
  planning reports a candidate outside the running Core's range instead of offering it.
- **Skew notice.** Because startup no longer drags system apps forward, an operator is told when a
  Core update leaves installed system apps behind.

## Deliverables

- [ ] D1. Staged apply: prepare the reviewed artifact before stopping the app, and refuse an
      unresolved target for a critical system app.
- [ ] D2. Automatic rollback on failed start or readiness, with the app-data policy decided first.
- [ ] D3. Semantic-version Shell image tags referenced by the released Shell manifest, with the
      manifest published only after its artifacts.
- [ ] D4. A Core compatibility range in the manifest contract, enforced by update planning.
- [ ] D5. A notice when Core's version moves ahead of installed system apps.

## Open Questions

1. What happens to app data when an update that already migrated data is rolled back?
2. Which field carries the compatibility range, and is it required for system apps?

## Verification

- An update whose image cannot be pulled leaves the running version untouched.
- An update whose new version fails readiness ends with the previous version running and the failure
  recorded on the app.
- `npm run core:test`, `npm run shell:test` and `node scripts/check-versions.mjs` pass.

---
status: Draft
created: 2026-11-03
updated: 2026-11-04
summary: Decide app-data rollback, declare Core compatibility ranges and report app compatibility after Core updates.
components: [apps/core, apps/shell]
---

# Runtime App Update Recovery And Compatibility

## Scope And Ownership

On 2026-11-03 the owner accepted separating the unresolved hardening from
[ready app releases and update sources](../runtime-app-update/feature.md). This plan owns the transferred
D2, D4 and D5 with their original IDs. They remain unimplemented and are not removed from tracked work.
New work here allocates above D5; D1/D3 are delivered by the ready-release implementation and are not reused.

The implemented reviewed update flow is described in [Runtime App Update](../runtime-app-update/feature.md).
The ready-release implementation provides artifact readiness, pre-stop preparation, publication and source migration.
This plan adds behavior after startup or across Core/app compatibility and needs separate approval
once the questions below are resolved. It grants no implementation or live recovery authority.

## Target Behavior

- **Automatic rollback:** when the new app fails startup/readiness, restore the previous manifest,
  record and artifact locks and restart its pinned artifact only under an explicit data-compatibility
  policy. A binary rollback must not silently restore or discard user data after migration.
- **Core compatibility:** a generic manifest contract can declare supported Core versions. Update
  planning distinguishes unsupported Core from artifact publication/access failure and refuses an
  incompatible candidate. The implemented digest manifest schema does not decide
  this general version-range contract. Existing app.0.1 installations need an explicit default policy.
- **Skew notice:** after a Core update, report relevant app compatibility/update information without
  treating independently versioned app/Core numbers as a compatibility matrix. Core stays usable
  with no standard apps; no installed app is required solely by ID or distribution provenance.

## Deliverables

- [ ] D2. Implement automatic rollback on failed startup/readiness after deciding backup coverage,
      already-migrated data handling, explicit operator intervention and interrupted recovery.
- [ ] D4. Define and enforce a Core compatibility range in the generic manifest contract, including
      its relationship to schemaVersion, legacy defaults and actionable update diagnostics.
- [ ] D5. Provide a notice when a Core update leaves installed apps requiring compatibility attention
      or an available update, using declared compatibility and actual release state rather than
      relative version numbers or hard-coded system app identities.

## Open Questions

1. What is safe automatic behavior when the new app has migrated managed data, written external
   mounts or changed a shared dependency before readiness fails? Which situations require the operator?
2. Which manifest field and version-range syntax carry Core compatibility, how is it versioned, and
   what does absence mean for existing apps? How are lower/upper bounds and prereleases interpreted?
3. Which compatibility conditions warrant the D5 notice, where is it shown, and how is it cleared
   without equating a missing newer release or a registry outage with incompatibility?

## Verification

- Preserve current data and recovery evidence through failed readiness, partial migration and
  interrupted rollback; restore nothing outside the agreed backup/data policy.
- Test declared compatible/incompatible/absent ranges, schema support, prereleases, ordinary
  third-party apps and an empty registry. Publication failure remains a separate diagnosis.
- Verify Core-update notices against actual compatibility and release state, recovery after app
  updates and source changes, and operation without Shell or other standard distribution apps.
- Run affected Core/Shell checks and managed sandbox recovery scenarios after the plan is approved;
  update the owning feature documentation and remove this plan when all retained work is delivered.

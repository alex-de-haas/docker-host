# App Secrets Store

Status: Draft
Created: 2026-09-06
Updated: 2026-09-06

## Goal

Track the follow-ups the promoted design (ratified 2026-07-22, since folded into
[feature.md](feature.md)) named as future work, so they exist as deliverables rather than as a
prose list. None of them is committed; this plan is where they wait, and it stays Draft until one
is shaped and approved.

## Target Behavior

Diff against [feature.md](feature.md):

- `secrets.json` is encrypted at rest under one Core master key, in the same pass that covers
  `secret: true` settings in `state.json` and the Cloudflare credential store; the document's
  `schemaVersion` bump is the migration.
- A Core-state backup, if one exists by then, carries app secrets encrypted so a whole-machine
  migration keeps working connections instead of forcing every app into reconnect-required.
- `hosty apps secrets list <appId>` prints key names only, as a diagnostic.
- Secret change events, only if a consumer needs reactive reloads; none does today.

## Deliverables

- [ ] Platform-wide at-rest encryption pass (one Core master key, the durable
      `AppServiceSigningKey` file pattern) covering `state.json` secret settings, the Cloudflare
      credential store, and `secrets.json`.
- [ ] Core-state backup including app secrets, encrypted, for whole-machine migration.
- [ ] Names-only CLI diagnostic `hosty apps secrets list <appId>`.
- [ ] Change events for reactive secret reloads.

## Open Questions

- Whether at-rest encryption is wanted at all: the design chose plaintext `0600` parity with
  `state.json` on purpose, and a master key on the same disk changes little in the threat model.
- Whether a Core-state backup will exist; the secrets item depends on it.

## Related

- Service-token scoping, expiry, and per-install generation are SEC-4 in the
  [consolidated review](../../reviews/2026-09-06-consolidated-review.md). That is a Core-wide
  change to the token, not a deliverable of this feature, so it is linked rather than listed.

## Verification

Per deliverable, once shaped; the feature document's Testing Expectations section is the baseline
that must keep passing.

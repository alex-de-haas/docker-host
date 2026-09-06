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

- The service token an app presents to the secrets API carries scopes, an expiry, and an install
  generation; a token minted for a previous install of the same app id is refused.
- `secrets.json` is encrypted at rest under one Core master key, in the same pass that covers
  `secret: true` settings in `state.json` and the Cloudflare credential store; the document's
  `schemaVersion` bump is the migration.
- A Core-state backup, if one exists by then, carries app secrets encrypted so a whole-machine
  migration keeps working connections instead of forcing every app into reconnect-required.
- `hosty apps secrets list <appId>` prints key names only, as a diagnostic.
- Secret change events, only if a consumer needs reactive reloads; none does today.

## Deliverables

- [ ] Service-token hardening reaching the secrets API: scopes, expiry, and a per-install
      generation on `AppServiceTokenService`, with a compatibility window for running apps, so a
      token leaked from one install no longer unlocks live third-party credentials after remove and
      reinstall. A Core-wide token change; tracked here because the secrets store is what made the
      token worth stealing and no other plan carries it. SEC-4 in the
      [consolidated review](../../reviews/2026-09-06-consolidated-review.md).
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
- Whether service-token hardening should become its own feature, since the token also authorizes
  directory, backup, and notification calls; if so, this plan links to that plan and drops the
  deliverable.

## Implementation Phases

The streams are independent of each other; the order is by how much each one closes.

### Phase 1: Service-token hardening

Scopes, expiry, and per-install generation on `AppServiceTokenService`; the secrets endpoints are
the first consumer to require them. Lands before marketplace-era third-party apps.

### Phase 2: At-rest encryption pass

One Core master key covering `state.json` secret settings, the Cloudflare credential store, and
`secrets.json`; `schemaVersion` 1 → 2 is the lazy migration. Starts only once the first open
question is answered yes.

### Phase 3: Core-state backup with secrets

Depends on a Core-state backup existing; carries `secrets.json` encrypted with the Phase 2 key.

### Phase 4: Diagnostics and events

`hosty apps secrets list <appId>` (names only) and change events, each only when a consumer asks
for it.

## Verification

Per deliverable, once shaped; the feature document's Testing Expectations section is the baseline
that must keep passing.

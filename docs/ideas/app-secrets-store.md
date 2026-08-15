# App Secrets Store — Core-Managed Keychain for Runtime-Acquired App Secrets

Status: Promoted (shipped — see [features/app-secrets-store.md](../features/app-secrets-store.md))
Created: 2026-07-22
Updated: 2026-07-22

## Motivation

The first concrete consumer is media-server's Trakt integration
([planning doc](https://github.com/alex-de-haas/media-server/blob/main/docs/planning/trakt-watched-state-sync.md),
still Draft; platform request #15 in
[hosty-platform-requests](https://github.com/alex-de-haas/media-server/blob/main/docs/features/hosty-platform-requests.md)).
It must persist per-user OAuth access/refresh tokens acquired at runtime through
Trakt's Device Code flow. Unlike every credential the platform's apps store today,
these cannot be hashed — the app has to *present* them to Trakt on every outbound
call — so they must be stored recoverably.

The problem with recoverable storage in the app database: Hosty backups are
directory copies of the app `data/` directory, and the SQLite file lives inside
it. Plaintext tokens in SQLite would make every backup archive live write access
to every connected third-party account. The Trakt plan therefore currently specs
a per-app workaround: an operator-generated `TRAKT_TOKEN_ENCRYPTION_KEY` secret
setting plus a hand-rolled AES-256-GCM envelope in the app's own database.

That workaround has the same shape as the pre-platform auth story
[cross-app-auth.md](cross-app-auth.md) documents: a platform-level gap that every
app patches independently. Each future OAuth or API-token integration would
repeat the operator key-generation step, the AES envelope, and the key-loss
failure mode. Secrets-that-must-be-presented are a platform-recurring class, and
the platform already has an opinion about where secrets live: `secret: true`
settings are stored by Core in `<app-dir>/state.json`, **outside** the backed-up
`data/` directory. This design extends that existing posture from install-time
operator settings to runtime-acquired secrets.

## Current State (verified 2026-07-22)

- Backups archive exactly the app `data/` tree and nothing else
  (`AppBackupService`). A file beside `state.json` is structurally outside
  backup scope.
- `state.json` is Core-owned, written atomically with an owner-only (0600) file
  mode, and holds `secret: true` setting values in cleartext protected only by
  that file mode.
- There is **no encryption-at-rest anywhere in Core or the CLI**. The most
  sensitive stored credential today, the Cloudflare API token, is plaintext
  owner-only 0600 by explicit design (`CloudflareCredentialStore`).
- Every existing app-callable endpoint authenticates inline with
  `HOSTY_APP_SERVICE_TOKEN`; cross-app rejection is structural because the app
  id is HMAC-signed into the token (`AppServiceTokenService`).
- App removal defaults to keeping data; when data is kept, Core writes
  `retained-config.json` so a reinstall restores settings — including secret
  settings — mounts, and autostart.
- There is no mechanism for an app to durably store a runtime-acquired secret
  anywhere except its own backed-up `data/` directory.

## Target Behavior

An app stores, reads, and deletes small named secrets through Core using its
existing service token:

```text
GET    {HOSTY_CORE_ORIGIN}/api/internal/apps/{appId}/secrets      → 200 { "keys": [...] }
GET    .../secrets/{key}                                          → 200 { "value": "…" } | 404
PUT    .../secrets/{key}      { "value": "…" }                    → 204
DELETE .../secrets/{key}                                          → 204 (idempotent)
```

Core persists them in Core-owned `apps/<id>/secrets.json` beside `state.json`,
outside backup scope. Secrets survive app update, restart, runtime-switch, and
Core restart. A database restore rolls the app's data back but not its secrets —
deliberately: OAuth refresh tokens commonly rotate on every refresh (Trakt's
do), so a token embedded in a backup archive is usually already invalid by
restore time, while the live keychain keeps connections working. Apps must treat
a missing secret as a defined reconnect-required state, not an error.

## Decisions (ratified 2026-07-22)

1. **Transport: app-callable Core API, not a mounted file.** The `docker`
   profile mounts only `data/` and external mounts into containers; the
   `state.json` area is Core-owned and must stay single-writer. Apps reach the
   store exclusively through the endpoints above, the same pattern as
   directory/backups/notifications. No container-mount change in either runtime
   profile.
2. **Storage: Core-owned `apps/<id>/secrets.json`,** sibling of `state.json`,
   written through the existing atomic owner-only path and serialized on the
   registry's per-app lock — shared with `state.json` writes and subtree
   deletion, not a new lock family. Being outside `data/` keeps it out of every
   backup archive without touching the backup service.
3. **At-rest posture: plaintext 0600, parity with `state.json` — not encrypted
   in v1.** Core has zero encryption-at-rest today; the Cloudflare API token
   and every `secret: true` setting are plaintext 0600 by design. A one-file
   AES special case whose master key sits on the same disk adds real code and
   marginal protection. If the owner wants at-rest encryption, it should be one
   platform-wide pass covering `state.json`, the Cloudflare credential store,
   and `secrets.json` under a single Core master key — named in Future Work.
   The document schema is versioned so that migration is a lazy schema bump.
4. **Removal follows the operator's data choice.** Keep-data removal (the
   default) retains `secrets.json`, exactly like `retained-config.json` retains
   secret settings — "keep my data" keeps the app's persistent identity, and a
   reinstall resumes working connections. Delete-data removal deletes the store
   through the same per-app lock the mutation path uses, and mutations re-check
   app existence inside that lock — so an in-flight write cannot resurrect
   `secrets.json` after removal, and a post-removal write gets 404 (see the
   planning doc for the exact fence).
5. **Keychain, not blob store.** Key naming `^[a-z0-9][a-z0-9._-]{0,127}$`;
   value is a non-empty UTF-8 string of at most 16 KiB; at most 256 keys per
   app. Oversize or malformed requests are rejected, never truncated.
6. **Last-write-wins, no versioning, no watch API in v1.** Single-instance
   apps writing their own keys need none of it.
7. **Names are listable, values are not enumerable.** Values are never returned
   by any Shell or admin API, never included in app summaries or state
   payloads, and redacted from logs. Only the owning app's service token can
   read them.
8. **Not a second settings system.** Operator-configured secrets stay in
   manifest `settings` with `secret: true`. The keychain is only for values the
   app acquires at runtime.
9. **No Shell UI, no CLI command, no rate limiting in v1.** Callers are local
   trusted apps and the document is bounded.
10. **SDK helpers ship with the feature** in both packages — a thin secrets
    client in `HostySdk.App` (with a write-through in-memory cache) and
    server-only functions in `@hosty-sdk/app` — so the first consumer never
    hand-rolls the HTTP contract; the lesson of [cross-app-auth.md](cross-app-auth.md).

## Security Posture, Stated Openly

- **The service token gets more valuable.** Today it grants
  revalidate/directory/backup/notification calls; with this store it grants
  live third-party account access. Its known limits — no expiry, no scopes, no
  per-install generation ([2026-07-10 review, C-M7](../reviews/2026-07-10-core-code-review.md)) —
  become more pressing. Not a blocker in the trusted single-tenant homelab, but
  token scoping/expiry should land before marketplace-era third-party apps.
- **Plaintext 0600 is a deliberate parity choice** (Decision 3), not an
  oversight; the upgrade is a platform-wide at-rest pass, not a one-file
  special case.
- **Machine migration loses secrets** (Core state is not backed up today).
  Acceptable for OAuth-class secrets — they are re-obtainable by design — and
  arguably correct: credentials should not silently follow archives to new
  hosts.

## Boundaries / Non-Goals

- Not a settings replacement (Decision 8) and not a blob store (Decision 5).
- No cross-app secret sharing; the keychain is strictly per-app.
- No per-service scoping inside multi-service apps in v1.
- No encryption-at-rest in v1 (Decision 3).
- App-side behavior (e.g. media-server's Trakt adoption) is owned by the
  consuming app's own plan.

## Future Work

- Platform-wide at-rest encryption pass: one Core master key (the durable
  `AppServiceSigningKey` file pattern) covering `state.json` secret settings,
  the Cloudflare credential store, and `secrets.json`.
- Service-token scoping/expiry/per-install generation (C-M7).
- Core-state backup including app secrets (encrypted) for whole-machine
  migration, if/when a Core-state backup exists.
- Names-only CLI diagnostic (`hosty apps secrets list <appId>`).
- Change events if a consumer ever needs reactive secret reloads.

## Links

- [Implementation planning](../planning/app-secrets-store.md)
- [App data backup retention](../features/app-data-backup-retention/feature.md)
- [Core API](../features/core-api/feature.md)
- [Cross-app auth](cross-app-auth.md) — the precedent for "platform gap →
  per-app hand-rolled security"
- [Hosty App SDK](../features/hosty-app-sdk/feature.md)
- [media-server platform request #15](https://github.com/alex-de-haas/media-server/blob/main/docs/features/hosty-platform-requests.md)
- [media-server Trakt plan](https://github.com/alex-de-haas/media-server/blob/main/docs/planning/trakt-watched-state-sync.md)

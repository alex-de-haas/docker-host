# Core API

Created: 2026-05-13
Updated: 2026-07-29

## Description

Hosty Core exposes browser APIs for Shell and app auth, plus a local control API for the CLI. The current lifecycle surface is runtime-app oriented.

## Browser APIs

A Host user session may be presented either as the `hosty_session` cookie or as `Authorization: Bearer <session id>`. The bearer form exists for non-browser clients (the native Apple client in `apps/shell-swift`); it carries the same session record, expiry, and revocation, and mints nothing new. Two rules hold it together: the cookie takes precedence whenever both are present, and only a bearer-presented session is exempt from the CSRF pair below — a browser request cannot opt itself out. See [Auth And Gateway Model](../auth-gateway/feature.md).

Mutating browser endpoints are CSRF-protected: `GET /api/auth/csrf` sets the double-submit cookie and returns the token to echo in `X-Hosty-CSRF`.

- `GET /api/core/status` - public Core status.
- `GET /login` - Core-owned login page. Development renders the local user selector; non-development renders email/password login.
- `POST /login` - create a Core session from the development selector or from local email/password credentials, depending on environment, then redirect to the effective Shell origin.
- `GET /api/apps` - apps visible to the active Host session, including the selected runtime and available `runtimeProfiles`.
- `GET /api/users` - admin user directory state.
- `POST /api/auth/bootstrap` - consume a setup token, create the first administrator, store the submitted password credential, and create a Core session.
- `POST /api/auth/recovery` - consume a recovery token, create or restore an administrator, replace the submitted password credential, and create a Core session.
- `POST /api/auth/apps/authorize` - create an app authorization code for an authenticated Host user.
- `POST /api/auth/apps/token` - exchange an app authorization code for an app identity token.
- `POST /api/auth/apps/revalidate` - validate an app identity token; requires the calling app's `HOSTY_APP_SERVICE_TOKEN` as a bearer token and rejects tokens issued for another app.
- `POST /api/auth/trusted-proxy/session` - create a session for a reverse-proxy-asserted user; disabled unless `HOSTY_TRUSTED_PROXY_SECRET` is configured and the proxy presents it via `X-Hosty-Trusted-Proxy-Secret`.
- `POST /api/apps/{appId}/switch-runtime/plan` - admin runtime switch review for browser Shell clients.
- `POST /api/apps/{appId}/switch-runtime` - admin runtime switch apply for browser Shell clients; CSRF-protected and requires the reviewed plan digest.
- `GET /api/apps/{appId}/update-status` - read-only update availability, projected from the app's cached plan (no network work when one is fresh); `?refresh=true` forces a single-app rebuild. Applies to system apps too.
- `POST /api/apps/update-check` - admin fleet update check: starts or joins a sweep that builds and caches a plan per updatable app, and returns immediately. Progress is the `updateCheck` block on `GET /api/apps`; per-app verdicts land on each app summary.
- `GET /api/apps/{appId}/update/plan` - the app's cached pending plan, or null when none is pending (never built, expired, or consumed by an apply).
- `POST /api/apps/{appId}/update/plan` - admin reviewed update plan for browser Shell clients (system apps included); caches the plan as the app's pending plan.
- `POST /api/apps/{appId}/update` - admin update apply; CSRF-protected and requires the reviewed plan digest. Enqueues the apply and returns immediately: validation errors answer inline, then the apply runs detached from the request, with `operationStatus: "updating"` on the record as progress. The `/control/v1` twin stays synchronous.
- `POST /api/apps/install/feed/plan` - admin install review from an untrusted HTTP(S) `app-feeds.0.1` URL and optional feed id.
- `POST /api/apps/install/feed` - CSRF-protected feed install apply; Core re-resolves the feed and manifest and requires the reviewed plan digest.
- `GET /api/apps/{appId}/feeds` - list the feeds resolved from an installed app's stored `FeedsUrl` and return its followed feed id.
- `POST /api/apps/{appId}/feed` - select a future update feed from the installed app's stored feed document without changing the running app.
- `GET /api/internal/apps/{appId}/directory/users` - scoped app directory for runtime apps with `HOSTY_APP_SERVICE_TOKEN`.
- `GET /api/internal/apps/{appId}/secrets` - list the app's stored secret **key names** (never values); `HOSTY_APP_SERVICE_TOKEN`.
- `GET /api/internal/apps/{appId}/secrets/{key}` - read one stored secret; `404` means no secret is stored, an expected reconnect-required state.
- `PUT /api/internal/apps/{appId}/secrets/{key}` - store or replace a secret (`{ "value": … }`, non-empty UTF-8 ≤ 16 KiB, ≤ 256 keys per app).
- `DELETE /api/internal/apps/{appId}/secrets/{key}` - delete a secret; idempotent. See [App Secrets Store](../app-secrets-store.md).

Public ingress (see [Cloudflare Ingress](../cloudflare-ingress/feature.md)). The connection endpoints are
host-admin; the publication ones are app-scoped and also host-admin. Both refuse when the active ingress
provider is not `cloudflare-remote`.

- `GET /api/core/cloudflare/token-template` - the dashboard token page plus the permission groups to grant.
- `GET /api/core/cloudflare/status` - the connection projection: masked token summary, discovered
  account/zone/tunnel, connector health, and the connector-locality verdict.
- `POST /api/core/cloudflare/connect` - connect a scoped API token. `{ token, accountId?, zoneId?, tunnelId? }`;
  the three ids answer an ambiguity a previous attempt reported. Answers `409` with
  `{ code, message, selection: { kind, options } }` when a choice is required.
- `POST /api/core/cloudflare/disconnect` - `{ removePublished? }`. Keep (the default) leaves every published
  route and record; Remove deletes them first and answers `409 cloudflare_disconnect_incomplete` without
  disconnecting when any deletion fails.
- `GET /api/core/cloudflare/diagnostics` - read-only drift check of stored publications against Cloudflare,
  plus the public endpoints that have no address at all. Mutates nothing.
- `GET /api/apps/{appId}/public-origins` - this app's publications with their per-endpoint state.
- `POST /api/apps/{appId}/public-origins/publish` - `{ endpointKey, label, adopt? }`. `adopt` takes over a
  pre-existing DNS record after a `409 cloudflare_hostname_conflict`.
- `POST /api/apps/{appId}/public-origins/unpublish` - `{ endpointKey }`.

Core exposes no catalog or Marketplace proxy endpoints. The optional `hosty.marketplace` system app owns its source and storefront. Shell accepts its bounded install intent and calls the generic feed endpoints above; Core independently validates the feed and manifest.

`/api/core/status` reports effective public origins. If `HOSTY_CORE_PUBLIC_ORIGIN` or `HOSTY_SHELL_PUBLIC_ORIGIN` is unset, Core falls back to `http://localhost:<core-port>` and `http://localhost:<shell-port>`.

## Control APIs

The CLI discovers Core control information from the local run directory and sends `X-Hosty-Control-Secret` to `/control/v1`.

- `GET /control/v1/apps`
- `POST /control/v1/apps/install`
- `POST /control/v1/apps/{appId}/start`
- `POST /control/v1/apps/{appId}/stop`
- `POST /control/v1/apps/{appId}/restart`
- `POST /control/v1/apps/{appId}/update/plan`
- `POST /control/v1/apps/{appId}/update`
- `POST /control/v1/apps/{appId}/switch-runtime/plan`
- `POST /control/v1/apps/{appId}/switch-runtime`
- `POST /control/v1/apps/{appId}/feed`
- `POST /control/v1/apps/{appId}/remove`
- `GET /control/v1/apps/{appId}/health`
- `GET /control/v1/apps/{appId}/logs`
- `GET /control/v1/users/summaries?appId={appId}`
- `POST /control/v1/auth/setup-token`
- `POST /control/v1/auth/recovery-token`
- `POST /control/v1/apps/{appId}/identity`
- `POST /control/v1/apps/{appId}/open-link`

## Backups

App backups cover the primary app data directory only:

```text
<HOSTY_HOME>/apps/<app-id>/data/
```

External mounts are excluded.

An operator-triggered manual backup of a running app briefly stops it to copy a consistent snapshot, then restarts it; the Core-managed `pre-update`/`pre-runtime-switch`/`pre-restore` backups already run against stopped data. See [App Data Backup Retention](../app-data-backup-retention.md) for the full consistency behavior.

## Testing Expectations

- Every browser endpoint enforces its documented authorization: session, admin session, or app service token.
- Mutating browser endpoints reject a missing or mismatched CSRF pair unless the session was presented as a bearer.
- Control endpoints reject a missing or wrong `X-Hosty-Control-Secret`.
- Reviewed-plan endpoints refuse an apply whose digest does not match the plan that was built.
- `/api/core/status` redacts host detail for an anonymous caller while still identifying the component and version.

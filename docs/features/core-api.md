# Core API

## Description

Hosty Core exposes browser APIs for Shell and app auth, plus a local control API for the CLI. The current lifecycle surface is runtime-app oriented.

## Browser APIs

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
- `GET /api/internal/apps/{appId}/directory/users` - scoped app directory for runtime apps with `HOSTY_APP_SERVICE_TOKEN`.

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

An operator-triggered manual backup of a running app briefly stops it to copy a consistent snapshot, then restarts it; the Core-managed `pre-update`/`pre-runtime-switch`/`pre-restore` backups already run against stopped data. See [App Data Backup Retention](app-data-backup-retention.md) for the full consistency behavior.

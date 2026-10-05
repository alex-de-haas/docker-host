# CLI App Commands

Created: 2026-10-05
Updated: 2026-10-05

## Description

The `hosty apps` command group manages installed runtime apps through the local Core control API.

## Common Commands

```bash
hosty apps list
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
hosty apps health com.haas.demo-app
hosty apps logs com.haas.demo-app
hosty apps open com.haas.demo-app
hosty apps identity com.haas.demo-app --user user@docker-host.local --format token
hosty apps stop com.haas.demo-app
hosty apps remove com.haas.demo-app
```

`hosty apps install` accepts an HTTP(S) URL that points directly to `manifest.json`, a local manifest file path, or a local app directory containing `manifest.json`. From inside a checked-out runtime app directory, use `hosty apps install .`.

`hosty apps open` returns a validated app URL or Shell workspace URL. It contains no authorization
code, expiry or selected user. The browser starts the app-owned sign-in flow using its own Core
account; a logged-out browser completes normal Core password login. The removed `--user` option
returns migration guidance instead of choosing an identity. `hosty apps identity --user` remains
a separate diagnostic command.

## Control API

CLI app commands authenticate through Core control discovery. Core writes an owner-only discovery document under the Hosty run directory, and the CLI calls `/control/v1` with the per-start control secret.

## Direct Endpoint Probes

For direct app-origin diagnostics, request an app identity token through Core and pass it to the app endpoint:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

## Testing Expectations

- Text and JSON open links contain no code, grant, expiry or selected user.
- Legacy `apps open --user` and control open-link user fields receive explicit migration errors.
- App availability, exposure policy and Shell launch-mode validation apply before returning a URL.
- Identity diagnostic requests retain their explicit user and app-access checks.

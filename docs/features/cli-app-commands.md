# CLI App Commands

## Description

The `hosty apps` command group manages installed runtime apps through the local Core control API.

## Common Commands

```bash
hosty apps list
hosty apps install apps/demo-app --runtime dev
hosty apps start com.haas.demo-app
hosty apps health com.haas.demo-app
hosty apps logs com.haas.demo-app
hosty apps open com.haas.demo-app --user user@docker-host.local
hosty apps identity com.haas.demo-app --user user@docker-host.local --format token
hosty apps stop com.haas.demo-app
hosty apps remove com.haas.demo-app
```

`hosty apps install` accepts an HTTP(S) URL that points directly to `manifest.json`, a local manifest file path, or a local app directory containing `manifest.json`. From inside a checked-out runtime app directory, use `hosty apps install .`.

## Control API

CLI app commands authenticate through Core control discovery. Core writes an owner-only discovery document under the Hosty run directory, and the CLI calls `/control/v1` with the per-start control secret.

## Direct Endpoint Probes

For direct app-origin diagnostics, request an app identity token through Core and pass it to the app endpoint:

```bash
TOKEN="$(hosty apps identity com.haas.demo-app --user user@docker-host.local --format token)"
curl -H "X-Docker-Host-Identity: $TOKEN" <assigned-demo-app-origin>/api/auth/identity
```

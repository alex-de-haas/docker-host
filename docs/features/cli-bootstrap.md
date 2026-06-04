# CLI Bootstrap

## Description

The Hosty CLI is exposed as `hosty`. It bootstraps local Core, discovers the Core control API, and manages runtime apps through `hosty apps`.

## Commands

```bash
hosty install
hosty update
hosty uninstall
hosty core start
hosty core stop
hosty apps list
hosty apps install apps/demo-app/manifest.json --runtime dev
```

## Root Selection

`HOSTY_HOME` can override the local Hosty root for tests and isolated runs. The default root is:

```text
~/.hosty
```

## Control Discovery

Core writes a local control discovery document under the run directory. CLI commands read that file and call `/control/v1` with `X-Hosty-Control-Secret`.

## Uninstall

`hosty uninstall` requests Core shutdown when local control discovery is available, then removes Hosty-owned state while preserving the CLI executable directory.

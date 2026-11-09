# Published Initialization Acceptance — 2026-10-25

## Scope And Baseline

This review verifies the published first-install and Dashboard child-environment paths owned by
[Hosty initialization D10](../features/hosty-initialization/plan.md). The registered workspace starts
at `3fa7ff74f41e47133e7e2b89df58d695f1fe0375`. No implementation changes are needed for the verified
scenarios. This report does not close the feature's remaining native-platform acceptance.

The execution target is macOS 27.0.1 ARM64 (build 26A434), Docker Desktop Engine 29.9.2 on aarch64,
with 14 engine CPUs and approximately 16 GiB engine memory. Browser acceptance uses Codex's in-app
browser against the real instance-qualified Core and Shell origins. All accounts and application
data are created solely for this disposable test.

The installer is downloaded from the repository's public main URL and matches the workspace copy.
It downloads the real `cli-dev` release asset and verifies its published SHA-256; no download,
manifest, distribution catalog or executable is substituted. The clean root has no Core executable
before init. Init downloads Core and resolves the normal published Shell/Marketplace distribution.

| Artifact | Observed version or digest |
| --- | --- |
| CLI | 0.152.3; SHA-256 `d0a6971a8de0892a23960c456d1144d09283e1c30a930f264b8890a5a3ca4bae` |
| Core | 0.152.3; SHA-256 `e98e7c5edbd158761dd3e8cf5a73d02240e8a03c74a5879c266052d49776a9c9` |
| Shell | 0.112.5; image `sha256:37ed7b95ef8c238ebe70d8e708be28f4563412ea198cea192f7d7fd3a9502cd7` |
| Marketplace | 0.12.2; image `sha256:c47139f327679797791ff033b95dd1cc38f2e002efc191997f045342005d3ba4` |
| Unix installer | SHA-256 `6c00e2b3667008145a0442441aab55517eea3f2997058f677bc4c50ac6b2a0c2` |

## Verified Results

1. **CLI-only install and Start guard.** The actual installer prepares only the selected temporary
   root, leaves Core absent and prints init guidance. Premature Start exits 1 with the init
   instruction and creates no running Core or application.
2. **Published recommended initialization.** `init --yes --no-open` downloads missing Core, selects
   Shell and Marketplace and waits until both report ready. Core, Shell and Marketplace receive
   distinct automatic ports: 28063, 23492 and 26492. The printed setup link works in the browser;
   ordinary email/password administrator registration redirects into authenticated Shell.
3. **Same-root repeat.** Repeating init after registration succeeds, identifies the existing Shell
   destination and preserves the initialization request/state. It does not reinstall or ask to create
   another administrator. The initial request remains `0b13aaa364fe4dfb97d0fa969b74d6f0`.
4. **Dashboard recommended child.** The initially empty Sandboxes section exposes Create environment.
   The normal catalog offers recommended Shell/Marketplace and optional Harness/Telemetry. A two-app
   selection with only 2 GiB is refused in the dialog without allocation. With 4 GiB/2 CPUs, the
   child starts through its parent and both published applications become healthy. Its Core, Shell
   and Marketplace ports are 20457, 21911 and 23640: all six primary/child ports are distinct.
5. **Independent identity.** The child's setup form remains available while the parent browser is
   signed in. Its own ordinary registration reaches authenticated child Shell. A separate normal
   password-login probe rejects the parent's credentials with HTTP 403 and accepts the child's
   credentials. Neither child contains `parent-session.json`; ordinary environment inventory
   contains no setup token.
6. **Resources and restart.** Docker inspection confirms 2 GiB memory, 1 CPU and 256 PIDs per child
   app. Dashboard Restart creates a new child process while preserving its ports, account and browser
   session. Parent `core restart --keep-apps` preserves the child's PID/start identity, all six ports
   and healthy applications. Parent Dashboard reload restores the environment and registered state.
7. **Core-only child and link renewal.** A second Dashboard child with no selected apps starts with
   a 1 GiB/1 CPU reservation; its per-app memory ceiling is correctly capped at 1 GiB. Issuing a new
   registration link preserves that environment. Ordinary registration finishes on Core with CLI/API
   and `hosty setup` guidance, without a missing-Shell redirect. This checks renewal, not elapsed
   setup-token expiry.
8. **Removed-app choice.** Removing Marketplace from the primary through CLI, then repeating init
   and restarting Core, leaves only Shell installed. The removed Marketplace container stays absent;
   the recommended child's Marketplace stays healthy. A retained icon cache is not an installation.
9. **Finish and disposal.** The recommended child is Finished through Dashboard and the Core-only
   child through the authenticated owner's API. Replaying the exact Core-only Finish request succeeds
   without another operation. Both roots are absent, child processes are gone, all four child
   listeners are closed and no owned Docker containers, networks or volumes remain. Dashboard returns
   to its empty Sandboxes state. Primary app removal, Core Stop and scoped uninstall remove its
   application/Core state; all seven test listeners are closed. Only empty CLI directories remain
   under the primary fixture root. Downloaded test binaries and private evidence remain outside it.

The operator's existing Core is preserved: process-start identity `16008:639285334061594810`,
release mode and Source revision `e8e3804af0694cc4b602464555f892c4` match before/after observations.
Its two pre-existing Docker containers retain their original IDs. No provider credentials or
ordinary app data are copied into the test.

## Commands And Execution Notes

The actual test uses an explicit root beneath `/private/tmp/hosty-init-acceptance-20261025`.
These are the command forms, with that directory represented by `QA_ROOT`:

```sh
HOSTY_DATA_ROOT="$QA_ROOT/primary" HOSTY_INSTALL_DIR="$QA_ROOT/bin" \
  HOSTY_INSTALL_SKIP_PATH_UPDATE=1 sh "$QA_ROOT/install.sh"
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" start
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" init --yes --no-open
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core start --foreground
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core restart --keep-apps
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" apps remove hosty.marketplace --delete-data --delete-backups
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" init --yes --no-open
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core restart --keep-apps
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" apps remove hosty.shell --delete-data --delete-backups
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core stop
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" uninstall --yes --delete-data
```

Premature Start is the expected nonzero command. The other lifecycle/initialization commands
succeed. Browser actions use the rendered forms, Dashboard controls and ordinary Core/Shell URLs.
API checks authenticate through normal `/login`, obtain CSRF for mutations and use the owning
parent's `/api/core-environments` routes. They do not seed sessions or use a child control secret.

The initial init command completes successfully, but its Core is absent when the terminal execution
session ends. Browser connection refusal is recorded; the cause is not established as a product
failure. Restarting the same installed Core in a retained foreground terminal session restores the
same root and adopts both existing app containers. Subsequent restarts retain their terminal session
until cleanup. An attempted native Terminal confirmation is unavailable because the computer-use
tool refuses access to that application. Therefore this run does not claim unattended survival
after closing a normal terminal; that observation remains within D10 acceptance.

Two probe assumptions are corrected without product changes: invalid parent credentials return 403
rather than 401, and app removal can retain an icon cache. Assertions use authenticated registry,
process, listener and Docker resource facts rather than directory existence alone.

## Verification Boundary

Published native macOS ARM64 installation and both Dashboard paths pass. Earlier native Ubuntu
ARM64 candidate coverage remains recorded in the owning plan; this run does not repeat it against
published artifacts. Native Windows/PowerShell, Linux x64 and macOS Intel installer/browser journeys
remain unverified. There is no claim about those targets from Docker or compilation evidence.

The feature plan retains D10 and D11. This run also does not repeat every earlier failure-injection,
expired-token, optional-app, native AOT or broad unit-suite case. No source code changed, so builds
and unit suites are not rerun for this documentation-only acceptance record. Documentation/index,
relative-link, version-consistency, installer-syntax and diff checks validate the repository update.
Raw logs, API evidence, test scripts, credentials and browser state are kept out of the repository.

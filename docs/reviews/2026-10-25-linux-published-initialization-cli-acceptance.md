# Linux Published Initialization CLI Acceptance — 2026-10-25

## Scope And Baseline

This report records the completed CLI portion of
[Hosty initialization D10](../features/hosty-initialization/plan.md) on native Ubuntu in UTM.
The registered documentation workspace starts at `3fa7ff74f41e47133e7e2b89df58d695f1fe0375`.
No implementation changes are made. This is partial acceptance, not a completed Linux browser run.

The owner authorizes UTM for Linux acceptance, removes macOS Intel from the required acceptance
matrix and takes responsibility for Windows production verification. Windows has no recorded result
from this run. The UTM guest is Ubuntu 24.04.5 LTS, kernel 6.8.0-142-generic, **aarch64**; this result
does not establish Linux x64 behavior. The Hosty QA Ubuntu VM runs in UTM disposable mode, while the
separate Clean Baseline VM remains stopped.

The Unix installer comes from the public repository main URL. It downloads and verifies the real
`cli-dev` Linux ARM64 asset. Init downloads the real Core artifact and uses the normal published
Shell/Marketplace catalog. No installer downloads, executables or manifests are substituted.
The selected test root is `/home/hostyqa/hosty-init-acceptance-20261025/primary`, separate from the
guest's ordinary root. Commands run as the normal `hostyqa` user through UTM's guest execution tool.

| Artifact | Observed version or SHA-256 |
| --- | --- |
| CLI | 0.152.3; `789df2be9028d4135f2e7fa4d2581f5479358f4421f42a40873180fc2bf0727b` |
| Downloaded Core | `f92cb38b6abdf2149de764fef2b2fd66e959438167695d790068ea6f81a79569` |
| Unix installer | `6c00e2b3667008145a0442441aab55517eea3f2997058f677bc4c50ac6b2a0c2` |
| Shell | 0.112.5; image `sha256:37ed7b95ef8c238ebe70d8e708be28f4563412ea198cea192f7d7fd3a9502cd7` |
| Marketplace | 0.12.2; image `sha256:c47139f327679797791ff033b95dd1cc38f2e002efc191997f045342005d3ba4` |

## Verified Results

1. The CLI-only installer leaves Core absent. Premature Start fails with an instruction to run
   init before starting Core or applications.
2. `init --yes --no-open` downloads Core, installs the recommended applications and reports both
   ready. The initialization request is `5db5c0b743174c58b5cf982d8718cb70`. Core, Shell and Marketplace
   receive distinct automatic ports 32340, 28982 and 28803. A normal setup URL is printed.
3. The installed Core remains running after the initiating guest command exits, with parent PID 1.
   This verifies guest-command detachment; it does not establish the separate macOS terminal-closing
   behavior recorded in the macOS report.
4. Repeated init uses the same root, instance and app containers. A later `core restart --keep-apps`
   changes Core PID 2185 to 5224 while preserving the complete initialization document, both Docker
   container IDs and all ports.
5. Removing Marketplace through CLI, repeating init and restarting Core leaves only Shell in the
   authoritative app registry. The original Shell container survives, Marketplace's container is
   absent and its former port is closed. Core remains running with PID 5734 and the same port.
6. Direct HTTP probes return 200 for Core health, its setup page and the Shell page. The session
   endpoint reports unauthenticated and the protected environment inventory returns 401. These are
   HTTP probes, not evidence of completed browser registration or authenticated Shell integration.

## Commands And Execution Notes

`QA_ROOT` below is `/home/hostyqa/hosty-init-acceptance-20261025`.

```sh
HOSTY_DATA_ROOT="$QA_ROOT/primary" HOSTY_INSTALL_DIR="$QA_ROOT/bin" \
  HOSTY_INSTALL_SKIP_PATH_UPDATE=1 sh "$QA_ROOT/install.sh"
"$QA_ROOT/bin/hosty" --version
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" start
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" init --yes --no-open
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core restart --keep-apps
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core status
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" apps remove hosty.marketplace --delete-data --delete-backups
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" init --yes --no-open
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" core restart --keep-apps
"$QA_ROOT/bin/hosty" --data-root "$QA_ROOT/primary" apps list
```

Premature Start is the expected failure; the other listed commands succeed. UTM guest commands
sometimes return without their output, so completion is checked from saved logs and independent
process, registry, HTTP and Docker observations rather than from that empty response.

An attempted direct `hosty-core --version` diagnostic starts a foreground Core instead of printing
version information. That exact process is identified by its executable and arguments and stopped
with SIGTERM. It is not counted as a successful diagnostic. The selected test Core remains running;
subsequent observations contain only the two original test app containers. No version claim is
inferred from that direct invocation. This occurs entirely inside the disposable VM.

## Verification Boundary And Retained Fixture

The Ubuntu desktop remains at the Hosty QA login screen. Browser acceptance requires the owner to
sign in to that existing guest account; no guest password is reset or authentication bypass added.
No Hosty administrator is created during this partial run. D10 still owns normal browser setup,
authenticated Shell, Dashboard child creation/identity/resources/restart and owned Finish cleanup
against these published Linux artifacts. D11 remains open until the required acceptance is recorded.

The VM, test Core and Shell are retained for continuation. They are not claimed as cleaned up, and
stopping the disposable VM would discard its test state. On completion, remove the remaining test
application and stop/uninstall the explicitly targeted primary root; Finish any created children
through their owning Core, verify resource removal, then shut down this VM. The separate baseline
VM and the operator's macOS Hosty instance are not changed by the intended test lifecycle.

Selected evidence is exported outside the repository. Raw logs, setup tokens, credentials and
probe JSON are excluded from repository changes. Builds and unit suites are not rerun because
this update changes only documentation; documentation/link/index, version consistency and diff
checks validate the update.

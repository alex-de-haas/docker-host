---
created: 2026-11-17
updated: 2026-11-17
summary: The .NET 11 platform toolchain, Native AOT targets, application compatibility boundaries and migration verification.
components: [apps/core, apps/cli]
---

# .NET 11 Platform Toolchain

## Platform And Compatibility

The root `global.json` selects SDK 11.0.100 with `rollForward: latestFeature`.
Core, CLI, both unit-test projects, the PR acceptance host and the release
validator target `net11.0`. Core and CLI publish self-contained Native AOT
executables; their shared platform version is 0.181.0. Core HTTP test hosting uses
`Microsoft.AspNetCore.TestHost` 11.0.0.

The independently versioned application SDK retains its `net8.0;net10.0` targets
and version 0.16.0. Telemetry retains its .NET 10 runtime and packages. Its builder
uses SDK 11 in both the Dockerfile and release publisher, with an ASP.NET 10 final
image. Telemetry's coordinated artifact version is 0.18.1. CI installs SDK 10.0.402
alongside the root SDK in the retained .NET 10 test jobs and SDK publication job.
No runtime roll-forward override is necessary.

Integration launchers and the release validator resolve the platform's `net11.0`
output directories. The PR acceptance host disables its unused static-web-assets
graph: it serves Core's embedded browser resources, and the default .NET 11 graph
otherwise duplicates hot-reload modules from the referenced Core Web project.

The release matrix remains macOS arm64, Linux arm64/x64 and Windows x64. The x64
targets require the [.NET 11 x86-64-v2 baseline](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements).
Native executables do not require an installed .NET runtime. Source development
and framework-dependent test binaries require their corresponding SDK/runtime.
See the [repository release model](../repository-release-model/feature.md#net-build-toolchain).

## Runtime Compatibility

ZIP restore verifies archive SHA-256 and extracts into staging before replacing
live data. .NET 11 also [validates entry CRC32](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/11/ziparchive-entry-crc32-validation).
The regression test supplies an archive with matching metadata SHA but an invalid
entry CRC, and checks that restore rejects it, retains live data and removes staging.

Core propagates unexpected host failures, including the [.NET 11 BackgroundService
failure result](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure).
Existing service-specific handling still covers expected transient failures.
Build provenance hooks attach to compilation, so the [optimized AOT publish
pipeline](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/aot-publish-skips-full-build)
preserves them. Core and CLI publish executables, so the Unix native-library
`lib` prefix change does not affect release filenames.

Windows background Core, child Core and CLI-helper shell wrappers use
[`StartDetached`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.startdetached?view=net-11.0).
.NET 11 explicitly duplicates standard handles for child startup, including
handles whose inheritance flag was cleared. Detached startup gives the wrapper
null-device standard handles; its existing shell redirection still writes the
child's output to the selected log. This prevents a surviving background process
from retaining a caller's captured output pipes. Foreground launches, explicit
service pipes, process identities and readiness checks retain their existing behavior.

Native paired-update acceptance captures command output in temporary files and
waits on the direct process with a bounded timeout. Windows Python pipe draining
can otherwise block after a timeout when a surviving descendant holds an output
handle. A separate Windows regression checks that captured launcher output reaches
EOF while its detached child remains alive.

The migration review found no platform use requiring changes for EF Core,
OpenAPI/Blazor APIs, TAR processing, DSA, client-certificate authentication,
named-pipe constructor obsoletions, named mutexes, command-line argument-zero
semantics, or affected configuration callbacks. Compiler checks cover the
platform's span and collection-expression usage.

## Local Verification On 2026-11-17

The migration is verified with SDK 11.0.100 on macOS arm64. Clean Core/CLI builds,
the acceptance host and the Release validator build successfully. The unchanged
application SDK also builds for both net8.0 and net10.0.

| Command | Result |
| --- | --- |
| `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-build --no-restore` | 5,064 passed, 7 predeclared platform/optional integration skips, no failures. |
| `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj` | 384 passed; the new Windows detached-launch regression is explicitly skipped on macOS. |
| `dotnet test packages/app-sdk-dotnet/HostySdk.App.Tests/HostySdk.App.Tests.csproj` | 90 passed on .NET 10. |
| `dotnet test apps/telemetry-backend/tests/Haas.Hosty.TelemetryBackend.Tests/Haas.Hosty.TelemetryBackend.Tests.csproj` | 141 passed on .NET 10. |
| `npm run core:aot` | osx-arm64 publication and isolated health/authorization smoke passed; no trim/AOT warnings. Readiness took 1,245 ms. |
| `dotnet publish apps/cli/src/Haas.Hosty.Cli/Haas.Hosty.Cli.csproj -c Release -r osx-arm64 --self-contained true --output /private/tmp/hosty-dotnet11-cli-native` | Native publication passed; the resulting `hosty --version` returned 0.181.0. |
| `npm run test:integration -- transport` | Health and authorization passed on default and per-app Docker networks. |
| `npm run test:integration -- activation` | Return, exact process replacement and interrupted-helper recovery passed; owner Finish confirmed resource removal. |
| `npm run test:integration -- dependencies` | Waiting, cancellation, automatic starts, boot, shared providers, failure retry and reviewed graph repair passed; owner Finish removed child data, processes and Docker resources. |
| `node --test scripts/releases/publisher.test.mjs .github/actions/ci-validation-gate/setup-dotnet.test.mjs scripts/test-integration.test.mjs` | 36 passed. The broader CI/release run also passed 181 checks before the final publisher consistency regression was added. |
| `docker build -f apps/telemetry-backend/Dockerfile -t hosty-dotnet11-telemetry:verification .` | linux/arm64 locked restore and offline net10.0 publication passed with SDK 11. |
| `docker run --rm --network none --entrypoint dotnet hosty-dotnet11-telemetry:verification --list-runtimes` | ASP.NET/Core 10.0.15 confirmed; disposable container removed. |

After the initial Windows CI run exposed captured-handle retention, Core and CLI
were rebuilt with the detached-launch correction. The affected Core launch,
handle and activation tests passed (5 passed, 1 Windows-only skip). The fixture's
`python3 scripts/test-platform-native-update.py` passed 3 real-process tests, and
`node --test scripts/ci*.test.mjs .github/actions/ci-validation-gate/*.test.mjs`
passed 196 checks. Windows CI runs the detached-output and child-Core launch tests
before publishing and exercising the native replacement pair.

The dependency acceptance fixture uses a public digest-pinned Node image and
preloads its generated server through `NODE_OPTIONS`. This corrects the old
local-only fixture's incompatibility with registry verification during reviewed
updates; the production update gate is unchanged. See
[dependency startup testing](../dependency-ordered-autostart/feature.md#testing-expectations).
Version consistency, documentation/index validation, edited Python syntax and
`git diff --check` also pass.

Core retains the pre-existing CS9113/CA1416 compiler warnings and xUnit2031 test
warnings. The application SDK retains XML-documentation warnings. Native SDK 11
libraries produce Apple debug-symbol linker warnings about duplicate objects and
missing build-machine module caches; publication and native execution pass, with
no trimming/AOT analysis warnings.

Windows and Linux Core/CLI native builds and execution are not verified on this
macOS host. The heavyweight tasks integration suite is not selected; it remains
optional. No commit, CI run, publication or live Core activation is part of this
local verification.

## Testing Expectations

- Clean-build Core/CLI and run their complete unit suites on the selected SDK.
- Build the PR acceptance host and release validator; retain the ZIP CRC restore
  regression and existing archive/snapshot, lifecycle and authorization coverage.
- Build the application SDK for both targets and run SDK/Telemetry tests using
  their .NET 10 runtime. Test the CI SDK selector and compatibility-runtime setup.
- Run `npm run core:aot` and publish/run the native CLI on the local release
  architecture. Report other operating systems and CPU architectures separately.
- Run `python3 scripts/test-platform-native-update.py` (`python` on Windows) for
  bounded native-acceptance capture, and run the Windows detached-launch regression
  before native paired-update acceptance. Keep the child alive during the EOF check.
- Run `npm run test:integration -- transport`, `dependencies` and `activation`
  for runtime toolchain changes, with isolated test data and managed environment
  cleanup. The `tasks` suite remains optional under the repository policy.
- Build the Telemetry Docker image and verify its retained runtime. Keep the
  publisher's SDK override consistent with `global.json` and the Dockerfile.
- Run version consistency, documentation/index, affected CI/release tests and
  diff checks. Report existing compiler and SDK linker warnings explicitly.

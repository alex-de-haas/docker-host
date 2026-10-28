---
created: 2026-10-28
updated: 2026-10-28
summary: Core supplies portable platform and app-development skills, versioned catalog provenance and a platform introduction for every Harness agent.
components: [apps/core, apps/cli, apps/harness, skills]
---

# Core Platform Skills

Core embeds two complete packages from the repository's `skills/` directory in its executable:

| Package | Purpose | Harness delivery |
| --- | --- | --- |
| `hosty-platform` | Platform concepts, apps, authorized operations, permissions, development workspaces and isolated previews | Included for every agent |
| `hosty-app-skill` | App creation, SDKs, manifests, identity and supported development/testing workflows | Optional profile or explicit session selection |

The packages work offline without a source checkout, Git or installed standard applications. Both
appear in Harness Settings → Skills with `Core · <running-version>` provenance and a Read action.
Their content changes with Core; Git update/removal controls do not apply. Core exposes the same
catalog/read/export contracts to every authorized consumer, without depending on Harness, Documents
or Shell identities. See the [shared library](../agent-skills/feature.md) for authorization and exports.

## Platform Context And Selection

The platform package contains `references/introduction.md`, the single source for its concise
standing introduction. Core bounds it to 8,000 UTF-8 bytes. Consumers request this context with
`includePlatform: true` when creating an export. Core adds the platform package and returns
`platformIntroduction: { skillId, coreVersion, path, text }`. The matching Core catalog entry has
`introductionPath`; both Core packages report `sourceKind: core` and `coreVersion`.

Harness requests this context for every native and Docker agent start, including conversations
without a profile. It validates the returned introduction against the exported Core package,
then places its text before the mode-specific environment description and operator/role guidance.
The package also remains available through normal Codex/Claude native discovery. Guaranteed
introduction delivery does not imply that a native agent activates every reference on every turn.

The [profile editor](../agent-profiles/feature.md) shows the platform package checked and disabled,
with “Included for every agent.” Development guidance remains selectable. Stored optional profile
selections and conversation snapshots keep their existing semantics. Older Core responses without
platform metadata retain Harness's existing environment preamble; they do not supply this package.
Other clients keep explicit selection unless they opt into platform context. External MCP alone
does not install filesystem packages; local clients can use `hosty skills export`.

Skills confer no tool permissions, filesystem grants, lifecycle authority or publication approval.
The introduction distinguishes Core, applications and clients; a source workspace, an agent worker
and a child sandbox have different ownership and authority. The app-development package routes
version-specific details to the running Core development guide and works after standalone export.

## Packaging And Compatibility

Core stable IDs depend on the `core` source and package name, not the release version. Catalog reads
overlay packaged content on the mutable library. Persisted library state excludes Core bytes;
startup reconstructs registered exports from the running executable, including after rollback.
The two built-ins do not consume the 200-package/64-MiB managed-library allowance. Exports and
Harness selections accept the full managed library plus both Core IDs.

New imports and app packages cannot take either reserved native name. Pre-existing same-name
packages and their IDs survive an upgrade. A selection containing both a legacy package and its
Core counterpart fails with `skill_name_conflict` before replacing the previous export. Startup
and independent selections remain usable. Updating or deleting a Core entry fails with
`skill_core_managed`. Already loaded native conversation history retains its existing limitations:
changing exported files cannot retract text previously read by the model.

Core/CLI version: **0.160.2 → 0.161.0**. Harness version: **0.74.10 → 0.75.0**. Deploy Core before
Harness. SDK packages and Shell require no version change for this feature.

## Verification Evidence

Verified on macOS on 2026-10-28:

- `dotnet build` for Core and CLI passes. Core reports four existing compiler/platform warnings;
  CLI reports none. The final affected Core suite passes 46 tests using
  `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --filter 'FullyQualifiedName~AgentSkill|FullyQualifiedName~AgentMcpDirectory'`.
  It covers an empty registry, an unrelated service consumer, immutability, capacity, collisions,
  exports and recovery. `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj`
  passes all 334 tests.
- `npm run core:aot` publishes and smoke-starts the osx-arm64 NativeAOT artifact with no new
  trimming/AOT warnings. Readiness takes 1.043 seconds in this run.
- `npm run harness:lint`, `npm run harness:build-web` and `npm run harness:test` pass; the full
  suite runs 1,806 tests in 166 files. After the capacity edge-case change, lint and the static build
  pass again, and `npx vitest run apps/harness/src/skills.test.ts apps/harness/src/mcp/session-skills.test.ts`
  passes all 17 tests. Session tests assert introduction delivery and ordering with/without profiles
  in native/Docker modes; component tests verify Core provenance, Read and mandatory/optional selection.
- After integrating the concurrent telemetry-access fix from main, Harness lint and the production
  build pass again, and the complete suite passes 1,808 tests in 166 files. Conflicts involve only
  version metadata; the feature retains Harness 0.75.0 above main's 0.74.10.
- `npm run test:integration -- worker` passes with the manifest-matching Docker worker image.
  Separately, real Codex `skills/list` and Claude's initialization command catalog discover both
  packages from a Core-owned export using fresh native homes. No provider credentials or inference
  are used; this checks discovery, not model judgment or adherence to guidance.
- `npm run test:integration -- harness-local` runs a parent-managed child Core with separate data
  and normal password login. Before installing any app it verifies both packages, version metadata,
  complete exports and platform context. Harness API/worker, launch-code identity, sessions and
  static assets pass. Cold start takes 27.466 seconds; warm restart takes 2.007 seconds and retains
  its generation without installation/build. Missing-output recovery takes 22.304 seconds and
  restores the authenticated API with the same input identity.
- Browser checks through the child Core's advertised URLs verify both Core version labels, package
  reading, the fixed platform checkbox and saving an optional development-skill selection. Shell
  authenticates and embeds the same Harness settings successfully. The browser automation tool
  cannot dispatch clicks or keys into that iframe; those controls are checked on Harness's own
  Core-authenticated page instead. No production instance or provider configuration is changed.
- Native processes and the test export are released. The parent Finishes the child and confirms
  removal of its resources, including the test Shell container. The fixture verifies that its Core,
  helper, Git server, credentials, builds and data are removed and the port is released.
- Both packages pass skill metadata validation and relative-link checks. Version consistency,
  documentation/link validation and whitespace checks pass. Windows execution is not run locally;
  existing cross-platform CI remains responsible for that platform.

## Testing Expectations

- Exercise packaged catalog/read/export on a Core with no installed applications and through an
  unrelated authorized app; preserve ordinary administrator and app-service boundaries.
- Verify stable IDs, running-version provenance, independent read/export selection, optional context,
  protected lifecycle, reserved names, legacy collisions, full capacity and recovery after upgrades.
- Validate complete portable packages, metadata and relative references; publish/smoke-test the
  native Core artifact so embedded resources survive release packaging.
- Assert prompt delivery before operator/role text, profile/no-profile and native/Docker starts,
  older-Core fallback, invalid-context rejection and optional-selection preservation.
- Test catalog provenance and reading, mandatory platform display and optional development selection.
  Build the UI before the full Harness suite and exercise normal Core login and Shell embedding.
- Use owned test instances and fresh native homes; stop consumers before releasing exports/leases,
  Finish child sandboxes through their parent and verify resource removal.

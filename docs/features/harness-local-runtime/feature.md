---
created: 2026-10-27
updated: 2026-10-27
summary: Harness local production starts reuse isolated compiled API and worker bundles with a static UI and locked runtime dependencies.
components: [apps/harness]
---

# Harness Local Production Runtime

## Preparation And Start

Harness's reviewed `local` profile uses the existing Core source/setup lifecycle. The worker's
setup invokes `node scripts/local-runtime.mjs prepare`; worker and API commands invoke the same
launcher with `start worker` and `start api`. The API retains its declared dependency on worker.
Node.js 24 or newer is required; a cold preparation also needs npm and access to its locked packages.

Preparation takes an isolated snapshot of Harness backend/UI sources, shared web assets, the app
SDK, build scripts, configuration, manifest and root npm package/lock. SHA-256 covers their sorted
paths and bytes together with the Node version, operating system and architecture. Test files are
excluded. An unchanged complete generation skips npm and all compilation. Updated inputs or missing,
truncated or broken-link output require a new successful preparation.

The production generation contains:

- Compiled `api.mjs` and `worker.mjs`, including the used TypeScript SDK implementation.
- The Next static export in `web`, served by the API process.
- Standalone runtime dependencies installed with `npm ci` from the reviewed lock's resolved
  versions and integrity records, including the pinned Claude SDK and Codex executable packages.

The standalone package excludes workspace links, Next, React, TypeScript and `tsx`. The launcher
imports compiled JavaScript in its own Node process and sets `NODE_ENV=production` and the
generation's absolute static-export path. Core still injects identity, assigned ports, service URLs,
managed-workspace/skill mounts and app-owned storage. Provider connections and user data keep their
existing app data locations.

## Isolation And Recovery

Generations live under ignored `apps/harness/.local-runtime/<input-hash>` in the selected source
checkout. Git and Docker build contexts exclude this directory. Builds use unique staging directories there, never the checkout's root `node_modules`
or another app's dependency tree. The build environment excludes application credentials, settings,
Node loader options and static-output overrides.

An atomic directory lock serializes preparers. A recorded exited process permits abandoned-lock
recovery; a live process is waited for with a bounded timeout. Recovery removes only the exited
owner's unique marker and an empty directory, so interruption or concurrent recovery cannot
strand a recovery claim or delete a replacement owner's lock. A complete output inventory is
published with the generation only after build success and input revalidation. Missing output
cannot be concealed by a stale success marker. Failed builds leave prior successful generations
intact; an incomplete generation is retained under a unique name before its replacement is
published. Generations and interrupted staging remain derived local output, outside app data and
backups; no running generation is automatically deleted.

The lifecycle checks its source inputs and output inventory on warm starts; it does not run npm,
a compiler, a Next server or a TypeScript loader. Clearing the derived output costs a cold
preparation. Explicit preparation is also available from the repository root:

`npm run build:local --workspace @haas/hosty-harness`

This remains a source-delivered production profile, with one build per input/platform combination.
The platform's immutable folder-delivery contract is separate; remote prebuilt distribution belongs
to [Runtime Artifact Extensions](../runtime-artifact-model/plan.md). Docker builds its static export
into its image, while `dev` retains its editable source setup/watch recipe.

## Verified Acceptance

On 2026-10-27, the managed child-Core suite passed on macOS arm64 with Node 24.18.0 and npm 11.16.0.
With no app generation and an already populated host npm cache, first app start took 28.556 seconds;
warm restart took 1.961 seconds without installation or compilation. Missing static-output recovery
took 23.248 seconds. These include Core lifecycle/readiness and do not measure empty npm-cache
downloads or startup of the test Core itself. Normal password/launch-code authentication, static
assets, contained provider dependencies, fresh process identity and Finish cleanup passed.
Windows and Linux lifecycle acceptance and paid provider turns were not run.

## Testing Expectations

- Verify complete unchanged reuse without invoking the builder; source/Node/platform invalidation;
  failed preparation; concurrent preparation; exited-owner and interrupted-recovery cleanup;
  missing/truncated output; and removed dependency links.
- Check standalone lock derivation preserves reviewed dependency entries and excludes SDK peers,
  workspace links and the TS loader. Build production output and run Harness lint/unit tests.
- Run `npm run test:integration -- harness-local` on the target platform. It builds Core/CLI and uses
  an isolated parent-managed child Core with separate data and a normal password-authenticated user.
  Verify the compiled API/worker, Core launch-code identity, sessions API, static assets, contained
  provider dependencies, fresh process identity on restart, unchanged generation, missing-output
  recovery, and owner-driven Finish/resource removal. No paid model request or real provider
  credential is required.
- Record cold preparation/start separately from warm restart; report platform and untested platforms.
  Do not use standalone server probes as evidence for Core identity or managed lifecycle.

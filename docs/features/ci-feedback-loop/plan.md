---
status: On Hold
created: 2026-11-12
updated: 2026-11-13
summary: Adopt Nx task caching backed by GitHub Actions while preserving exact-source CI gates and independent release verification.
components: [.github, scripts, apps, packages]
---

# Nx CI Acceleration

## Goal And Owner Direction

Reduce repeated CI work and the time from a main push to a complete published release.
The owner selected Nx for the first investigation on 2026-11-12 and prefers cache storage on
GitHub without Nx Cloud. This Draft defines the proposed first implementation; selecting the
tool is not approval to implement an unreviewed plan. On the same date the owner prioritizes
planning/extracting independent Local agent-provider applications first. Keep Nx as the next
separate initiative and remeasure the release baseline after that runtime change.

Owner decision, 2026-11-13: defer Nx and its remote-cache implementation. Complete the existing
provider extraction, remove redundant CI installations/tests and simplify production packaging
first. This plan remains on hold; no Nx dependency, task runner or cache service is introduced.

The existing [CI feedback loop](feature.md) owns component selection and required checks.
The [release model](../repository-release-model/feature.md) owns artifact identities, publication
and feed advancement. Nx executes and caches qualified tasks inside that existing boundary.

Planning baseline: `d42c57de4859d152c636b2c47dd18fd63be43f60`. Use the then-current target when
implementation starts; this commit and its component versions are measurement baselines.

## Observed Baseline

The [2026-11-12 successful release](https://github.com/alex-de-haas/docker-host/actions/runs/43175628852)
takes 24m49s after a 6m41s main CI run, or 31m33s from CI creation to publication completion.
The [worker job](https://github.com/alex-de-haas/docker-host/actions/runs/43175628852/job/131039286846)
takes 21m28s, including a 20m27s Docker build. Its ARM64 Git preparation takes 16m22s versus
2m09s on AMD64. The concurrent API image build takes 11m44s. The critical Harness CI job spends
4m16s in tests, 46s in lint, 39s in its web build and 25s installing dependencies.

These are individual observed runs, not averages or promised speedups. Nx task caching does not
remove Docker's internal toolchain compilation. The owner separately selects extraction into local
agent-provider applications while Harness remains a Docker consumer. The
[Agent Provider plan](../agent-provider-interface/plan.md) owns that runtime/update change.
Retiring the embedded worker build changes the release baseline; do not count its removal as
Nx savings or retain worker-image/toolchain work as hidden Nx deliverables.

The 2026-11-13 extraction worktree already builds each provider in CI for validation, but its
release entries still deliver pinned source commits. The Local setup separately creates a cached
JS/settings bundle on the operator's platform and installs only the selected provider's dependency
closure. This does not compile the vendor engines from Rust/C++; their native executables come
from pinned platform packages. The initial extraction CI repeated a root npm installation and the
common runtime suite in each selected provider job. The subsequent cleanup uses one isolated
workspace projection and runs that suite once before the selected provider checks. D11 of the
extraction records this cleanup and the measured baseline before this Nx plan is implemented.

CI validation output is not yet an installable provider release artifact. Core's current prebuilt
delivery accepts a local folder. Shipping CI-built provider archives would require a reviewed
download/install path, immutable hashes, platform selection and recovery behavior, plus the vendor
runtime dependencies left external by the JS bundler. Do not assume uploading `dist` makes the
installed Local profile consume it, or add that distribution change as an implicit Nx prerequisite.

For the 30 complete UTC days from 2026-10-13 through 2026-11-11, the
[CI run collection](https://api.github.com/repos/alex-de-haas/docker-host/actions/workflows/ci.yml/runs?created=2026-10-13T00%3A00%3A00Z..2026-11-11T23%3A59%3A59Z&per_page=100)
contains 885 distinct runs, including 203 main pushes and 196 successful main pushes.
At the documented 500 credits per connected execution, those successful main runs alone would
use 98,000 credits, above Hobby's 50,000 monthly allowance. This is a hypothetical adoption
estimate, not an Nx invoice; workflows that never invoke Nx need not incur that execution charge.
The GitHub-backed design does not depend on Hobby availability or open-source program acceptance.

## Proposed First Delivery

| Current behavior | Proposed change |
| --- | --- |
| Component jobs invoke npm commands directly | Existing selected jobs invoke explicit Nx targets around those commands |
| Repeated lint/test/build work executes again on fresh runners | Reproducible Node task results are restored through a GitHub-backed Nx remote cache |
| Root npm commands enumerate components sequentially | Compatibility commands dispatch the equivalent Nx task graph with bounded concurrency |
| CI path policy and publication gate authorize exact revisions | Keep the existing policy, selection format and aggregate as the authoritative job contract |
| Native, integration and publication commands perform current checks | Preserve their execution and initially keep them outside Nx result caching |

Cover the fourteen npm workspaces in root `package.json`, including the app SDK, Harness backend
and its separate web project, the shared agent-provider runtime and all three provider applications.
Preserve every existing command's checks and meaningful ordering;
do not manufacture a build target where a source-only package has none. Represent existing
.NET commands only as uncached targets if useful for the root graph. Do not add lockfile,
NativeAOT or SDK-publication migrations to this first delivery.

### Task Graph And Inputs

- Model imported SDK TypeScript and `shared/web` dependencies. The Next apps transpile SDK
  source directly; do not impose a nonexistent SDK `dist` prerequisite on their builds.
- Provider builds also consume the shared theme and fonts. Include these edges in the Nx graph
  and align CI component selection and release input fingerprints in the
  [provider packaging deliverable D11](../agent-provider-interface/plan.md#deliverables).
  Run the common provider-runtime suite once for a source candidate; per-provider targets retain
  their own checks without repeating the same common suite or installing unrelated vendor SDKs.
- Make Harness tests depend on the Harness web build. Declare the actual `out-build`/`out`
  export and configured output path rather than assuming `.next`. Preserve intentional
  `fileParallelism: false` and other fixture-isolation settings.
- Declare outputs for Next standalone/static assets, SDK `dist`, OPUS `dist` and any test reports.
  A cache hit must restore files needed by subsequent tasks, not only replay a successful log.
- Hash relevant project/shared source, scripts, config, package dependency closure, Node/npm,
  OS/architecture and the allowlisted build environment, including configured output paths.
  Start conservatively; narrow an input only with a real mutation/invalidation check.
- Keep generated cache/graph/staging state ignored and outside runtime source, release inputs
  and Core/CLI dirty-provenance detection.
- `Directory.Build.targets` embeds repository, commit, dirty state and project path in native
  assemblies. Do not enable .NET cross-run result caching with source-only inputs. Current
  Core/CLI projects also lack a complete locked NuGet closure.

### GitHub-Backed Remote Cache

Use Nx's supported [self-hosted HTTP contract](https://nx.dev/docs/kb/self-hosted-caching)
through a small repository-owned JavaScript Action. Its loopback adapter runs only during the job
and stores each task archive in GitHub Actions cache using the official `@actions/cache` toolkit.
No persistent server, Nx Cloud account, GitHub Releases mirror or new external storage is needed.
The existing [GitHub-backed adapter](https://github.com/op-nx/github-cache) is a feasibility
reference, not an unreviewed production dependency.

- Use the current HTTP cache API rather than deprecated custom task runners, bucket adapters
  or copying Nx's machine-local database between runners.
- Pin compatible Nx/toolkit versions and action sources. Bind cache keys to repository scope,
  cache format, Nx version and the exact task hash. Validate the exact restored key; accept
  no partial-key fallback as the requested task's result.
- Use stable workspace-relative archive staging paths: GitHub cache versions include archive
  paths and compression. A random absolute path must not make every fresh runner miss.
- Start the adapter in a real JavaScript Action, where GitHub supplies its runtime cache
  credential; a plain shell background process cannot assume those variables are available.
- Bind only loopback with an ephemeral bearer token, bound archive size/concurrency, and stop
  and drain the adapter on completion or cancellation. Keep credentials out of artifacts/logs.
- Main may populate the shared trusted cache. PRs read the accessible main cache; any enabled
  PR writes stay in GitHub's PR merge-ref scope and never seed main. Preserve least-authority
  fork behavior and the existing event/ref/source checks.
- A cache miss, eviction, unavailable backend or declined upload executes the ordinary task
  or leaves its successful result uncached. A cache problem must not turn a failed command into
  a success, retry a failed test or bypass the aggregate. Do not claim this behavior until it is
  exercised against the pinned Nx client's actual HTTP error handling.
- Keep manual/older-source jobs compatible: if their selected checkout predates Nx or the cache
  action, use the existing direct commands. Cache unavailability must not weaken source selection.

### CI And Release Contracts

Keep `ci-policy.mjs` and `ci-select.mjs` as the sole affected-job policy in this delivery.
Nx runs inside selected jobs; it does not supply a second competing authorization decision.
Retain job IDs, `ci-required`, selection format 1 and the required-result checks for failures,
missing jobs, cancellation and unexpected skips. Preserve exact PR merge/main/manual checkout
semantics and the distinction between tested source and the gate implementation revision.

CI policy/docs/version/workflow checks, NativeAOT cold compilation and runtime smoke checks,
Swift/Cardputer, real-provider/model checks, managed sandbox integration, lifecycle operations,
release preparation, publication, signing and feed promotion stay uncached. The heavyweight
`tasks` integration suite remains explicitly opt-in under repository policy.

Adding root Nx tooling currently changes the dependency projection used by release contexts.
Verify that tooling is excluded from runtime dependency installation and avoid unrelated image
input churn. Any projector adjustment must preserve exact lock/integrity/context semantics;
do not weaken release fingerprints or attestations to improve a cache-hit statistic.
An Nx hit does not authorize a release or replace signed original build receipts.

## Deliverables

- [ ] D1. Pin Nx and define the complete first-delivery npm task graph, dependencies and compatibility entry points; preserve existing checks and bounded concurrency.
- [ ] D2. Declare audited task inputs and complete outputs; prove restoration and invalidation for SDK, shared sources, Harness web exports, environment/config and dependency changes.
- [ ] D3. Keep Nx/cache state and CI-only tooling outside runtime artifacts and native provenance; verify projected dependency/context behavior without weakening integrity checks.
- [ ] D4. Implement the GitHub Actions-backed HTTP cache action with exact-key restoration, scoped access, lifecycle cleanup and tested miss/outage behavior; demonstrate producer and consumer on separate fresh runners.
- [ ] D5. Wire Nx into existing selected component jobs and root commands while preserving selection/aggregate/publication contracts and older-source/manual compatibility.
- [ ] D6. Pass cache, workflow and gate regression checks and record comparable cold/warm CI measurements, cache transfer overhead and task execution counts without claiming Docker or queue savings as Nx savings.
- [ ] D7. Update current-behavior documentation and contributor commands, record the version outcome, regenerate the index and delete this plan after all acceptance passes.

## Verification And Acceptance

1. Run affected Node suites/builds, CI selection/workflow/publication tests and workflow lint.
   A docs-only planning revision runs documentation/link and whitespace validation only.
2. Run each cacheable target cold and warm. Delete its outputs before the warm run and verify
   restored files/reports and downstream execution, including Harness's served web export.
3. Change project source, tests, SDK/shared inputs, dependency lock/config and build environment
   independently. Require the correct misses; an unrelated file must retain a justified hit.
4. Verify an ordinary failed target stays failed, and missing/corrupt/evicted/unavailable cache
   behaves as a rebuild or explicit rejected cache result without claiming a successful task.
5. On separate fresh GitHub runners, produce and restore a real task archive with empty local Nx
   state. Record remote hits, bytes and transfer time. Test cancellation and read-only operation.
6. Exercise PR/main isolation, unknown paths, renamed/deleted inputs, manual source selection,
   delayed exact-attempt required-job evidence and denied failed/cancelled publication paths.
7. Compare the same task/source/environment on a cold cache and a seeded cache, then perform
   representative app-only, SDK/shared-input and docs-only selections. Separate elapsed critical
   path from summed machine time and runner wait. Retain hosted links and sanitized summaries;
   do not commit raw evidence or credentials. Local hits alone do not prove CI/CD acceleration.
8. Update [feature.md](feature.md) and linked release docs only when the behavior ships. This
   planning revision has no version bump. CI/build tooling changes have no independent runtime
   artifact version; bump a runtime/SDK only if its shipped contents or behavior change.

All deliverables belong to one feature branch and one implementation PR. Publication/merge,
paid services, ordinary-runtime changes and workspace deletion require their existing authority;
this plan does not create it.

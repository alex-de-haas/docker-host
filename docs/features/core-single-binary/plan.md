# Core Single Binary — One Executable For Server And Terminal

Status: On Hold
Created: 2026-09-01
Updated: 2026-09-01

Parked by owner decision (2026-09-01): the question deserves its own working session, with the
trade-offs weighed before any commitment. Recorded here so it is not lost.

## Goal

Decide whether the CLI and Core merge into a single executable — the ollama shape: one binary where
`hosty serve` runs the server and every other subcommand is a thin HTTP client of a running
instance — or stay two artifacts with the same client/server contract.

## What Is Already True (facts for)

- Core and the CLI already share one version in `Directory.Build.props` — by versioning they are
  one product; two binaries is packaging.
- The Windows-safe executable swap already exists: `SelfUpdateService.ReplaceExecutable`
  (move-aside → move-in → rollback). A merged binary updates itself exactly the way the CLI does
  today.
- `CoreInstallationService` — the CLI knowing where to download Core and where to put it — folds
  into self-update and disappears as a concept.
- The `HOSTY_CLI_PATH` round-trip (Core asking the CLI to restart it for the Shell platform panel)
  becomes a self-exec.
- Prior art: ollama is one Go binary (server plus client subcommands, `OLLAMA_HOST` rendezvous);
  docker is the opposite (dockerd + docker over a socket). Both delegate supervision to the OS.

## Costs (facts against)

- Every terminal command carries the full ASP.NET Core AOT server binary — size and cold start for
  a `hosty apps list`.
- Release artifacts, the install layout and the update flow all rework.
- Correlated breakage: a broken server build takes the terminal client with it. An agent building
  Core from source still has the installed binary for talking to the real host, but the coupling is
  real.

## Open Questions

1. Is the client-side weight acceptable, or does a merged world still want a second thin client
   artifact — at which point what was merged?
2. What do release artifacts and the install/update layout look like after a merge?
3. Sequencing: does this wait for
   [core-runtime-parameters](../core-runtime-parameters/feature.md) to land? (It should — that plan
   settles the addressing model the subcommands would use.)

## Deliverables

- [ ] The worked decision, with the analysis recorded. On "merge", this plan gains the
      implementation deliverables and a status change; on "stay split", this plan is deleted and
      the reasoning lands in the relevant `feature.md`.

## Links

- [core-runtime-parameters](../core-runtime-parameters/feature.md) — the plan this question was split
  out of.

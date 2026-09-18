# Core Development Mode — Remaining Acceptance Checks

Status: In Progress
Created: 2026-07-12
Updated: 2026-09-18

## Approved Scope

The owner approved implementation on 2026-09-18. The CLI, Core API/MCP, independent local
service runner, Shell controls, Gateway recovery, agent instructions and version changes are
implemented. Their current contracts and local verification are documented
in [Core development mode](feature.md). There are no remaining product decisions.

This plan remains open for the acceptance checks below; implementation is not described as fully
accepted across all platforms or real AI harnesses based solely on the local macOS checks.

## Remaining Deliverables

- [ ] Run the complete source build/restart/retention and local-service adoption scenario on Windows,
      including locked executable output, runner-owned Job Object survival, explicit process-tree
      Stop after adoption and cleanup of locked generations. Run the full CLI/Shell end-to-end
      scenario on Linux too. Linux ARM64 Core process/auth tests (69) and the full CLI suite (221)
      already pass in the official SDK container; the full interactive Linux scenario has not run.
- [ ] Run an actual provider-backed active agent turn through Core-managed AI Gateway in both local
      and dev profiles. Have the agent request restart through its authorized CLI or direct Core MCP
      route and verify continuation, token recovery, SSE resync and a new Core identity without another
      user message or duplicate mutation. Real Core-managed Gateway processes with the fake harness
      pass local continuity checks; that does not verify Claude/Codex provider-backed subprocesses.
- [ ] After these checks pass, record the results in `feature.md`, remove this remaining plan, and
      regenerate the documentation index. Keep all implementation and acceptance work in the same
      feature PR.

## Verification Procedure

Use an isolated data root, ports, test accounts and credentials. Never restart a live user session
for acceptance testing. Follow the Core development feedback loop in `AGENTS.md`. Verify PID plus
process start time, source/generation identity, unchanged app ports and continuing stdout/stderr;
HTTP readiness alone is insufficient. Include a deliberate compiler failure before Stop and a
startup failure after a successful build. A failed candidate must not cause an automatic fallback.

Run the relevant Core/CLI suites and `npm run core:aot`, plus Shell and Gateway lint/tests/builds.
Check `node scripts/check-versions.mjs` and `node scripts/docs-index.mjs --check`. Record actual
commands and outcomes, including unavailable platform/provider checks rather than marking them
passed from static inspection.

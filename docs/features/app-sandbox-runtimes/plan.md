# App Sandbox Runtimes And Agent Testing

Status: Draft
Created: 2026-09-25
Updated: 2026-09-25

## Goal And Scope

Assess and design disposable app environments for development and agent testing without using
production data. An operator or assistant can launch a recorded source revision or session worktree,
create synthetic data, exercise the real UI and retain evidence. Later, bounded exploratory agents
can submit observations through the shared feedback inbox and compare candidate implementations.
This is a feasibility proposal, not an approved implementation plan or an existing isolation guarantee.

This feature owns sandbox runtime instances, test data, browser execution and synthetic evaluations.
[Assistant development sessions](../assistant-development-sessions/plan.md) owns worktrees,
conversation, feedback intake, timeline and publication. [AI agent bridge](../ai-agent-bridge/plan.md)
owns non-interactive source jobs that may consume these environments. Existing
[development controls](../app-development-controls/plan.md) continue to own installed-app lifecycle.
[Assistant approval rules](../assistant-approval-rules/plan.md) owns agent tool authority; this feature
must close the additional boundary created when an agent's changed app code executes.

## Feasibility Against The Current Implementation

- Core already passes source, data and cache paths in `RuntimeLifecycleContext`. Docker source
  profiles and mixed service graphs provide reusable building blocks; see
  [mixed development runtimes](../mixed-development-runtimes/feature.md).
- `CoreLifecycleService.CreateRuntimeContextAsync` derives data/cache and dependency URLs from the
  installed app. `GetAppDataPath` selects `apps/<appId>/data`. Changing worktrees does not isolate data.
- Docker resource names include Core instance, app and service identity, but no sandbox identity.
  Concurrent copies therefore need resource ownership and routing changes, not just another folder.
- `LocalCommandRuntimeAdapter` starts ordinary host processes, inherits a host environment and
  injects app settings/mount paths. A new data environment variable is not an OS security boundary.
- Existing development Docker profiles do not by themselves promise production isolation:
  authorized mounts, dependency endpoints, credentials and networking still need separate policy.

Separate test data is a tractable extension. Concurrent, integrated sandbox instances require a
substantial Core lifecycle/auth/routing contract. Strong isolation of agent-generated code also
requires an execution backend with independently verified restrictions. Do not estimate the whole
feature as a small source-selector change or implement it by starting another Core on this host.

## Proposed Runtime Contract

Keep app identity, source selection, execution profile and sandbox identity separate. A sandbox is
a runtime resource, not another user-facing development task; it may belong to a session or an
independent test run. Keep the production installation running and unchanged.

Each sandbox records its owner, app(s), session/workspace references, source snapshot, reviewed
runtime contract, generation, data seed, service graph, credentials scope and observed state.
Give it separate data, cache, temporary files, logs, process/container names, ports, network and UI
origin. Route app discovery and dependencies within that sandbox. Missing sandbox dependencies must
fail or use explicit mocks, never silently resolve to production. A multi-app sandbox can contain
Media Server plus its test dependency; a separate test run normally gets a fresh copy of that graph.

Core must enforce sandbox-bound identity and grants across proxy routes, SDK calls, MCP and direct
origins. A production administrator cookie/token must not become the browser runner's identity.
Use synthetic users and roles. Scope credentials and browser storage to the sandbox; revocation and
generation changes invalidate stale handles. Do not obtain isolation by rewriting published app IDs.

Offer empty data and versioned synthetic fixtures first. An optional production-derived seed needs
explicit authorization, a consistent application/database export, redaction and removal of secrets,
jobs, webhooks and external integrations. Copying a live database directory is not a general snapshot
contract. Reset restores the selected seed; stop retains it; dispose removes only owned resources.
No automatic sandbox-data promotion or writeback accompanies a source merge.

## Isolation Boundaries

Expose an honest distinction between separate test data and enforced execution isolation. An
unrestricted local process can ignore its configured data directory. An agent sandbox alone also
does not contain code subsequently launched by Core under Core's account.

For the initial protected mode, investigate an all-container sandbox service graph: non-privileged
execution, bounded resources, reviewed source input and writable scratch, no production mounts,
Core auth folders, host networking or Docker socket, and controlled outbound connections. Merely
using a separate Docker bridge does not deny traffic to production or the internet. Enforce network
policy for app services, agent tools and browser execution, including access back to Core. Provide
test sinks/mocks for email, payments and other outgoing effects. Keep builds/setup commands inside
the reviewed execution boundary too; arbitrary build requests are not an unrestricted Docker API.

Reject unsupported local-command services, privileged/device workloads and unresolved external
dependencies in protected mode. A weaker data-only mode, if offered, must be labeled and must not
claim the same guarantees. Evaluate a separate VM/worker for workloads that require a stronger
boundary; Docker configuration alone is not a universal guarantee against hostile code.

An unrestricted external Codex process remains outside this boundary. Skills may direct it to
registered worktrees and sandbox tools, but cannot revoke its existing host access. Internal agents
need enforced filesystem/tool authority as well as isolated app execution.

## Browser Testing And Product Exploration

Provide a host-managed browser runner, potentially Playwright, bound to the sandbox origin and a
synthetic identity. It can click, type, upload fixtures and inspect rendered outcomes, with screenshots,
console/network evidence and traces. Browser-context isolation covers cookies/storage; backend data
and service isolation remain Core's responsibility. Verify Hosty embedding/auth through Core/Shell,
not only a standalone app URL. Run this remotely on the host/worker; mobile clients inspect results.

Start with repeatable user scenarios and explicit expected state, then allow bounded exploratory
runs such as “create a library and play a sample item.” Retain failures and reproduction steps, not
just the agent's claim of success. Record source state including uncommitted changes; freeze input
for reproducible runs or invalidate evidence if it changes. Fixtures must be resettable.

Later, let several agents explore independently with specified goals, roles and budgets. Use separate
seeded sandbox instances by default; share one deliberately only for multi-user/concurrency tests.
Attach observations to the existing feedback inbox with synthetic-agent attribution, app/page,
source revision, model/instructions, reproduction steps and evidence. Another agent may reproduce,
deduplicate and assess observations; administrator triage remains authoritative and no automatic
merge or instruction rewriting follows from an evaluator's opinion.

Variant comparison uses equivalent fixtures/tasks, recorded models/tools/settings, repeated runs
and balanced order without exposing previous judgments. Measure observable completion, errors,
steps, latency and cost separately from subjective critiques. Similar agents can have correlated
biases: report results as synthetic evaluations and hypotheses for human validation, not human
preference, conversion or a substitute for real-user A/B testing.

## Client And Tool Boundary

Core owns provision/start/stop/reset/dispose and resource authorization. Hosty MCP tools can expose
these operations to agents using opaque sandbox IDs, with scoped browser tools for testing. UI and
CLI use the same underlying services. AHP can carry session activity/results and client interaction;
it does not supply OS containment or standardize Hosty's sandbox lifecycle. Exact tool names and
payloads remain open. Status and artifacts link into the session timeline and feedback evidence.

## Deliverables And Suggested Phases

All phases below are unapproved. Start with one representative container-compatible app and one
repeatable scenario before generalizing or scheduling multiple evaluators.

- [ ] Phase 1: specify runtime-instance identity, ownership, routing, scoped auth and dependency
  resolution; prove compatibility with the single-Core model and existing app lifecycle.
- [ ] Phase 1: choose supported execution backends/platforms and isolation guarantees; verify mounts,
  inherited environment, builds, egress and Core access against those guarantees.
- [ ] Phase 2: implement sandbox creation, readiness, stop/reset/dispose, synthetic seeds, separate
  resource names and bounded resource usage without changing the production installation.
- [ ] Phase 2: expose authorized Core APIs/MCP and manual UI controls; bind sessions/worktrees and
  show actual running revision, data mode, isolation level and cleanup blockers.
- [ ] Phase 2: define optional sanitized snapshot import, consistency and retention before enabling it.
- [ ] Phase 3: integrate a scoped browser runner, test identities, repeatable scenarios, evidence
  artifacts and truthful pass/fail/unknown outcomes in the session timeline.
- [ ] Phase 4: implement bounded exploratory jobs and synthetic feedback submissions through the
  existing inbox, with independent reproduction/triage and resource/cost limits.
- [ ] Phase 4: implement controlled multi-agent and variant comparisons with provenance, repeated
  measurements and explicit limits on interpreting synthetic feedback.
- [ ] Verify the acceptance cases below, document shipped guarantees in `feature.md`, and reconcile
  dependent plans without broadening previously granted agent authority.

## Open Questions

- Which app and platforms form the first supported slice? Can all its services run in containers,
  and which real dependencies need test doubles or additional sandbox instances?
- Is a clearly labeled data-only local mode useful, or should agent testing require protected mode?
- Which Core/SDK identity and discovery changes are necessary to distinguish runtime instances
  while preserving app identity and preventing cross-instance calls?
- How are package/build downloads allowed without granting general production/network access?
- What seed format, disk/CPU/memory limits, artifact retention and abandoned-run policy are suitable?
- Which tests cover the app alone versus Shell integration? Core/Harness self-testing requires a
  separate approved environment design and must not restart the active controller implicitly.
- What human-validated tasks and rubric make synthetic variant comparisons useful enough to keep?

## Verification Before Shipping

Test production plus two sandbox copies of the same app: write/reset/dispose in one must not affect
the others. Attempt cross-instance token reuse, direct-origin access, production dependency fallback,
mount/path escapes and external side effects. Test failures during startup and cleanup, stale IDs,
Core restart/adoption, resource exhaustion and retention of active worktree consumers. Show observed
denial at the execution boundary, not only an agent refusing in text.

Verify browser scenarios through Core-managed identity, inspect resulting backend state and replay
failure evidence. Bind results to exact source/fixture revisions, preserve unknown/interrupted states,
and demonstrate independent seeded evaluation runs. This Draft records an inspection-based assessment;
no sandbox runtime, browser test or isolation test has been implemented or executed for this document.

## References

- [Docker Engine security](https://docs.docker.com/engine/security/): namespaces, resource controls
  and the authority exposed through daemon access and mounts.
- [Playwright isolation](https://playwright.dev/docs/browser-contexts): separate browser contexts.
- [Playwright traces](https://playwright.dev/docs/trace-viewer): browser execution evidence.

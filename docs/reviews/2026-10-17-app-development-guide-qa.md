# App Development Guide QA — 2026-10-17

## Baseline And Scope

This report records D6 of [Local App Creation From Harness](../features/app-prototype-workspaces/feature.md)
at base `34ea0bd2d5bfee6e12ac9d53f151ad61368babe7` plus the accumulated uncommitted feature worktree.
Core/CLI identify as 0.140.0; Harness identifies as 0.57.0. These are the already reserved feature
versions, not published releases. This task creates no feature commit or PR.

The packaged guide now has eight topics: overview, source, docker, identity, sdk, preview, checks,
finish. Every response identifies Core version, manifest schema `app.0.1`, selected topic, complete
index and SHA-256 content revision. The verified revision is
`e80bccdcb1be0d7064218f694f557dbcd995e84bc9bab658c2d2d23825038d17`.
Topics range from 1,297 to 4,619 UTF-8 bytes, below the 16,000-byte per-topic budget. JSON serialization
of every topic is checked with the same source-generated context as Core HTTP/MCP responses.

## Changes And Findings

- The old monolithic Harness guide lacked direct Core MCP/control/CLI readers and metadata. All
  four surfaces now use one packaged reader; no filesystem path or all-topics expansion is accepted.
- Harness previously had no topic selection. The session route now forwards a bounded string,
  preserves Core's error code/status and marks the MCP tool read-only. Instructions request topics
  on demand rather than embedding the guide. Disabled/refused MCP does not authorize a CLI bypass.
- The guide distinguishes Next-only TypeScript server helpers, the framework-neutral adapter that
  formats an already validated session, and .NET's authentication/client capabilities without a
  browser bridge or code-exchange helper. Other stacks receive concrete PKCE/browser-initiation,
  service-authenticated token exchange and revalidation examples, including recovery states.
- Workspace/Git, remote publication, separate Docker source/cache/data, multiple services, child
  users, reviewed installation, preview reuse, checks, restart and interrupted Finish are covered.
- CLI text uses the raw writer so terminal width and markup do not corrupt Markdown/code examples.
  JSON preserves metadata. Invalid arguments do not start Core or invoke a broader fallback.

## Verification

Commands ran in the registered feature worktree:

- `dotnet test apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj --no-restore --filter
  "FullyQualifiedName~AppDevelopmentGuide|FullyQualifiedName~McpHttpTests|FullyQualifiedName~AssistantMcpAccessHttpTests|FullyQualifiedName~AppCreationHttpTests"`
  — 54 passed. Covers packaged bounds/serialization, actual Core MCP discovery/calls, control and
  assistant authority, unknown/traversal topics, permission revocation and no app allocation.
- `dotnet test apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj --no-restore --filter
  "FullyQualifiedName~AppsCommandTests|FullyQualifiedName~CoreControlClientTests"` — 36 passed.
  Covers text/JSON, narrow terminal width, default topic, malformed options and control transport.
- `npm test --workspace @haas/hosty-harness -- src/sessions/development.test.ts
  src/sessions/development-manager.test.ts src/mcp/policy.test.ts src/mcp/auto-allow.test.ts`
  — 67 passed. Includes the authenticated local MCP wire, topic dispatch, read-only discovery,
  current session ownership and existing confirmation policies.
- `npm run lint --workspace @haas/hosty-harness` — passed.
- Core and CLI built successfully through the test commands. The explicit source launch also built
  the exact Core project into its own managed generation before starting it. Existing Core warnings
  concern unread constructor parameters and platform annotations; no new guide warning appeared.
- `node scripts/docs-index.mjs --fix`, `--check`, `node scripts/check-versions.mjs` and
  `git diff --check` — passed after the documentation update.

The complete repository suite, native AOT release publication and both real model-provider runs
were not repeated for this read-only guide change; final cross-component verification remains D17.
The Harness web UI is unchanged in this task, so its production bundle was not rebuilt.

## Live Acceptance

An independent Core was launched from this exact worktree with data root
`/private/tmp/hosty-guide-d6-20261017/parent` and port 29360. Its factual dev launch was verified;
the process ran its managed Debug generation. A synthetic user was created through normal Core setup,
then authenticated through ordinary password login. No parent user, connection or credential was copied.

Core installed and started the real Harness source with its standard required permissions only.
The initial test manifest incorrectly placed an absolute working directory outside its runtime root;
Core refused it. The fixture was corrected to the standard Git source binding and source override,
with `apps/harness` relative to that source. No product boundary was relaxed.

Harness's normal app-code exchange established its own app grant. A fresh provider-free conversation
retrieved all eight topics through its session/workspaces API. Every full response matched Core
control byte-for-byte after parsing, including revision and metadata. Invalid topic paths and
non-string topics failed with `development_guide_topic_invalid`. CLI `apps guide --topic sdk
--format json` matched the same control response. Direct Core MCP initialize/list/call returned
all eight identical topics and advertised `readOnlyHint: true`.

The browser independently completed ordinary Core login and opened that same Harness conversation.
It displayed the idle session without a workspace or provider; no agent turn was dispatched.
The MCP wire was also verified in automated Harness tests. This is instruction-delivery acceptance,
not a claim that a real model interpreted or followed the guide.

## Cleanup

Harness was stopped through the test Core, then that Core was stopped through CLI. Both ports
(29360 and 24581) were closed and no process referenced the test root. The entire disposable root
was removed, including the synthetic user/password, sessions, app grants, control secret, app data,
caches, managed build generation and local request results. The test browser tab was closed.
Current host applications, Docker containers, memory limits and caches were not changed.

Raw request/response JSON and logs are not repository artifacts. Only this report and the maintained
feature/plan/command documentation record the result. D6 is complete; D11, D17 and D18 remain open.
